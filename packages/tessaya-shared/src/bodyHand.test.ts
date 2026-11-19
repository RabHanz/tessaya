import { describe, expect, it } from "vite-plus/test";

import {
  agentHandAt,
  euroStep,
  handContact,
  handPresence,
  pointerHand,
  predict,
  yieldTo,
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
  it("moves an agent's hand as asked, easing on and off, a poke in and out in a quarter second", () => {
    expect(agentHandAt("rest", 0.5, 1000, 0)!.pressure).toBe(0);
    expect(agentHandAt("rest", 0.5, 1000, 500)!.pressure).toBe(0.5);
    expect(agentHandAt("rest", 0.5, 1000, 1001)).toBeNull();
    const poke = [0, 125, 250, 400].map((t) => agentHandAt("poke", 1, 1000, t)!);
    expect(poke.map((p) => +p.pressure.toFixed(2))).toEqual([0, 1, 0, 0]);
    expect(poke.every((p) => p.fingertip)).toBe(true);
    const stroke = [1500, 4500].map((t) => agentHandAt("stroke", 0.4, 8000, t)!.along);
    expect(stroke[0]).toBeCloseTo(1);
    expect(stroke[1]).toBeCloseTo(-1);
    // a hold is never a light touch
    expect(agentHandAt("hold", 0.1, 1000, 500)!.pressure).toBe(0.6);
  });
  it("gives where it is pressed: the nearest part turns away along the push, more for a poke", () => {
    const pos: Record<string, V3> = {
      spine: [0, 1.0, 0],
      upperChest: [0, 1.25, 0],
      neck: [0, 1.36, 0],
      head: [0, 1.46, 0],
      leftUpperArm: [0.15, 1.33, 0],
      leftLowerArm: [0.2, 1.08, 0],
      leftHand: [0.22, 0.84, 0],
    };
    // pushed back at her left upper arm: the arm turns about her shoulder so the arm goes back (-z)
    const arm = yieldTo(pos, [0.18, 1.2, 0.04], [0, 0, -1], 0.5)!;
    expect(arm.bone).toBe("leftUpperArm");
    expect(arm.angle).toBeCloseTo(0.08);
    const after = (p: V3, pivot: V3) => {
      // rotate p about pivot by the answer (Rodrigues), enough to see which way it went
      const [x, y, z] = arm.axis;
      const v = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
      const c = Math.cos(arm.angle);
      const sn = Math.sin(arm.angle);
      const d = x * v[0]! + y * v[1]! + z * v[2]!;
      return [
        v[0]! * c + (y * v[2]! - z * v[1]!) * sn + x * d * (1 - c),
        v[1]! * c + (z * v[0]! - x * v[2]!) * sn + y * d * (1 - c),
        v[2]! * c + (x * v[1]! - y * v[0]!) * sn + z * d * (1 - c),
      ];
    };
    expect(after(pos["leftLowerArm"]!, pos["leftUpperArm"]!)[2]).toBeLessThan(0);
    // a poke's reflex makes her pull back further; a light brush moves nothing
    expect(yieldTo(pos, [0.18, 1.2, 0.04], [0, 0, -1], 0.5, 0.4)!.angle).toBeGreaterThan(arm.angle);
    expect(yieldTo(pos, [0, 1.45, 0.08], [0, 0, -1], 0.01)).toBeNull();
    expect(yieldTo(pos, [0, 1.45, 0.08], [0, 0, -1], 0.5)!.bone).toBe("neck");
  });
});
