import { describe, expect, it } from "vite-plus/test";

import { fbank } from "./fbank.ts";

describe("the speaker model's front end", () => {
  it("matches Kaldi's fbank with mean subtraction (kaldi-native-fbank 1.21, povey, no dither)", () => {
    const pcm = Int16Array.from({ length: 1200 }, (_, n) =>
      Math.round(
        4000 * Math.sin((2 * Math.PI * 440 * n) / 16000) +
          2000 * Math.sin((2 * Math.PI * 3100 * n) / 16000) +
          (((n * 7919) % 601) - 300),
      ),
    );
    const { frames, data } = fbank(pcm);
    expect(frames).toBe(6);
    const near = (f: number, ref: ReadonlyArray<number>) =>
      [0, 10, 40, 79].forEach((bin, i) => expect(data[f * 80 + bin]!).toBeCloseTo(ref[i]!, 2));
    near(0, [-1.4436, -0.0052, 0.1027, -0.0512]);
    near(4, [0.431, -0.01, 0.1015, -0.0521]);
  });

  it("gives nothing for under one 25 ms frame", () => {
    expect(fbank(new Int16Array(399)).frames).toBe(0);
  });
});
