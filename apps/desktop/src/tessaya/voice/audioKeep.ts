// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * His voice, kept only when he has said so: dictation and spoken turns, never always-on listening.
 * Clips are Opus in a WebM container, one file each. After `days` they are deleted, except clips he
 * corrected (they teach most), which stay up to a size cap, oldest going first when over it. Saving
 * pauses when the drive holding the state dir is nearly full.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { History } from "./history.ts";

export interface KeepSettings {
  readonly enabled: boolean;
  readonly days: number;
  /** Corrected clips are kept up to this many bytes. */
  readonly capBytes: number;
  /** Saving pauses when the drive has less than this free. */
  readonly minFreeBytes: number;
}

export const DEFAULT_KEEP: KeepSettings = {
  enabled: false,
  days: 30,
  capBytes: 2 * 1024 ** 3,
  minFreeBytes: 5 * 1024 ** 3,
};

export interface Clip {
  readonly path: string;
  readonly at: number;
  readonly bytes: number;
  readonly corrected: boolean;
}

const DAY_MS = 86_400_000;

/** Which clips to delete now: uncorrected ones past their days, then corrected ones over the cap, oldest first. */
export const planRetention = (
  clips: ReadonlyArray<Clip>,
  now: number,
  keep: KeepSettings,
): ReadonlyArray<Clip> => {
  const old = clips.filter((clip) => !clip.corrected && now - clip.at > keep.days * DAY_MS);
  const corrected = clips.filter((clip) => clip.corrected).sort((a, b) => a.at - b.at);
  let total = corrected.reduce((sum, clip) => sum + clip.bytes, 0);
  const over: Clip[] = [];
  for (const clip of corrected) {
    if (total <= keep.capBytes) break;
    over.push(clip);
    total -= clip.bytes;
  }
  return [...old, ...over];
};

export type SaveGate = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const saveGate = (keep: KeepSettings, freeBytes: number | null): SaveGate => {
  if (!keep.enabled) return { ok: false, reason: "Saving your voice is off." };
  if (freeBytes !== null && freeBytes < keep.minFreeBytes) {
    return {
      ok: false,
      reason: `Saving paused: the drive has under ${Math.round(keep.minFreeBytes / 1024 ** 3)} GB free.`,
    };
  }
  return { ok: true };
};

export const freeBytesOf = (dir: string): number | null => {
  try {
    const stat = NodeFS.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
};

export const spaceUsed = (dir: string): number => {
  let total = 0;
  const walk = (current: string) => {
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = NodePath.join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        try {
          total += NodeFS.statSync(path).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
};

/** Writes one clip and returns its path, or null (with the reason) when saving is off or paused. */
export const saveClip = (input: {
  readonly dir: string;
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly at: Date;
  readonly keep: KeepSettings;
  readonly freeBytes: number | null;
}): { readonly path: string | null; readonly reason: string | null } => {
  const gate = saveGate(input.keep, input.freeBytes);
  if (!gate.ok) return { path: null, reason: gate.reason };
  const folder = NodePath.join(input.dir, input.at.toISOString().slice(0, 7));
  NodeFS.mkdirSync(folder, { recursive: true });
  const path = NodePath.join(folder, `${input.id}.webm`);
  NodeFS.writeFileSync(path, input.bytes);
  return { path, reason: null };
};

/** A turn's audio is one clip path, or several (a long dictation is kept in chunks) joined by newlines. */
export const clipPaths = (audio: string): ReadonlyArray<string> =>
  audio.split("\n").filter((p) => p.length > 0);

/** On start and daily: deletes what the plan says, and clears the turn's audio link. */
export const runRetention = (input: {
  readonly history: History;
  readonly now: number;
  readonly keep: KeepSettings;
}): number => {
  const turns = new Map<string, ReadonlyArray<string>>();
  const clips: Array<Clip & { readonly id: string }> = [];
  for (const turn of input.history.list({ limit: 1_000_000 })) {
    if (turn.audio === null) continue;
    const paths = clipPaths(turn.audio);
    let bytes = 0;
    for (const path of paths) {
      try {
        bytes += NodeFS.statSync(path).size;
      } catch {}
    }
    if (bytes === 0) {
      input.history.update(turn.id, { audio: null });
      continue;
    }
    turns.set(turn.id, paths);
    clips.push({
      id: turn.id,
      path: turn.id,
      at: Date.parse(turn.at),
      bytes,
      corrected: turn.corrected,
    });
  }
  const doomed = planRetention(clips, input.now, input.keep);
  for (const clip of doomed) {
    for (const path of turns.get((clip as Clip & { readonly id: string }).id) ?? []) {
      try {
        NodeFS.rmSync(path, { force: true });
      } catch {}
    }
    input.history.update((clip as Clip & { readonly id: string }).id, { audio: null });
  }
  return doomed.length;
};
