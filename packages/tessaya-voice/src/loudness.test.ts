import { describe, expect, it } from "vite-plus/test";

import { fitMakeup, gainLimiter, integratedLufs, loudnessGain, SMALL_SPEAKER } from "./loudness.ts";

const tone = (amp: number, hz = 1_000, rate = 16_000, seconds = 2, phase = 0) =>
  Int16Array.from({ length: rate * seconds }, (_, i) =>
    Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / rate + phase)),
  );
const peakOf = (pcm: Int16Array) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / 32767;

describe("loudness", () => {
  it("measures a full-scale 1 kHz sine near -3 LUFS (BS.1770), and 6 dB less at half the level", () => {
    expect(integratedLufs(tone(1), 16_000)).toBeCloseTo(-3.0, 0);
    expect(integratedLufs(tone(0.5), 16_000) - integratedLufs(tone(1), 16_000)).toBeCloseTo(
      -6.02,
      1,
    );
    expect(integratedLufs(new Int16Array(16_000), 16_000)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("brings a quiet voice and a loud one to the same level, under -1 dB true peak", () => {
    const quiet = tone(0.05);
    const loud = tone(0.3);
    const level = (pcm: Int16Array) =>
      integratedLufs(gainLimiter(loudnessGain(integratedLufs(pcm, 16_000), -20))(pcm), 16_000);
    expect(level(quiet)).toBeCloseTo(-20, 0);
    expect(level(loud)).toBeCloseTo(-20, 0);
    // A gain that would clip is held under -1 dBFS, the 15 dB boost on Alfred's loudest syllables included.
    expect(peakOf(gainLimiter(4)(tone(0.9)))).toBeLessThanOrEqual(10 ** (-1 / 20));
    // Its peaks fall between samples (4 kHz at 16 kHz, 45° on): the samples read -4 dB while the wave reaches +1.6 dB.
    const between = tone(0.8, 4_000, 16_000, 1, Math.PI / 4);
    // After its first 10 ms: a full-scale tone out of nothing is no voice, and its edge fools the estimate.
    expect(peakOf(gainLimiter(1.5)(between).slice(160)) / Math.SQRT1_2).toBeLessThanOrEqual(
      10 ** (-1 / 20) + 0.01,
    );
    expect(peakOf(gainLimiter(1)(between))).toBeCloseTo(peakOf(between), 3);
    expect(loudnessGain(-60, -16)).toBe(8);
    // Alfred's voice measured -31.1 LUFS on the voice host (13 Nov): brought all the way to the others.
    expect(20 * Math.log10(loudnessGain(-31.1, -16))).toBeCloseTo(15.1, 1);
  });

  it("compresses a peaky voice to -13 LUFS under -1 dB true peak, and does nothing at 1:1", () => {
    // syllables: a 220 Hz tone whose level swings 18 dB, 4 times a second
    const voice = Int16Array.from({ length: 16_000 * 4 }, (_, i) =>
      Math.round(
        0.5 *
          32767 *
          10 ** ((-18 * (0.5 + 0.5 * Math.cos((2 * Math.PI * 4 * i) / 16_000))) / 20) *
          Math.sin((2 * Math.PI * 220 * i) / 16_000),
      ),
    );
    const gain = loudnessGain(integratedLufs(voice, 16_000), -16);
    const makeup = fitMakeup(voice, 16_000, gain, -13, SMALL_SPEAKER);
    const out = gainLimiter(gain, 16_000, -1, { ...SMALL_SPEAKER, makeup })(voice);
    expect(integratedLufs(out, 16_000)).toBeCloseTo(-13, 0);
    expect(peakOf(out)).toBeLessThanOrEqual(10 ** (-1 / 20));
    const flat = gainLimiter(0.5, 16_000, -1, { thresholdDb: -20, ratio: 1, makeup: 1 })(voice);
    expect(flat).toEqual(gainLimiter(0.5)(voice));
  });
});
