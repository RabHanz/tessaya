import { describe, expect, it } from "vite-plus/test";

import type { BodyCue } from "./bodyCues.ts";
import { POSTURES, type Euler, type PoseBone } from "./bodyMotion.ts";
import { decodeHold, performCues, speedRatio, type Perform } from "./bodyPlanner.ts";

type Pose = Partial<Record<PoseBone, Euler>>;
const clipOf = (cues: ReadonlyArray<BodyCue>) => {
  const c = cues.find((x) => x.kind === "clip");
  if (c?.kind !== "clip") throw new Error("no clip");
  return c;
};
const timed = (cues: ReadonlyArray<BodyCue>): BodyCue[] =>
  cues.flatMap((c) => (c.kind === "seq" ? c.steps.flatMap((s) => s.cues) : [c]));
const at = (f: Pose, b: PoseBone, k: 0 | 1 | 2) => f[b]?.[k] ?? 0;
const stand = POSTURES.stand.bones as Pose;

describe("performCues", () => {
  it("composes great news into a whole performance: a wind-up, arms up, a bright face and eyes, then back to her", () => {
    const { cues, ms } = performCues(
      { feel: { valence: 0.9, arousal: 0.85, dominance: 0.4 } },
      stand,
    );
    const clip = clipOf(cues);
    const arm = clip.frames.map((f) => at(f, "leftUpperArm", 2));
    const top = Math.max(...arm);
    expect(top).toBeGreaterThan(0.3);
    // anticipation: the arm first dips below where it rests, before it rises
    expect(Math.min(...arm.slice(0, arm.indexOf(top)))).toBeLessThan(arm[0]! - 0.05);
    expect(arm.at(-1)).toBeCloseTo(arm[0]!, 2);
    expect(clip.lapseMs).toBe(ms + 100);
    const rest = timed(cues);
    expect(rest.some((c) => c.kind === "face" && (c.weights.happy ?? 0) > 0.6)).toBe(true);
    expect(rest.some((c) => c.kind === "gaze" && c.y > 0)).toBe(true);
  });

  it("is a function of the feeling, not a list: exhaustion sinks where joy rises, and a sit keeps its legs", () => {
    const drained: Perform = { feel: { valence: -0.5, arousal: -0.9, dominance: -0.4 } };
    const sit = POSTURES.sit as { bones: Pose };
    const clip = clipOf(performCues(drained, sit.bones, true).cues);
    expect(Math.max(...clip.frames.map((f) => at(f, "spine", 0)))).toBeGreaterThan(
      at(sit.bones, "spine", 0) + 0.05,
    );
    expect(Math.max(...clip.frames.map((f) => at(f, "head", 0)))).toBeGreaterThan(0.1);
    for (const f of clip.frames) expect(f.leftUpperLeg).toEqual(sit.bones.leftUpperLeg);
    // a crouch is sinking with energy: the knees bend when standing
    const creep = clipOf(
      performCues({ feel: { valence: 0.2, arousal: 0.4, dominance: 0.3 }, shape: { rise: -0.8 } })
        .cues,
    );
    expect(Math.max(...creep.frames.map((f) => at(f, "leftLowerLeg", 0)))).toBeGreaterThan(0.6);
  });

  it("trembles in fear as a person does: a fine quiver at the hands only, under a degree", () => {
    const clip = clipOf(
      performCues({ feel: { valence: -0.9, arousal: 0.9, dominance: -0.9 }, ms: 6000 }, stand).cues,
    );
    // the hold, where the tremor runs: no frame-to-frame jump at the hands beyond a 0.7 degree quiver at 11 Hz
    const hold = clip.frames.slice(60, 150);
    for (let i = 1; i < hold.length; i++)
      for (const b of ["leftHand", "rightHand"] as const)
        expect(Math.abs(at(hold[i]!, b, 2) - at(hold[i - 1]!, b, 2))).toBeLessThan(0.025);
    // the forearms do not buzz
    const fore = hold.map((f) => at(f, "leftLowerArm", 1));
    expect(Math.max(...fore) - Math.min(...fore)).toBeLessThan(0.02);
  });

  it("keeps every joint within human speed for any feeling and effort", () => {
    const vals = [-1, 0, 1];
    for (const v of vals)
      for (const a of vals)
        for (const time of vals)
          for (const weight of vals) {
            const clip = clipOf(
              performCues(
                {
                  feel: { valence: v, arousal: a, dominance: v },
                  effort: { time, weight, flow: -1 },
                  intensity: 1,
                },
                stand,
              ).cues,
            );
            expect(speedRatio(clip.frames, clip.fps)).toBeLessThanOrEqual(1);
          }
  });

  it("leaves the parts the agent placed itself as placed, and moves the rest", () => {
    const keys = [
      { atMs: 0, bones: { rightUpperArm: [0, 0, 1.2] as Euler } },
      { atMs: 800, bones: { rightUpperArm: [0, 1.2, 0.2] as Euler } },
    ];
    const clip = clipOf(
      performCues({ feel: { valence: 0.9, arousal: 0.85, dominance: 0.4 } }, stand, false, "p", {
        keys,
      }).cues,
    );
    expect(clip.frames.at(-1)!.rightUpperArm).toEqual([0, 1.2, 0.2]);
    expect(Math.max(...clip.frames.map((f) => at(f, "leftUpperArm", 2)))).toBeGreaterThan(0.3);
  });
});

describe("decodeHold", () => {
  it("holds what a person can, as long as a person can, and never a reflex", () => {
    expect(decodeHold({ breath: 90_000, blink: 2000 })).toEqual({
      ok: true,
      hold: { breath: 30_000, blink: 2000 },
    });
    expect(decodeHold({ startle: 500 })).toMatchObject({ ok: false });
    expect(decodeHold({ yawn: 500 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/breath/),
    });
  });
});
