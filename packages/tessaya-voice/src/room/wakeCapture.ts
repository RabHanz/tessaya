// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Keeps every R1 wake segment for wake-model training (the owner's consent, 14 Nov): its 16 kHz PCM and a JSON line with
 * the R1's stage-1 score, stage 2's verdict, and whether a session followed. Private (0700 folder, 0600 files), capped in
 * size with the oldest dropped first, and off unless the host names a folder. A failure here never stops the room loop.
 * @module baton-voice/room/wakeCapture
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { createWriteQueue } from "./writeQueue.ts";
import { FRAME_SAMPLES, KWS_LATE_MS, type KwsEvent } from "./wakeStream.ts";

export interface Stage2 {
  /** Stage 2's verdict as the log line has it. */
  readonly outcome: string;
  readonly woke: boolean;
  /** Each wake word's best score over the segment. */
  readonly best: Readonly<Record<string, number>>;
}

export interface WakeCapture {
  /** One segment ended. `kws` is the R1's own verdict when it came first. */
  readonly segment: (
    id: string,
    seg: number | undefined,
    pcm: Int16Array,
    stage2: Stage2,
    kws?: KwsEvent,
    /** The frames the Tessel says it sent for this segment (`voice/wake/end`), when it counts them. */
    sent?: number,
  ) => void;
  /** The R1's verdict arriving after the segment ended. */
  readonly kws: (id: string, event: KwsEvent) => void;
  /** A session opened on this R1 (`event/session/start`): marks its last segment if it ended within `followMs`. */
  readonly session: (id: string) => void;
}

export const createWakeCapture = (opts: {
  readonly dir: string;
  readonly capBytes: number;
  readonly followMs?: number;
  /** The test run playing into the room now (playbackWindow.ts), or null when what the Tessel hears is live. */
  readonly playback?: () => string | null;
  readonly now?: () => number;
  readonly log: (line: string) => void;
}): WakeCapture & { readonly drained: () => Promise<void> } => {
  const now = opts.now ?? Date.now;
  const followMs = opts.followMs ?? 15_000;
  NodeFS.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(opts.dir, 0o700);
  // Names start with the UTC time, so name order is age order.
  const files = new Map<string, number>();
  for (const f of NodeFS.readdirSync(opts.dir).toSorted())
    files.set(f, NodeFS.statSync(NodePath.join(opts.dir, f)).size);
  let total = [...files.values()].reduce((a, b) => a + b, 0);
  // The record stays in memory while a late kws verdict or a session may still patch it, so a patch never reads disk.
  type Kept = { json: string; at: number; record: Record<string, unknown> };
  const recent = new Map<string, Kept>();
  const last = new Map<string, Kept>();
  const io = createWriteQueue((e) => opts.log(`wake capture: write failed (${String(e)})`));

  const put = (name: string, data: string | Uint8Array) => {
    io.run(() => NodeFSP.writeFile(NodePath.join(opts.dir, name), data, { mode: 0o600 }));
    total += data.length - (files.get(name) ?? 0);
    // A rewrite keeps its place, so a patched record still goes with its audio.
    files.set(name, data.length);
  };
  const rotate = () => {
    for (const name of files.keys()) {
      if (total <= opts.capBytes) return;
      // A segment's audio and record go together.
      const base = name.replace(/\.[^.]+$/, "");
      for (const f of [`${base}.pcm`, `${base}.json`]) {
        io.run(() => NodeFSP.rm(NodePath.join(opts.dir, f), { force: true }));
        total -= files.get(f) ?? 0;
        files.delete(f);
      }
    }
  };
  const patch = (kept: Kept, fields: Record<string, unknown>) => {
    if (!files.has(kept.json)) return;
    kept.record = { ...kept.record, ...fields };
    put(kept.json, JSON.stringify(kept.record));
  };
  const guard = (what: string, run: () => void) => {
    try {
      run();
    } catch (e) {
      opts.log(`wake capture: ${what} failed (${String(e)})`);
    }
  };

  return {
    segment: (id, seg, pcm, stage2, kws, sent) =>
      guard("save", () => {
        if (pcm.length === 0) return;
        const at = now();
        const run = opts.playback?.() ?? null;
        const base = `${new Date(at).toISOString().replace(/[:.]/g, "-")}_${id.replace(/[^\w-]/g, "_")}_${seg ?? "x"}`;
        // A copy: the write lands later, and the caller owns its buffer.
        put(`${base}.pcm`, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice());
        const record = {
          v: 2,
          device: id,
          // Wake training reads only "live": test playback (speaker, clone, wakeinject) is not his speech.
          source: run === null ? "live" : "playback",
          ...(run === null ? {} : { run }),
          // False when frames were lost on the way: the Tessel's kws score is then for audio this file lacks.
          complete: sent === undefined ? null : pcm.length >= sent * FRAME_SAMPLES,
          seg: seg ?? null,
          at: new Date(at).toISOString(),
          rate: 16_000,
          samples: pcm.length,
          stage2,
          kws: kws ?? null,
          session: false,
        };
        put(`${base}.json`, JSON.stringify(record));
        const kept: Kept = { json: `${base}.json`, at, record };
        if (seg !== undefined) {
          recent.set(`${id}#${seg}`, kept);
          if (recent.size > 64) recent.delete(recent.keys().next().value!);
        }
        last.set(id, kept);
        rotate();
      }),
    kws: (id, event) =>
      guard("kws", () => {
        const r = typeof event.seg === "number" ? recent.get(`${id}#${event.seg}`) : undefined;
        if (r !== undefined && now() - r.at < KWS_LATE_MS) patch(r, { kws: event });
      }),
    session: (id) =>
      guard("session", () => {
        const l = last.get(id);
        if (l === undefined || now() - l.at > followMs) return;
        last.delete(id);
        patch(l, { session: true });
      }),
    drained: io.drained,
  };
};
