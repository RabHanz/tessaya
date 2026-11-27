// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Always on, so a missed "Tessaya" can be traced: one JSON line per wake segment, kws verdict and Tessel wake report,
 * with length, RMS, peak and an audio hash, never audio. Two files of half the cap each; a failure never stops the loop.
 * @module baton-voice/room/wakeTrace
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type { Stage2, WakeCapture } from "./wakeCapture.ts";
import type { KwsEvent } from "./wakeStream.ts";
import { createWriteQueue } from "./writeQueue.ts";

export interface WakeTrace extends WakeCapture {
  /** A Tessel's own report on its wake path (`voice/wake/end`, `event/wake/stats`), as it sent it. */
  readonly report: (id: string, topic: string, payload: string) => void;
  /** Resolves once every line so far is written. */
  readonly drained: () => Promise<void>;
}

export const levelsOf = (pcm: Int16Array) => {
  let sum = 0;
  let peak = 0;
  for (const s of pcm) {
    sum += s * s;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  return { rms: pcm.length === 0 ? 0 : Math.round(Math.sqrt(sum / pcm.length)), peak };
};

export const createWakeTrace = (opts: {
  readonly file: string;
  readonly capBytes: number;
  readonly now?: () => number;
  readonly log: (line: string) => void;
}): WakeTrace => {
  const now = opts.now ?? Date.now;
  const half = Math.max(1, Math.floor(opts.capBytes / 2));
  let size = (() => {
    try {
      return NodeFS.statSync(opts.file).size;
    } catch {
      return 0;
    }
  })();
  let failed = false;
  const io = createWriteQueue((e) => {
    // One line per failing streak, not one per segment.
    if (!failed) opts.log(`wake trace: not written (${String(e)})`);
    failed = true;
  });
  const write = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify({ at: new Date(now()).toISOString(), ...record })}\n`;
    const turn = size + line.length > half;
    size = (turn ? 0 : size) + line.length;
    io.run(async () => {
      if (turn) await NodeFSP.rename(opts.file, `${opts.file}.1`);
      await NodeFSP.appendFile(opts.file, line, { mode: 0o600 });
      failed = false;
    });
  };
  return {
    segment: (id, seg, pcm, stage2: Stage2, kws?: KwsEvent) =>
      write({
        k: "seg",
        dev: id,
        seg: seg ?? null,
        s: Math.round((pcm.length / 16_000) * 100) / 100,
        ...levelsOf(pcm),
        sha: NodeCrypto.createHash("sha256")
          .update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
          .digest("hex")
          .slice(0, 16),
        outcome: stage2.outcome,
        woke: stage2.woke,
        best: stage2.best,
        ...(kws === undefined ? {} : { kws }),
      }),
    kws: (id, event) => write({ k: "kws", dev: id, ...event }),
    session: (id) => write({ k: "session", dev: id }),
    report: (id, topic, payload) => {
      const body = (() => {
        try {
          return JSON.parse(payload) as unknown;
        } catch {
          return payload.slice(0, 200);
        }
      })();
      write({
        k: topic,
        dev: id,
        ...(typeof body === "object" && body !== null ? body : { body }),
      });
    },
    drained: io.drained,
  };
};

/** The trace and the opt-in training capture both hear every segment. */
export const bothCaptures = (a: WakeCapture, b: WakeCapture | undefined): WakeCapture =>
  b === undefined
    ? a
    : {
        segment: (...args) => {
          a.segment(...args);
          b.segment(...args);
        },
        kws: (...args) => {
          a.kws(...args);
          b.kws(...args);
        },
        session: (id) => {
          a.session(id);
          b.session(id);
        },
      };
