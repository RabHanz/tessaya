import { describe, expect, it } from "vite-plus/test";

import { clampSpot, pinchScale, STAGE_SCALE, wanderSpot } from "./sleeveEstate.ts";

const box = { w: 390, h: 844, bottom: 120 };

describe("her estate on a Sleeve", () => {
  it("keeps all of her on screen and above the app's panel, wherever she is sent", () => {
    expect(clampSpot({ x: -50, y: 2000, scale: 1 }, 200, box)).toEqual({
      x: 100,
      y: 624,
      scale: 1,
    });
    expect(clampSpot({ x: 195, y: 300, scale: 1 }, 200, box)).toEqual({ x: 195, y: 300, scale: 1 });
  });

  it("grows and shrinks only within her bounds, and centres her when she is wider than the screen", () => {
    expect(clampSpot({ x: 0, y: 0, scale: 9 }, 200, box).scale).toBe(STAGE_SCALE.max);
    expect(clampSpot({ x: 0, y: 0, scale: 0 }, 200, box).scale).toBe(STAGE_SCALE.min);
    expect(clampSpot({ x: 0, y: 300, scale: 1.7 }, 300, box).x).toBe(195);
  });

  it("follows a pinch by the change in finger distance", () => {
    expect(pinchScale(1, 100, 150)).toBe(1.5);
    expect(pinchScale(1, 100, 10)).toBe(STAGE_SCALE.min);
    expect(pinchScale(1.2, 0, 50)).toBe(1.2);
  });

  it("strolls a short way and never off her screen", () => {
    const from = { x: 195, y: 300, scale: 1 };
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const to = wanderSpot(from, 200, box, () => r);
      expect(to.x).toBeGreaterThanOrEqual(100);
      expect(to.x).toBeLessThanOrEqual(290);
      expect(to.y).toBeLessThanOrEqual(624);
    }
  });
});
