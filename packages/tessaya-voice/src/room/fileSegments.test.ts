import { expect, it } from "vite-plus/test";

import { createFileSegmenter, stamp } from "./fileSegments.ts";

const W = 512;
const run = (probs: ReadonlyArray<number>) => {
  const seg = createFileSegmenter();
  const out = probs.map((p, i) => seg.push(new Int16Array(W).fill(i), p)).filter((s) => s !== null);
  const last = seg.flush();
  return last === null ? out : [...out, last];
};

it("cuts speech at half a second of quiet, with a little padding either side and its start in the file", () => {
  const segs = run([...Array(20).fill(0), ...Array(30).fill(0.9), ...Array(40).fill(0)]);
  expect(segs).toHaveLength(1);
  expect(segs[0]!.start).toBe(14 * W);
  expect(segs[0]!.pcm.length).toBe((7 + 29 + 6) * W);
  expect(segs[0]!.pcm[0]).toBe(14);
});

it("never lets a stretch pass 25 s, and cuts at the first dip after 15 s", () => {
  expect(run(Array(2000).fill(0.9)).map((s) => s.pcm.length / 16_000)).toEqual([
    24.992, 24.992, 14.016,
  ]);
  const dip = run([...Array(500).fill(0.9), 0.4, ...Array(100).fill(0.9)]);
  expect(dip[0]!.pcm.length).toBe(501 * W);
});

it("stamps minutes and seconds, and hours from the first hour", () => {
  expect([stamp(0), stamp(16_000 * 75), stamp(16_000 * 3725)]).toEqual([
    "[00:00]",
    "[01:15]",
    "[1:02:05]",
  ]);
});
