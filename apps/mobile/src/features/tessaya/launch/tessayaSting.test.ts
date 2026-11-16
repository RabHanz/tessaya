import { describe, expect, it } from "@effect/vitest";

import { STING_END_S, STING_REST_S, stingFrame } from "./tessayaSting";

const bounds = (seconds: number) => {
  const f = stingFrame(seconds);
  const n = `${f.paper} ${f.dye}`.match(/-?\d+\.\d+/g)!.map(Number);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
// The mark's own box (assets/baton/logo.svg), which the native splash shows.
const MARK = [19.81, 19.81, 236.19, 236.19];

describe("stingFrame", () => {
  it("starts and ends on the resting mark, so the hand-off from the native splash and to the app never jumps", () => {
    for (const t of [0, STING_REST_S, STING_END_S, 9]) {
      bounds(t).forEach((v, i) => expect(v).toBeCloseTo(MARK[i]!, 0));
      expect(stingFrame(t).tee).toBe(0);
    }
  });

  it("sends the strips off the mark and stands the T between", () => {
    expect(bounds(0.4)[3]).toBeGreaterThan(300);
    expect(stingFrame(0.8).tee).toBeCloseTo(1, 2);
  });
});
