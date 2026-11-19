import { describe, expect, it } from "vite-plus/test";

import { grabKindOf, nearestRoot, pullOn, wrapAround, wrapCircle, type Grab } from "./bodyGrab.ts";
import { dot, len, v3, type V3 } from "./bodyRig.ts";

// her bones standing, facing +z (metres)
const pos: Record<string, V3> = {
  spine: [0, 1.0, 0],
  chest: [0, 1.15, 0],
  upperChest: [0, 1.28, 0],
  neck: [0, 1.4, 0],
  head: [0, 1.5, 0],
};
/** Rodrigues: p turned about `axis` through `pivot`. */
const turn = (p: V3, pivot: V3, axis: V3, angle: number): V3 => {
  const r = v3.sub(p, pivot);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = v3.unit(axis);
  const rot = v3.add(
    v3.add(v3.scale(r, c), v3.scale(v3.cross(k, r), s)),
    v3.scale(k, dot(k, r) * (1 - c)),
  );
  return v3.add(pivot, rot);
};
/** Where the held point goes once every bone's turn is applied, distal bones carried by proximal ones. */
const after = (g: Grab, answer: ReturnType<typeof pullOn>): V3 =>
  answer.turns.reduce((p, t) => turn(p, pos[t.bone]!, t.axis, t.angle), g.anchor);
const hair: Grab = { kind: "hair", root: "head", anchor: [0, 1.62, -0.08] };

describe("pullOn", () => {
  it("a hair pull moves her head toward the pull, whichever way it comes", () => {
    for (const dir of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, -1],
      [0, 0, 1],
      [0.7, 0.3, -0.6],
      [-0.5, -0.4, 0.7],
    ] as const) {
      const hand = v3.add(hair.anchor, v3.scale(v3.unit(dir), 0.1));
      const moved = v3.sub(after(hair, pullOn(hair, pos, hand, 0)), hair.anchor);
      expect(dot(moved, v3.unit(dir))).toBeGreaterThan(0.01);
    }
  });

  it("pulls harder and further the harder and faster it comes, inside her range, and the rest stretches", () => {
    const hand: V3 = [0.06, 1.62, -0.08];
    const tug = pullOn(hair, pos, hand, 0);
    const yank = pullOn(hair, pos, hand, 0.8);
    expect(yank.force).toBeGreaterThan(tug.force);
    expect(len(v3.sub(after(hair, yank), hair.anchor))).toBeGreaterThan(
      len(v3.sub(after(hair, tug), hair.anchor)),
    );
    const far = pullOn(hair, pos, [0.17, 1.62, -0.08], 0);
    expect(far.turns.find((t) => t.bone === "neck")!.angle).toBeLessThanOrEqual(0.45);
    expect(far.stretch).toBeGreaterThan(0);
    expect(pullOn(hair, pos, [0.01, 1.62, -0.08], 0).stretch).toBe(0);
  });

  it("a tug on her top moves her trunk; too hard a yank, or her own will, breaks the hold", () => {
    const top: Grab = { kind: "cloth", root: "chest", anchor: [0, 1.2, 0.12] };
    const hand: V3 = [0, 1.2, 0.22];
    const moved = v3.sub(after(top, pullOn(top, pos, hand, 0)), top.anchor);
    expect(moved[2]).toBeGreaterThan(0.005);
    expect(pullOn(top, pos, hand, 0, { free: true }).broke).toBe(true);
    expect(pullOn(hair, pos, [0.2, 1.62, -0.08], 2).broke).toBe(true);
    // bracing, she gives less
    expect(
      len(v3.sub(after(top, pullOn(top, pos, hand, 0, { stiff: 1 })), top.anchor)),
    ).toBeLessThan(len(moved));
  });
});

describe("what a hand holds", () => {
  it("reads hair, clothes and accessories from their names, and finds the bone a grab pulls on", () => {
    expect(grabKindOf("Hair001 N00_000_Hair_00_HAIR", true)).toBe("hair");
    expect(grabKindOf("Body N00_002_01_Tops_01_CLOTH", false)).toBe("cloth");
    expect(grabKindOf("Skirt", true)).toBe("cloth");
    expect(grabKindOf("Ribbon_L", true)).toBe("accessory");
    expect(grabKindOf("Body N00_000_00_Body_00_SKIN", false)).toBe("skin");
    expect(nearestRoot([0, 1.62, -0.05], pos)).toBe("head");
    expect(nearestRoot([0.02, 1.2, 0.12], pos)).toBe("chest");
  });
});

describe("wrapAround", () => {
  it("closes each finger round a part so no segment passes into it, tighter round a thinner part", () => {
    const segments = [0.045, 0.028, 0.02];
    const thick = 0.008;
    for (const radius of [0.03, 0.05, 0.09]) {
      const turns = wrapAround(radius, segments, thick);
      // walk the finger from its base on the part's surface, tangent to it, and measure each segment's middle
      const R = radius + thick;
      let p: [number, number] = [0, wrapCircle(radius, segments, thick)];
      let heading = 0;
      for (const [i, l] of segments.entries()) {
        heading -= turns[i]!;
        const mid: [number, number] = [
          p[0] + (Math.cos(heading) * l) / 2,
          p[1] + (Math.sin(heading) * l) / 2,
        ];
        expect(Math.hypot(...mid)).toBeGreaterThanOrEqual(R - 1e-3);
        p = [p[0] + Math.cos(heading) * l, p[1] + Math.sin(heading) * l];
      }
    }
    const sum = (r: number) => wrapAround(r, segments, thick).reduce((a, b) => a + b, 0);
    expect(sum(0.03)).toBeGreaterThan(sum(0.09));
  });
});
