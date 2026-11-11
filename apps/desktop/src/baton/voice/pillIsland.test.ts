import { describe, expect, it } from "vite-plus/test";

import { islandHead } from "./pillIsland.ts";

// Tessaya's measured parts: ✕ 26×26, ✓ 28×26, the dot 6×6, the waveform 64×20.
const parts = { dx: [26, 26], dv: [28, 26], mic: [6, 6], w: [64, 20] } as const;

describe("the island's head", () => {
  it("keeps the waveform at the window's centre in every state, whatever the window's real width", () => {
    // The pill (116), hands-free (142), a one-line card and a full card; windows 420 wide, or a pixel off at 175%.
    for (const winW of [420, 419, 421, 419.43])
      for (const ww of [116, 142, 248, 410]) {
        const head = islandHead(winW, ww, parts);
        expect(Math.abs(head.x0 + ww / 2 - winW / 2)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(head.w + parts.w[0] / 2 - winW / 2)).toBeLessThanOrEqual(0.5);
        // ✕ and ✓ sit the same distance in from either end.
        expect(head.dx - head.x0).toBeCloseTo(head.x0 + ww - (head.dv + parts.dv[0]), 5);
      }
  });

  it("puts the dot just left of the waveform, where the plain pill has it", () => {
    const pill = islandHead(420, 116, parts);
    expect(pill.mic).toBeCloseTo(pill.x0 + 12, 5);
    const card = islandHead(420, 410, parts);
    expect(card.w - card.mic).toBeCloseTo(pill.w - pill.mic, 5);
  });
});
