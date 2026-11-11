import { expect, it } from "vite-plus/test";

import { whisperFeatures } from "./smartTurn.ts";

it("computes Whisper's normalised, right-padded log-mel exactly as the reference (numpy rfft and librosa's slaney bank)", () => {
  const pcm = Int16Array.from({ length: 24_000 }, (_, n) =>
    Math.round(
      4000 * Math.sin((2 * Math.PI * 440 * n) / 16000) +
        2000 * Math.sin((2 * Math.PI * 3100 * n) / 16000) +
        (((n * 7919) % 601) - 300),
    ),
  );
  const f = whisperFeatures(pcm);
  expect(f.length).toBe(80 * 800);
  const at = (mel: number, frame: number) => f[mel * 800 + frame]!;
  expect(at(0, 0)).toBeCloseTo(1.2006, 3);
  expect(at(10, 5)).toBeCloseTo(1.55, 3);
  expect(at(40, 100)).toBeCloseTo(-0.3604, 3);
  expect(at(79, 140)).toBeCloseTo(0.4947, 3);
  // The zero padding after the clip sits at the floor, 8 decades under the loudest cell.
  expect(at(20, 500)).toBeCloseTo(-0.3604, 3);
});
