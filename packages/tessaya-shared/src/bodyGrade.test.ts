import { describe, expect, it } from "vite-plus/test";

import { clipCheck } from "./bodyGrade.ts";
import type { Euler, PoseBone } from "./bodyMotion.ts";

type Frame = Partial<Record<PoseBone, Euler>>;

describe("a clip checked joint by joint", () => {
  // rows of the owner-extensions rig review (its extensions-viewer TSV, 20 Nov): the joint as the model shows
  // it in VRM 1.0 axes, and what the rig corrects; the playground's per-joint list must say the same
  it.each([
    ['DEMO_SCENE[0] "Idle greeting"', "leftLowerArm", [0.8, 0, 0.2], "sideBend", 0.14],
    ['DEMO_SCENE[1] "Shy look away"', "leftLowerArm", [0.8, 0, 0.5], "sideBend", 0.35],
    ['DEMO_SCENE[3] "Kneeling pose"', "leftLowerLeg", [-2.3, 0, 0], "reversal", 2.3],
    ['DEMO_SCENE[4] "All fours"', "rightLowerLeg", [-1.8, 0, 0], "reversal", 1.8],
    ['DEMO_SCENE[4] "All fours"', "leftUpperArm", [1.5, 0.3, -1.5], "range", 0.52],
  ] as const)("%s: %s is %s", (_, bone, shown, kind, by) => {
    const check = clipCheck({ fps: 30, frames: [{ [bone]: shown } as Frame] });
    expect(check.joints).toHaveLength(1);
    expect(check.joints[0]).toMatchObject({ bone, kind, frames: 1 });
    expect(check.joints[0]!.by).toBeCloseTo(by, 2);
  });

  it("counts the frames a joint is wrong in, worst first, and flags speed and a loop's seam", () => {
    const knee = (x: number): Frame => ({ leftLowerLeg: [x, 0, 0], rightLowerArm: [0.8, 0, -0.2] });
    const check = clipCheck({ fps: 30, loop: true, frames: [knee(-0.5), knee(-1), knee(0.4)] });
    expect(check.joints.map((j) => [j.bone, j.kind, j.frames])).toEqual([
      ["leftLowerLeg", "reversal", 2],
      ["rightLowerArm", "sideBend", 3],
    ]);
    expect(check.overSpeed).toEqual(["leftLowerLeg"]);
    expect(check.seam).toBeCloseTo(0.9, 5);
    expect(clipCheck({ fps: 30, frames: [knee(0.4), knee(0.5)] })).toEqual({
      joints: [{ bone: "rightLowerArm", kind: "sideBend", by: expect.any(Number), frames: 2 }],
      overSpeed: [],
      seam: 0,
    });
  });
});
