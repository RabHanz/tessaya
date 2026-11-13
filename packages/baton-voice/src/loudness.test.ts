import { describe, expect, it } from "vite-plus/test";

import { integratedLufs, loudnessGain, withGain } from "./loudness.ts";

const tone = (amp: number, hz = 1_000, rate = 16_000, seconds = 2) =>
  Int16Array.from({ length: rate * seconds }, (_, i) =>
    Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)),
  );

describe("loudness", () => {
  it("measures a full-scale 1 kHz sine near -3 LUFS (BS.1770), and 6 dB less at half the level", () => {
    expect(integratedLufs(tone(1), 16_000)).toBeCloseTo(-3.0, 0);
    expect(integratedLufs(tone(0.5), 16_000) - integratedLufs(tone(1), 16_000)).toBeCloseTo(
      -6.02,
      1,
    );
    expect(integratedLufs(new Int16Array(16_000), 16_000)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("brings a quiet voice and a loud one to the same level, without clipping", () => {
    const quiet = tone(0.05);
    const loud = tone(0.3);
    const level = (pcm: Int16Array) =>
      integratedLufs(withGain(pcm, loudnessGain(integratedLufs(pcm, 16_000), -20)), 16_000);
    expect(level(quiet)).toBeCloseTo(-20, 0);
    expect(level(loud)).toBeCloseTo(-20, 0);
    // A gain that would clip is bent under full scale.
    expect(Math.max(...withGain(tone(0.9), 4))).toBeLessThanOrEqual(32767);
    expect(loudnessGain(-60, -16)).toBe(8);
    // Alfred's voice measured -31.1 LUFS on the voice host (13 Nov): brought all the way to the others.
    expect(20 * Math.log10(loudnessGain(-31.1, -16))).toBeCloseTo(15.1, 1);
  });
});
