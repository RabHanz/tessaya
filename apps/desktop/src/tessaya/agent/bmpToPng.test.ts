import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { bmpToPng } from "./bmpToPng.ts";

describe("bmpToPng", () => {
  it("turns a 2x1 BGRA picture into an RGB PNG with the same pixels", () => {
    const bmp = Buffer.alloc(54 + 8);
    bmp.write("BM", 0);
    bmp.writeUInt32LE(54, 10);
    bmp.writeInt32LE(2, 18);
    bmp.writeInt32LE(-1, 22);
    bmp.writeUInt16LE(32, 28);
    bmp.set([10, 20, 30, 255, 40, 50, 60, 255], 54); // B,G,R,A twice
    const png = bmpToPng(bmp);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const idat = png.indexOf("IDAT");
    const length = png.readUInt32BE(idat - 4);
    const raw = NodeZlib.inflateSync(png.subarray(idat + 4, idat + 4 + length));
    expect([...raw]).toEqual([0, 30, 20, 10, 60, 50, 40]);
  });
});
