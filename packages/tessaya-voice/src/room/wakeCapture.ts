// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Keeps every R1 wake segment for wake-model training (the owner's consent, 14 Nov): its 16 kHz PCM and a JSON line with
 * the R1's stage-1 score, stage 2's verdict, and whether a session followed. Private (0700 folder, 0600 files), capped in
 * size with the oldest dropped first, and off unless the host names a folder. A failure here never stops the room loop.
 * @module baton-voice/room/wakeCapture
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { KwsEvent } from "./wakeStream.ts";

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
  readonly now?: () => number;
  readonly log: (line: string) => void;
}): WakeCapture => {
  const now = opts.now ?? Date.now;
  const followMs = opts.followMs ?? 15_000;
  NodeFS.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(opts.dir, 0o700);
  // Names start with the UTC time, so name order is age order.
  const files = new Map<string, number>();
  for (const f of NodeFS.readdirSync(opts.dir).toSorted())
    files.set(f, NodeFS.statSync(NodePath.join(opts.dir, f)).size);
  let total = [...files.values()].reduce((a, b) => a + b, 0);
  const recent = new Map<string, string>();
  const last = new Map<string, { json: string; at: number }>();

  const put = (name: string, data: string | Uint8Array) => {
    NodeFS.writeFileSync(NodePath.join(opts.dir, name), data, { mode: 0o600 });
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
        NodeFS.rmSync(NodePath.join(opts.dir, f), { force: true });
        total -= files.get(f) ?? 0;
        files.delete(f);
      }
    }
  };
  const patch = (json: string, fields: Record<string, unknown>) => {
    if (!files.has(json)) return;
    const record = JSON.parse(NodeFS.readFileSync(NodePath.join(opts.dir, json), "utf8")) as object;
    put(json, JSON.stringify({ ...record, ...fields }));
  };
  const guard = (what: string, run: () => void) => {
    try {
      run();
    } catch (e) {
      opts.log(`wake capture: ${what} failed (${String(e)})`);
    }
  };

  return {
    segment: (id, seg, pcm, stage2, kws) =>
      guard("save", () => {
        if (pcm.length === 0) return;
        const at = now();
        const base = `${new Date(at).toISOString().replace(/[:.]/g, "-")}_${id.replace(/[^\w-]/g, "_")}_${seg ?? "x"}`;
        put(`${base}.pcm`, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        put(
          `${base}.json`,
          JSON.stringify({
            v: 1,
            device: id,
            seg: seg ?? null,
            at: new Date(at).toISOString(),
            rate: 16_000,
            samples: pcm.length,
            stage2,
            kws: kws ?? null,
            session: false,
          }),
        );
        if (seg !== undefined) {
          recent.set(`${id}#${seg}`, `${base}.json`);
          if (recent.size > 64) recent.delete(recent.keys().next().value!);
        }
        last.set(id, { json: `${base}.json`, at });
        rotate();
      }),
    kws: (id, event) =>
      guard("kws", () => {
        const json = typeof event.seg === "number" ? recent.get(`${id}#${event.seg}`) : undefined;
        if (json !== undefined) patch(json, { kws: event });
      }),
    session: (id) =>
      guard("session", () => {
        const l = last.get(id);
        if (l === undefined || now() - l.at > followMs) return;
        last.delete(id);
        patch(l.json, { session: true });
      }),
  };
};
