import { describe, expect, it } from "vite-plus/test";

import {
  euroStep,
  handContact,
  handPresence,
  pointerHand,
  predict,
  type EuroState,
} from "./bodyHand.ts";
import type { V3 } from "./bodyRig.ts";

describe("the hand", () => {
  it("smooths a jittering hand at rest and follows one that moves, predicting a little ahead", () => {
    let s: EuroState | null = null;
    const still: number[] = [];
    for (let i = 0; i < 60; i++) {
      s = euroStep(s, [0.002 * Math.sin(i * 2.7), 1, 0], i * 16);
      still.push(s.x[0]);
    }
    expect(Math.max(...still.slice(20).map(Math.abs))).toBeLessThan(0.002);
    for (let i = 60; i < 120; i++) s = euroStep(s, [(i - 60) * 0.005, 1, 0], i * 16);
    expect(s!.x[0]).toBeGreaterThan(0.25);
    expect(predict(s!, 50)[0]).toBeGreaterThan(s!.x[0]);
  });

  it("fades and relaxes when tracking is lost, instead of freezing", () => {
    const f = pointerHand({
      at: 1000,
      hit: [0, 1, 0.1],
      normal: [0, 0, 1],
      pressure: 0.5,
      pressed: true,
      fingertip: false,
    });
    expect(handPresence(f, 1000)).toEqual({ shown: 1, relax: 0 });
    expect(handPresence(f, 1200).shown).toBeCloseTo(0.5);
    expect(handPresence(f, 2000)).toEqual({ shown: 0, relax: 1 });
    expect(handPresence({ ...f, confidence: 0.4 }, 1000).shown).toBeCloseTo(0.4);
  });

  it("lays a pointer's palm toward her, fingers along her, and feels a fingertip smaller than a palm", () => {
    const f = pointerHand({
      at: 0,
      hit: [0, 1, 0.1],
      normal: [0, 0, 1],
      pressure: 0.5,
      pressed: true,
      fingertip: false,
    });
    expect(f.normal).toEqual([-0, -0, -1]);
    const d: V3 = f.direction;
    expect(Math.abs(d[0] * f.normal[0] + d[1] * f.normal[1] + d[2] * f.normal[2])).toBeLessThan(
      1e-9,
    );
    const tip = pointerHand({
      at: 0,
      hit: [0, 1, 0.1],
      normal: [0, 0, 1],
      pressure: 0.9,
      pressed: true,
      fingertip: true,
    });
    expect(handContact(tip, 0.18).area).toBeLessThan(handContact(f, 0.18).area / 10);
    expect(
      pointerHand({
        at: 0,
        hit: [0, 1, 0],
        normal: [0, 1, 0],
        pressure: 0,
        pressed: false,
        fingertip: false,
      }).pressure,
    ).toBe(0.05);
  });
});
