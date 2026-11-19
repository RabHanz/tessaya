// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Keeps his own turns' audio for training his Voice ID and personal recogniser (his standing consent, 14 Nov: his
 * voice kept privately and used freely). Only turns Voice ID verified as the owner, and what was said over her
 * playback in his session; never another member's or a guest's. 16 kHz PCM and a JSON line, in a private folder (0700
 * folder, 0600 files), capped in size and age, oldest first. A failure here never stops the room loop.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface TurnCaptureMeta {
  readonly turn: number;
  readonly text: string;
  /** Voice ID's verdict for the turn ("owner", or "unverified" for his words over her in his session). */
  readonly speaker: string;
  readonly score: number | null;
  /** Said over her playback: her voice is in it too (for Voice ID's mixed-audio training). */
  readonly overHer: boolean;
}

export interface TurnCapture {
  readonly turn: (id: string, pcm: Int16Array, meta: TurnCaptureMeta) => void;
}

export const createTurnCapture = (opts: {
  readonly dir: string;
  readonly capBytes: number;
  readonly maxAgeMs: number;
  readonly now?: () => number;
  readonly log: (line: string) => void;
}): TurnCapture => {
  const now = opts.now ?? Date.now;
  NodeFS.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(opts.dir, 0o700);
  // Names start with the UTC time, so name order is age order.
  const files = new Map<string, { size: number; at: number }>();
  for (const f of NodeFS.readdirSync(opts.dir).toSorted()) {
    const st = NodeFS.statSync(NodePath.join(opts.dir, f));
    files.set(f, { size: st.size, at: st.mtimeMs });
  }
  let total = [...files.values()].reduce((a, b) => a + b.size, 0);
  const drop = (name: string) => {
    const base = name.replace(/\.[^.]+$/, "");
    for (const f of [`${base}.pcm`, `${base}.json`]) {
      NodeFS.rmSync(NodePath.join(opts.dir, f), { force: true });
      total -= files.get(f)?.size ?? 0;
      files.delete(f);
    }
  };
  const rotate = () => {
    for (const [name, f] of files) {
      if (total <= opts.capBytes && now() - f.at <= opts.maxAgeMs) return;
      drop(name);
    }
  };
  const put = (name: string, data: string | Uint8Array) => {
    NodeFS.writeFileSync(NodePath.join(opts.dir, name), data, { mode: 0o600 });
    total += data.length;
    files.set(name, { size: data.length, at: now() });
  };
  return {
    turn: (id, pcm, meta) => {
      try {
        if (pcm.length === 0) return;
        const at = new Date(now()).toISOString();
        const base = `${at.replace(/[:.]/g, "-")}_${id.replace(/[^\w-]/g, "_")}_t${meta.turn}`;
        put(`${base}.pcm`, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        put(
          `${base}.json`,
          JSON.stringify({ v: 1, device: id, at, rate: 16_000, samples: pcm.length, ...meta }),
        );
        rotate();
      } catch (e) {
        opts.log(`turn capture: save failed (${String(e)})`);
      }
    },
  };
};
