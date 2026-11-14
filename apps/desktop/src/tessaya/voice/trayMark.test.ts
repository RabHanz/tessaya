import { describe, expect, it } from "vite-plus/test";

import { MARK_MASTER_PATH, TRAY_PNG, TRAY_SIZES } from "./trayArt.ts";
import { brandMarkSvg, markSvg, withTrayState } from "./trayMark.ts";

const px = (buf: Buffer, size: number, x: number, y: number) => [
  ...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
];

describe("the tray mark's art", () => {
  it("carries every size in both colours as a PNG", () => {
    for (const colour of ["white", "black"]) {
      for (const size of TRAY_SIZES) {
        const bytes = Buffer.from(TRAY_PNG[`${colour}-${size}`]!, "base64");
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        expect(bytes.readUInt32BE(16)).toBe(size);
      }
    }
  });
  it("draws the window's mark from the master and its reversed cut, with the kit's two dye strips marked", () => {
    expect(MARK_MASTER_PATH).toMatch(/^M[\d.]+[ ,][\d.]+L/);
    const svg = brandMarkSvg();
    const dye = [...svg.matchAll(/class="on-light dye"[^>]* d="([^"]+)"/g)].map((m) => m[1]);
    // The kit's colour mark (colour/woad/tessaya-mark-on-paper.svg) dyes exactly these two strips.
    expect(dye).toEqual([
      "M82.04 111.74L144.26 173.96L128.71 189.52L66.48 127.29ZM83.45 66.48L99.01 82.04L35.37 145.68L19.81 130.12Z",
    ]);
    expect(svg).toContain('class="on-dark dye"');
    const light = [...svg.matchAll(/class="on-light[^"]*"[^>]* d="([^"]+)"/g)].map(
      (m) => m[1]!.split(/(?=M)/).length,
    );
    expect(light).toEqual([7, 2]);
  });
});

describe("the state on the tray mark", () => {
  const size = 32;
  const base = { color: "#22c55e", caps: [true, true, false], muted: false } as const;
  const clear = Buffer.alloc(size * size * 4);
  it("puts a dot of the state colour bottom right and leaves the top right alone", () => {
    const out = withTrayState(clear, size, base, true);
    expect(px(out, size, 28, 28)).toEqual([0x5e, 0xc5, 0x22, 255]);
    expect(px(out, size, 28, 3)[3]).toBe(0);
  });
  it("adds the update dot top right only when an update is ready", () => {
    const out = withTrayState(clear, size, { ...base, badge: true }, true);
    expect(px(out, size, 28, 3)).toEqual([0x5c, 0x50, 0xd8, 255]);
  });
  it("keeps the mark's own pixels away from the dot", () => {
    const mark = Buffer.alloc(size * size * 4, 255);
    const out = withTrayState(mark, size, base, false);
    expect(px(out, size, 2, 2)).toEqual([255, 255, 255, 255]);
    expect(px(out, size, 22, 28)[3]).toBe(0);
  });
  it("keeps the status tile for the Home page", () => {
    expect(markSvg({ ...base, muted: true })).toContain("<line");
  });
});
