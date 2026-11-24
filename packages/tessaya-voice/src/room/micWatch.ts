/**
 * A Tessel that opens wake segments but sends silence or hiss has a deaf mic path that no reboot-free check on the
 * Tessel sees: it still delivers frames. After `runs` such segments in a row the loop logs a fault once and asks the
 * Tessel to rebuild its wake listening (`cmd/voice/wake/restart`, firmware 0.3.179+; older firmware ignores it).
 * @module baton-voice/room/micWatch
 */
import type { WakeCapture } from "./wakeCapture.ts";

// 3,601 live segments, 20-24 Nov: peak never under 219, RMS never under 27, first-difference ratio at most 1.95
// (99th percentile 0.75). White hiss reads ~2.0, and a segment opens only on frames over RMS 64.
const SILENT_PEAK = 150;
const SILENT_RMS = 15;
const HISS_RATIO = 1.3;

/** Why a segment's audio cannot be a voice the Tessel heard, or null when it can. */
export const segmentAudioFault = (pcm: Int16Array): "silent" | "hiss" | null => {
  if (pcm.length < 2) return "silent";
  let mean = 0;
  for (const s of pcm) mean += s;
  mean /= pcm.length;
  let energy = 0;
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]! - mean;
    energy += x * x;
    if (Math.abs(x) > peak) peak = Math.abs(x);
    if (i > 0) {
      const d = pcm[i]! - pcm[i - 1]!;
      diff += d * d;
    }
  }
  if (peak < SILENT_PEAK || Math.sqrt(energy / pcm.length) < SILENT_RMS) return "silent";
  return diff / (pcm.length - 1) / (energy / pcm.length) > HISS_RATIO ? "hiss" : null;
};

export const createMicWatch = (opts: {
  /** Bad segments in a row that make a fault. */
  readonly runs?: number;
  readonly restart: (id: string) => void;
  readonly log: (line: string) => void;
}): WakeCapture => {
  const runs = opts.runs ?? 6;
  const bad = new Map<string, number>();
  return {
    segment: (id, _seg, pcm) => {
      const fault = segmentAudioFault(pcm);
      if (fault === null) {
        if ((bad.get(id) ?? 0) >= runs)
          opts.log(`[${id}] mic: voice again after a ${bad.get(id)}-segment fault`);
        bad.delete(id);
        return;
      }
      const n = (bad.get(id) ?? 0) + 1;
      bad.set(id, n);
      // Once per streak: a restart that did not help is not repeated every segment.
      if (n !== runs) return;
      opts.log(
        `[${id}] mic fault: ${n} wake segments in a row were ${fault}; asking the Tessel to restart its listening`,
      );
      opts.restart(id);
    },
    kws: () => undefined,
    session: () => undefined,
  };
};
