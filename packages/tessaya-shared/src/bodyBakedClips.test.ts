import { describe, expect, it } from "vitest";

import { BAKED_CLIPS } from "./bodyBakedClips.data.ts";
import { bakedClip, decodeBaked } from "./bodyBakedClips.ts";
import { MOTION_LIBRARY } from "./bodyMotionLibrary.ts";

describe("baked clips", () => {
  it("decodes the first frame as Int16 steps, then sums Int8 changes, at 1/500 rad", () => {
    // one bone: [1, -1, 0.5] rad, then +0.004, -0.002, 0
    const bytes = new Uint8Array(6 + 3);
    const view = new DataView(bytes.buffer);
    [500, -500, 250].forEach((v, i) => view.setInt16(2 * i, v, true));
    [2, -1, 0].forEach((v, i) => view.setInt8(6 + i, v));
    const frames = decodeBaked(["head"], bytes);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.head).toEqual([1, -1, 0.5]);
    expect(frames[1]!.head![0]).toBeCloseTo(1.004, 9);
    expect(frames[1]!.head![1]).toBeCloseTo(-1.002, 9);
  });

  it("rejects bytes that do not fit its bones", () => {
    expect(() => decodeBaked(["head", "neck"], new Uint8Array(7))).toThrow();
  });

  it("names only library entries, and every one decodes to finite poses", () => {
    const ids = new Set(MOTION_LIBRARY.map((e) => e.id));
    for (const entry of Object.keys(BAKED_CLIPS)) {
      expect(ids.has(entry)).toBe(true);
      const clip = bakedClip(entry)!;
      expect(clip.frames.length).toBeGreaterThan(1);
      for (const f of clip.frames)
        for (const e of Object.values(f))
          expect(e!.every((x) => Number.isFinite(x) && Math.abs(x) < 64)).toBe(true);
    }
  });
});
