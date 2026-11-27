import { describe, expect, it } from "vite-plus/test";

import { room, speechLike } from "../echoSim.ts";
import { createEchoCanceller } from "./speexAec.ts";

const toI16 = (f: Float32Array, gain: number) =>
  Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * gain * 32768))));

const convolve = (x: Float32Array, ir: Float32Array) => {
  const out = new Float32Array(x.length);
  for (let k = 0; k < ir.length; k += 1) {
    if (ir[k] === 0) continue;
    for (let i = 0; i + k < x.length; i += 1) out[i + k]! += ir[k]! * x[i]!;
  }
  return out;
};

const rms = (x: Int16Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i += 1) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
};

/** 12 s of her through a room (60 ms past the given alignment, 250 ms tail), his voice over it from 9 to 11 s. */
const scene = () => {
  const her = speechLike(12, 7, 210);
  const echo = convolve(her, room(60, 250, 3));
  const his = speechLike(2, 11, 110);
  const mic = new Float32Array(her.length);
  for (let i = 0; i < mic.length; i += 1) mic[i] = echo[i]! * 0.5;
  for (let i = 0; i < his.length; i += 1) mic[9 * 16_000 + i]! += his[i]! * 0.25;
  return { ref: toI16(her, 1), mic: toI16(mic, 1), his: toI16(his, 0.25) };
};

const run = (mic: Int16Array, ref: Int16Array) => {
  const aec = createEchoCanceller();
  const out = new Int16Array(mic.length);
  for (let at = 0; at + 960 <= mic.length; at += 960)
    out.set(aec.process(mic.subarray(at, at + 960), ref.subarray(at, at + 960)), at);
  return out;
};

describe("speex echo cancelling", () => {
  it("takes her echo away once it has learned the room, and keeps his voice over it", () => {
    const { ref, mic, his } = scene();
    const out = run(mic, ref);
    // Her alone, after 3 s to learn: at least 25 dB less of her.
    const erle =
      20 * Math.log10(rms(mic, 4 * 16_000, 9 * 16_000) / rms(out, 4 * 16_000, 9 * 16_000));
    expect(erle).toBeGreaterThan(25);
    // His voice over her keeps most of its level (within 6 dB).
    const kept = 20 * Math.log10(rms(out, 9 * 16_000, 11 * 16_000) / rms(his, 0, his.length));
    expect(kept).toBeGreaterThan(-6);
  });

  it("leaves the mic exactly as heard when nothing of hers is playing", () => {
    const { his } = scene();
    const out = run(his, new Int16Array(his.length));
    const change =
      20 * Math.log10(rms(out, 8_000, his.length - 8_000) / rms(his, 8_000, his.length - 8_000));
    expect(change).toBe(0);
  });
});
