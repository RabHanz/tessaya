// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { lowFrameRate, readOnnxMetadata } from "./senseVoice.ts";

it("stacks 7 frames every 6 like FunASR's apply_lfr, repeating the first frame in front and the last at the end", () => {
  const frames = 8;
  const data = Float32Array.from({ length: frames * 80 }, (_, i) => Math.floor(i / 80));
  const out = lowFrameRate(data, frames, 7, 6);
  expect(out.frames).toBe(2);
  const firstOfEach = (row: number) =>
    Array.from({ length: 7 }, (_, k) => out.data[(row * 7 + k) * 80]);
  expect(firstOfEach(0)).toEqual([0, 0, 0, 0, 1, 2, 3]);
  expect(firstOfEach(1)).toEqual([3, 4, 5, 6, 7, 7, 7]);
});

it("reads the exporter's string metadata from the model file's tail", () => {
  const entry = (k: string, v: string) =>
    Buffer.concat([
      Buffer.from([0x0a, k.length]),
      Buffer.from(k),
      Buffer.from([0x12, v.length]),
      Buffer.from(v),
    ]);
  const file = NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sv-")), "m.onnx");
  NodeFS.writeFileSync(
    file,
    Buffer.concat([Buffer.alloc(1000), entry("lfr_window_size", "7"), entry("neg_mean", "-1,-2")]),
  );
  expect(readOnnxMetadata(file, ["lfr_window_size", "neg_mean", "absent"])).toEqual({
    lfr_window_size: "7",
    neg_mean: "-1,-2",
  });
});
