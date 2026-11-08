import { describe, expect, it } from "vite-plus/test";

import { candidateFile, medianPitchHz, voiceKind } from "./voiceLabAudio.ts";

const tone = (hz: number, seconds: number, rate = 16_000): Int16Array =>
  Int16Array.from({ length: rate * seconds }, (_, i) =>
    Math.round(8_000 * Math.sin((2 * Math.PI * hz * i) / rate)),
  );

describe("the voice lab's audio helpers", () => {
  it.each([
    [110, "male"],
    [220, "female"],
    [165, "unknown"],
  ] as const)("hears a %i Hz voice as %s", (hz, kind) => {
    const pitch = medianPitchHz(tone(hz, 1), 16_000);
    expect(pitch).not.toBeNull();
    expect(Math.abs((pitch ?? 0) - hz)).toBeLessThan(hz * 0.05);
    expect(voiceKind(pitch)).toBe(kind);
  });

  it("calls silence unknown", () => {
    expect(voiceKind(medianPitchHz(new Int16Array(16_000), 16_000))).toBe("unknown");
  });

  it("names a candidate's file by its place and spelling", () => {
    expect(candidateFile(0, "Tessaya")).toBe("01-Tessaya.wav");
    expect(candidateFile(2, "Tess AY uh")).toBe("03-Tess-AY-uh.wav");
  });
});
