import { expect, it } from "vite-plus/test";

import { cosine } from "../speaker.ts";
import { FAR_VARIANTS, farCentroid, farFrom } from "./farVoice.ts";

const tone = (n: number) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin(i / 3)));
const rms = (pcm: Int16Array) => Math.sqrt(pcm.reduce((n, v) => n + v * v, 0) / pcm.length);

it("makes his clip sound from across the room, the same way every time, and his far voice only from long clips", async () => {
  const clip = tone(32_000);
  const far = farFrom(clip, FAR_VARIANTS[0]!);
  expect(far).toHaveLength(clip.length);
  expect(rms(far)).toBeLessThan(rms(clip) / 2);
  expect(farFrom(clip, FAR_VARIANTS[0]!)).toEqual(far);
  // A stub embedder: each degraded clip's level as a direction, so the centroid exists and is unit length.
  const embed = async (pcm: Int16Array) => Float32Array.of(rms(pcm), 1, 0.5);
  expect(await farCentroid([tone(8_000)], embed)).toBeNull();
  const made = await farCentroid([clip, tone(30_000)], embed);
  expect(made).not.toBeNull();
  expect(cosine(made!, made!)).toBeCloseTo(1);
});
