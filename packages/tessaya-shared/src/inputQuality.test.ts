import { describe, expect, it } from "vite-plus/test";

import {
  createInputBaselines,
  DEFAULT_BASELINE,
  inputLine,
  inputQualityOf,
  measureInput,
} from "./inputQuality.ts";

const RATE = 16_000;
/** A voiced sound: 150 Hz harmonics to 4 kHz falling 6 dB an octave, syllables 4 a second, over faint noise. */
const voice = (seconds: number, level = 3_000, seed = 7) => {
  let s = seed;
  const noise = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31 - 0.5) * 2;
  return Int16Array.from({ length: seconds * RATE }, (_, i) => {
    const t = i / RATE;
    let v = 0;
    for (let h = 1; h * 150 < 4_000; h += 1) v += Math.sin(2 * Math.PI * 150 * h * t) / h;
    return Math.round(level * v * Math.max(0, Math.sin(2 * Math.PI * 2 * t)) + 20 * noise());
  });
};
/** The same through a covered mic: a strong low-pass (four one-pole stages at about 700 Hz). */
const covered = (pcm: Int16Array) => {
  const out = Float64Array.from(pcm);
  for (let k = 0; k < 4; k += 1)
    for (let i = 1; i < out.length; i += 1) out[i] = out[i - 1]! + 0.24 * (out[i]! - out[i - 1]!);
  return Int16Array.from(out, (v) => Math.round(v * 1.6));
};
const verdictOf = (pcm: Int16Array, extra = {}) => {
  const m = measureInput(pcm, extra);
  // His usual is this very voice clean, so only the change is judged.
  return inputQualityOf(m, {
    speechDb: measureInput(voice(3)).speechDb,
    brightDb: measureInput(voice(3)).brightDb,
  });
};

describe("input quality", () => {
  it("names each way his sound can fail, and says nothing when it is good", () => {
    const clean = voice(3);
    const holed = clean.slice();
    holed.fill(0, RATE, RATE + 8_000);
    const loud = Int16Array.from(clean, (v) => Math.max(-32_768, Math.min(32_767, v * 20)));
    const hiss = Int16Array.from(
      clean,
      (v, i) => v + Math.round(4_000 * Math.sin(i * 2.1) * Math.sin(i * 0.37)),
    );
    const rows = [
      [clean, {}, "good"],
      [covered(clean), {}, "muffled"],
      [holed, {}, "breaking up"],
      [clean, { missingMs: 400 }, "breaking up"],
      [clean, { herOverlap: 0.8 }, "echo"],
      [Int16Array.from(clean, (v) => Math.round(v / 40)), {}, "quiet"],
      [loud, {}, "noisy"],
      [hiss, {}, "noisy"],
    ] as const;
    expect(rows.map(([pcm, extra]) => verdictOf(pcm, extra).verdict)).toEqual(
      rows.map((r) => r[2]),
    );
    expect(inputLine(verdictOf(clean))).toBe("");
    expect(inputLine(verdictOf(covered(clean)))).toMatch(
      /muffled \(the high frequencies are \d+ dB below usual/,
    );
    // Her own voice over his: clear words are answered with nothing said about it.
    expect(inputLine(verdictOf(clean, { herOverlap: 1 }))).toMatch(
      /own voice was playing.*say nothing about it/,
    );
  });

  it("learns each speaker's usual from five good turns, and keeps the default before that", () => {
    const baselines = createInputBaselines();
    const m = measureInput(covered(voice(3)));
    for (let k = 0; k < 4; k += 1) baselines.learn("him", m);
    expect(baselines.of("him")).toEqual(DEFAULT_BASELINE);
    baselines.learn("him", m);
    expect(baselines.of("him").brightDb).toBeCloseTo(m.brightDb);
    expect(baselines.of(null)).toEqual(DEFAULT_BASELINE);
  });
});
