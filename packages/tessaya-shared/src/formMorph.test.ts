import { describe, expect, it } from "vite-plus/test";

import { MORPH, morphAt, morphSeconds, owlAt, swapAt, swapSeconds, wPart } from "./formMorph.ts";

const frames = (dir: "in" | "out") => Math.round(morphSeconds(dir) * MORPH.FPS * 2) / 2;

describe("formMorph clock", () => {
  it("keeps v4's passed windows: 30.5 frames into her body, 31.5 back to the cartoon", () => {
    expect(frames("in")).toBe(30.5);
    expect(frames("out")).toBe(31.5);
  });

  it("runs every part from the first form to the second, in both directions", () => {
    for (const dir of ["in", "out"] as const) {
      const start = morphAt(dir, 0);
      const end = morphAt(dir, morphSeconds(dir));
      const [a, b] = dir === "in" ? [0, 1] : [1, 0];
      for (const key of ["plain", "wipe", "pp"] as const) {
        expect(start[key]).toBeCloseTo(a, 3);
        expect(end[key]).toBeCloseTo(b, 3);
      }
      expect(start.prog).toBeCloseTo(0, 3);
      expect(end.prog).toBeCloseTo(1, 3);
      expect(end.done).toBe(true);
    }
  });

  it("hugs her crown first going in, and lets go of her crown first coming out", () => {
    const mid = morphAt("in", 0.45);
    expect(mid.hug(1)).toBeGreaterThan(mid.hug(0));
    const back = morphAt("out", 0.9);
    expect(back.hug(1)).toBeLessThan(back.hug(0));
  });

  it("melts the drawn face into the skin before her own face resolves", () => {
    // her face shows once the wipe passes her head (about a fifth of the way down)
    const dir = "in" as const;
    let faceGoneAt = Infinity;
    let headShownAt = Infinity;
    for (let t = 0; t <= morphSeconds(dir); t += 1 / 96) {
      const f = morphAt(dir, t);
      if (f.face < 0.01) faceGoneAt = Math.min(faceGoneAt, t);
      if (f.wipe > 0.2) headShownAt = Math.min(headShownAt, t);
    }
    expect(faceGoneAt).toBeLessThan(headShownAt);
  });

  it("starts the water look's reveal sooner (no held column) and clears its last piece sooner", () => {
    const firstReveal = (look: "original" | "water") => {
      for (let t = 0; ; t += 1 / 96) if (morphAt("in", t, look).wipe > 0.05) return t;
    };
    expect(firstReveal("water")).toBeLessThan(firstReveal("original"));
    const late = morphSeconds("in") * 0.9;
    expect(morphAt("in", late, "water").wipe).toBeGreaterThan(morphAt("in", late, "original").wipe);
  });

  it("hands one form to another while both halves are still moving, with no still column between", () => {
    const { COVER, IN0 } = MORPH.M2M;
    // the first form is all but covered as "out" stops, and the skin was still closing over it
    expect(wPart(MORPH.LEAD.wipe, MORPH.DURS.wipe, COVER, "out")).toBeLessThan(0.1);
    expect(wPart(MORPH.LEAD.wipe, MORPH.DURS.wipe, COVER - 1, "out")).toBeGreaterThan(
      wPart(MORPH.LEAD.wipe, MORPH.DURS.wipe, COVER, "out"),
    );
    // "in" starts with the skin already on its way to the second form
    const hug = (u: number) => wPart(MORPH.LEAD.hug, MORPH.DURS.hug, u, "in");
    expect(hug(IN0)).toBeGreaterThan(0);
    expect(hug(IN0 + 1)).toBeGreaterThan(hug(IN0));
  });

  it("swaps one form for another with no jump at the hand-over, the skin closed between", () => {
    const end = swapAt("cover", swapSeconds("cover"));
    const start = swapAt("reveal", 0);
    expect(end.prog).toBeCloseTo(0.5, 3);
    expect(start.prog).toBeCloseTo(0.5, 3);
    expect(end.wipe).toBeLessThan(0.1);
    expect(start.wipe).toBe(0);
    expect(swapAt("reveal", swapSeconds("reveal")).wipe).toBeCloseTo(1, 3);
    expect(swapAt("cover", 0).wipe).toBeCloseTo(1, 3);
  });

  it("flies the owl up, around and down to land within its span", () => {
    const span = 5;
    expect(owlAt(0, span).air).toBe(0);
    expect(owlAt(span / 2, span).air).toBeGreaterThan(0.9);
    expect(owlAt(span, span)).toMatchObject({ air: 0, done: true });
  });

  it("matches v4's w_part at its ends", () => {
    expect(wPart(0, 14, 0, "in")).toBe(0);
    expect(wPart(0, 14, 14, "in")).toBe(1);
    expect(wPart(0, 14, 0, "out")).toBe(1);
  });
});
