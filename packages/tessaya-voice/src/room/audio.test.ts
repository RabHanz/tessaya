import { expect, it } from "vite-plus/test";

import { createResampler24to16, createWavReader } from "./audio.ts";

it("turns 24 kHz into 16 kHz in chunks without losing level or pitch", () => {
  const tone = Int16Array.from({ length: 24_000 }, (_, n) =>
    Math.round(10_000 * Math.sin((2 * Math.PI * 1000 * n) / 24_000)),
  );
  const down = createResampler24to16();
  const parts = [down(tone.subarray(0, 7_001)), down(tone.subarray(7_001))];
  const out = new Int16Array(parts[0]!.length + parts[1]!.length);
  out.set(parts[0]!);
  out.set(parts[1]!, parts[0]!.length);
  expect(Math.abs(out.length - 16_000)).toBeLessThan(40);
  const mid = out.subarray(2_000, 14_000);
  const peak = Math.max(...mid.map(Math.abs));
  expect(peak).toBeGreaterThan(9_500);
  expect(peak).toBeLessThan(10_500);
  let crossings = 0;
  for (let i = 1; i < mid.length; i += 1) if (mid[i - 1]! < 0 !== mid[i]! < 0) crossings += 1;
  expect(Math.abs(crossings - 1_500)).toBeLessThan(4);
});

it("drops a streaming WAV header split across chunks and keeps a sample split across chunks", () => {
  const header = Buffer.concat([
    Buffer.from("RIFF\xff\xff\xff\xffWAVEfmt ", "latin1"),
    Buffer.alloc(20),
    Buffer.from("data"),
    Buffer.alloc(4, 0xff),
  ]);
  const body = Buffer.alloc(6);
  [1, -2, 300].forEach((v, i) => body.writeInt16LE(v, i * 2));
  const all = Buffer.concat([header, body]);
  const read = createWavReader();
  const got = [
    read(all.subarray(0, 10)),
    read(all.subarray(10, header.length + 3)),
    read(all.subarray(header.length + 3)),
  ];
  expect(got.flatMap((g) => [...g])).toEqual([1, -2, 300]);
});
