import { describe, expect, it } from "vite-plus/test";

import { POSTURES, danceAt } from "./bodyMotion.ts";
import {
  JOINT_LIMITS,
  REFERENCE_RIG,
  dot,
  v3,
  QI,
  clampJoint,
  fitProxies,
  proxiesByHeight,
  fk,
  makeRig,
  manifestOf,
  preparePose,
  qAngle,
  qFromEuler,
  qMul,
  qToEuler,
  qFromVec,
  qRotate,
  len,
  settled,
  softContacts,
  springStep,
  swingTwist,
  type Q,
  type RigBone,
  type V3,
} from "./bodyRig.ts";

const P: Record<string, string | null> = {
  hips: null,
  spine: "hips",
  chest: "spine",
  upperChest: "chest",
  neck: "upperChest",
  head: "neck",
  leftShoulder: "upperChest",
  leftUpperArm: "leftShoulder",
  leftLowerArm: "leftUpperArm",
  leftHand: "leftLowerArm",
  rightShoulder: "upperChest",
  rightUpperArm: "rightShoulder",
  rightLowerArm: "rightUpperArm",
  rightHand: "rightLowerArm",
  leftUpperLeg: "hips",
  leftLowerLeg: "leftUpperLeg",
  leftFoot: "leftLowerLeg",
  leftToes: "leftFoot",
  rightUpperLeg: "hips",
  rightLowerLeg: "rightUpperLeg",
  rightFoot: "rightLowerLeg",
  rightToes: "rightFoot",
};
// a 1.6 m T-pose rig in VRM 1.0 axes: she faces +z, her left is +x
const AT: Record<string, V3> = {
  hips: [0, 0.95, 0],
  spine: [0, 1.02, 0],
  chest: [0, 1.12, 0],
  upperChest: [0, 1.22, 0],
  neck: [0, 1.36, 0],
  head: [0, 1.44, 0],
  leftShoulder: [0.04, 1.32, 0],
  leftUpperArm: [0.12, 1.33, 0],
  leftLowerArm: [0.37, 1.33, 0],
  leftHand: [0.61, 1.33, 0],
  leftUpperLeg: [0.08, 0.88, 0],
  leftLowerLeg: [0.09, 0.48, 0.01],
  leftFoot: [0.09, 0.07, 0],
  leftToes: [0.09, 0.02, 0.12],
};
for (const [k, v] of Object.entries({ ...AT }))
  if (k.startsWith("left")) AT[k.replace("left", "right")] = [-v[0], v[1], v[2]];
const bonesOf = (names: ReadonlyArray<string>, at = AT): RigBone[] =>
  names.map((name) => {
    let parent = P[name] ?? null;
    while (parent !== null && !names.includes(parent)) parent = P[parent] ?? null;
    return { name, parent, rest: at[name]! };
  });
const vroid = makeRig(bonesOf(Object.keys(AT)));
const minimal = makeRig(
  bonesOf(Object.keys(AT).filter((b) => !/upperChest|chest|neck|Shoulder|Toes/.test(b))),
);
// a rich rig: every finger, forearm twist bones and the full spine
const fingers = (["left", "right"] as const).flatMap((s) =>
  ["Thumb", "Index", "Middle", "Ring", "Little"].flatMap((f, i) =>
    (f === "Thumb"
      ? ["Metacarpal", "Proximal", "Distal"]
      : ["Proximal", "Intermediate", "Distal"]
    ).map((p, j) => {
      const sx = s === "left" ? 1 : -1;
      return {
        name: `${s}${f}${p}`,
        parent:
          j === 0
            ? `${s}Hand`
            : `${s}${f}${f === "Thumb" ? ["Metacarpal", "Proximal"][j - 1] : ["Proximal", "Intermediate"][j - 1]}`,
        rest: [sx * (0.66 + 0.03 * j), 1.33, 0.03 - 0.015 * i] as V3,
      };
    }),
  ),
);
const rich = makeRig([
  ...bonesOf(Object.keys(AT)),
  ...fingers,
  { name: "leftForearmTwist", parent: "leftLowerArm", rest: [0.49, 1.33, 0] },
  { name: "rightForearmTwist", parent: "rightLowerArm", rest: [-0.49, 1.33, 0] },
  { name: "J_Sec_L_Bust1", parent: "upperChest", rest: [0.06, 1.22, 0.08] },
]);
// the same body resting in an A-pose: arms 0.6 rad below horizontal
const drop = 0.6;
const aAt = { ...AT };
for (const s of [1, -1]) {
  const side = s === 1 ? "left" : "right";
  const root = AT[`${side}UpperArm`]!;
  for (const [b, d] of [
    [`${side}LowerArm`, 0.25],
    [`${side}Hand`, 0.49],
  ] as const)
    aAt[b] = [root[0] + s * d * Math.cos(drop), root[1] - d * Math.sin(drop), 0];
}
const aPose = makeRig(bonesOf(Object.keys(AT), aAt));

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const near = (a: V3, b: V3, tol = 0.01) => len([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) < tol;

describe("quaternions", () => {
  it("round-trips Euler XYZ and splits swing from twist", () => {
    for (const e of [
      [0.3, -0.7, 1.1],
      [-1.2, 0.4, -0.2],
      [0, 0, 1.2],
    ] as V3[]) {
      expect(qAngle(qFromEuler(qToEuler(qFromEuler(e))), qFromEuler(e))).toBeLessThan(1e-6);
      const q = qFromEuler(e);
      const { swing, twist } = swingTwist(q, [1, 0, 0]);
      expect(Math.abs(swing[0])).toBeLessThan(1e-6);
      expect(qAngle(qMul(qFromVec(swing), qFromVec([twist, 0, 0])), q)).toBeLessThan(1e-6);
    }
  });
});

describe("joint limits", () => {
  it("leaves a joint in range alone and holds a hyperextended knee, reporting by how much", () => {
    expect(clampJoint("leftLowerLeg", qFromEuler([1.2, 0, 0])).issues).toEqual([]);
    const bad = clampJoint("leftLowerLeg", qFromEuler([-0.7, 0, 0]));
    expect(bad.issues).toEqual([
      { bone: "leftLowerLeg", kind: "reversal", by: expect.closeTo(0.68, 1) },
    ]);
    expect(qAngle(bad.q, qFromEuler([-0.02, 0, 0]))).toBeLessThan(1e-3);
  });
  it("mirrors every left limit onto the right", () => {
    for (const k of Object.keys(JOINT_LIMITS).filter((k) => k.startsWith("left")))
      expect(JOINT_LIMITS[k.replace("left", "right")]).toBeDefined();
    // the same bend, mirrored (x, -y, -z), is legal on both sides or on neither
    expect(clampJoint("rightUpperArm", qFromEuler([0, 0, 1.2])).issues).toEqual([]);
    expect(clampJoint("leftUpperArm", qFromEuler([0, 0, -1.2])).issues).toEqual([]);
  });
});

describe("preparePose", () => {
  it("keeps every authored posture and dance frame where it put her hands and feet, with legal joints", () => {
    const frames = [
      ...Object.values(POSTURES).map((p) => p.bones),
      ...[0, 300, 600, 900].map((t) => danceAt(t)),
    ];
    for (const bones of frames) {
      const raw = Object.fromEntries(
        Object.entries(bones).map(([b, e]) => [b, qFromEuler(e as V3)]),
      ) as Record<string, Q>;
      const out = preparePose(vroid, bones);
      const before = fk(vroid, raw).pos;
      const after = fk(vroid, out.pose).pos;
      // a hand the rig moved out of her body (a reported penetration) may move by that much more
      for (const end of ["leftHand", "rightHand", "leftFoot", "rightFoot"]) {
        const pushed = out.issues.find((i) => i.bone === end && i.kind === "penetration");
        // a raised arm's shoulder lifts with it (scapulohumeral rhythm), carrying the hand a few cm
        const side = end.startsWith("left") ? "left" : "right";
        const lifted =
          /Hand/.test(end) &&
          !(`${side}Shoulder` in bones) &&
          out.pose[`${side}Shoulder`] !== undefined;
        expect(
          near(
            before[end]!,
            after[end]!,
            0.02 + (pushed ? pushed.by + 0.02 : 0) + (lifted ? 0.05 : 0),
          ),
        ).toBe(true);
      }
      // prepared once, it is already right
      const again = preparePose(
        vroid,
        Object.fromEntries(Object.entries(out.pose).map(([b, q]) => [b, qToEuler(q)])),
      );
      expect(again.issues.filter((i) => i.kind === "reversal" || i.kind === "sideBend")).toEqual(
        [],
      );
    }
  });
  it("bends an elbow written backwards the way an elbow goes, hand where it was", () => {
    const out = preparePose(vroid, { leftUpperArm: [0, 0, -1.2], leftLowerArm: [0, 0.9, 0] });
    expect(out.issues.map((i) => [i.bone, i.kind])).toContainEqual(["leftLowerArm", "reversal"]);
    const elbow = swingTwist(out.pose["leftLowerArm"]!, [1, 0, 0]).swing;
    expect(elbow[1]).toBeLessThanOrEqual(0.03);
    expect(Math.abs(elbow[2])).toBeLessThan(0.13);
  });
  it("rests a hand on her body instead of inside it, and says so", () => {
    // a hand on her hip, authored a little inside her: it ends on the surface, the arm re-solved to reach it
    const out = preparePose(vroid, POSTURES.teasing.bones);
    expect(out.issues.map((i) => [i.bone, i.kind])).toContainEqual(["leftHand", "penetration"]);
    const world = fk(vroid, out.pose);
    const w = world.pos;
    const hand = w["leftHand"]!;
    // and the skin under it gives a little
    expect(softContacts(vroid, w).some((c) => c.depth > 0 && len(sub3(c.at, hand)) < 0.15)).toBe(
      true,
    );
    const axisX = w["hips"]![0];
    expect(Math.hypot(hand[0] - axisX, hand[2] - w["hips"]![2])).toBeGreaterThan(
      0.075 * vroid.height,
    );
  });
  it("lets an arm hang relaxed beside her clothed hips, its forearm turned as written (no A-pose)", () => {
    // a clothed model as fitted (a puffy top and a flared skirt count as thickness): her hand presses into the cloth
    // at her side, which gives, so the arm is not pushed out into an A-pose, and the palm stays toward her thigh
    const clothed = {
      ...vroid,
      proxies: { trunk: 0.107, head: 0.09, thigh: 0.072, forearm: 0.024 },
    };
    const hang = {
      leftUpperArm: [0, 0, -1.42] as V3,
      leftLowerArm: [0.6, -0.1, 0] as V3,
      rightUpperArm: [0, 0, 1.42] as V3,
      rightLowerArm: [0.6, 0.1, 0] as V3,
    };
    const out = preparePose(clothed, hang);
    const w = fk(clothed, out.pose).pos;
    for (const side of ["left", "right"] as const) {
      const v = sub3(w[`${side}LowerArm`]!, w[`${side}UpperArm`]!);
      const fromHanging = (Math.acos(-v[1] / len(v)) * 180) / Math.PI;
      expect(fromHanging).toBeLessThan(15);
    }
    expect(out.issues.filter((i) => i.kind === "penetration")).toEqual([]);
    // pushed into her on purpose, the re-solved forearm still carries its twist
    const pushed = preparePose(clothed, { ...hang, leftUpperArm: [0, 0, -1.57] as V3 });
    expect(swingTwist(pushed.pose["leftLowerArm"]!, [1, 0, 0]).twist).toBeCloseTo(0.6, 1);
  });

  it("crosses her legs beside or in front of each other, never through, and says so", () => {
    const crossed = {
      ...POSTURES.stand.bones,
      leftUpperLeg: [0, 0, -0.35] as V3,
      rightUpperLeg: [0, 0, 0.1] as V3,
    };
    const out = preparePose(vroid, crossed);
    expect(out.issues.some((i) => /Foot$/.test(i.bone) && i.kind === "penetration")).toBe(true);
    const w = fk(vroid, out.pose).pos;
    const gap = (a: V3, b: V3, c: V3, d: V3) => {
      let best = Infinity;
      for (let i = 0; i <= 10; i++)
        for (let j = 0; j <= 10; j++) {
          const p = a.map((x, k) => x + ((b[k]! - x) * i) / 10);
          const q = c.map((x, k) => x + ((d[k]! - x) * j) / 10);
          best = Math.min(best, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!));
        }
      return best;
    };
    const thigh = 0.038 * vroid.height;
    const shin = 0.026 * vroid.height;
    const L = (b: string) => w[`left${b}`]!;
    const R = (b: string) => w[`right${b}`]!;
    expect(gap(L("UpperLeg"), L("LowerLeg"), R("UpperLeg"), R("LowerLeg"))).toBeGreaterThan(
      2 * thigh - 0.01,
    );
    expect(gap(L("LowerLeg"), L("Foot"), R("LowerLeg"), R("Foot"))).toBeGreaterThan(
      2 * shin - 0.01,
    );
    expect(gap(L("UpperLeg"), L("LowerLeg"), R("LowerLeg"), R("Foot"))).toBeGreaterThan(
      thigh + shin - 0.01,
    );
    // legs apart are left exactly as posed
    expect(preparePose(vroid, POSTURES.stand.bones).issues.some((i) => /Foot$/.test(i.bone))).toBe(
      false,
    );
    // where they now meet, the skin gives; standing apart, nothing does
    const between = softContacts(vroid, w);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((c) => c.at[1] < w["hips"]![1] && c.depth > 0)).toBe(true);
    expect(
      softContacts(vroid, fk(vroid, preparePose(vroid, POSTURES.stand.bones).pose).pos),
    ).toEqual([]);
  });
  it("lifts the shoulder with a raised arm, a third past 30°, and leaves a lowered arm's shoulder alone", () => {
    const up = preparePose(vroid, { rightUpperArm: [0, 0, -0.3] });
    const lift = swingTwist(up.pose["rightShoulder"]!, [1, 0, 0]).swing[2];
    expect(lift).toBeLessThan(-0.2);
    // the arm still points where the pose put it
    const w = fk(vroid, up.pose);
    const dir = qRotate(w.rot["rightUpperArm"]!, [-1, 0, 0]);
    const want = qRotate(qFromEuler([0, 0, -0.3]), [-1, 0, 0]);
    expect(near(dir, want, 0.01)).toBe(true);
    expect(
      preparePose(vroid, { rightUpperArm: [0, 0, 1.2] }).pose["rightShoulder"],
    ).toBeUndefined();
    // no shoulder bone, no coupling and no error
    expect(
      preparePose(minimal, { rightUpperArm: [0, 0, -0.3] }).pose["rightShoulder"],
    ).toBeUndefined();
  });
  it("drops unknown and non-finite bones and names them", () => {
    const out = preparePose(vroid, {
      head: [Number.NaN, 0, 0],
      tailWag: [0, 1, 0],
      neck: [0.2, 0, 0],
    });
    expect(out.issues).toEqual([
      { bone: "head", kind: "nonFinite", by: 0 },
      { bone: "tailWag", kind: "unknown", by: 0 },
    ]);
    expect(out.pose["neck"]).toBeDefined();
  });
  it("gives the same arm on an A-pose model as on a T-pose one", () => {
    const pose = { leftUpperArm: [0, 0, -1.2] as V3, leftLowerArm: [0, -0.4, 0] as V3 };
    const dir = (rig: typeof vroid) => {
      const w = fk(rig, preparePose(rig, pose).pose);
      const d = w.pos["leftHand"]!.map((v, i) => v - w.pos["leftUpperArm"]![i]!) as unknown as V3;
      return d.map((v) => v / len(d)) as unknown as V3;
    };
    expect(aPose.restFix["leftUpperArm"]).toBeDefined();
    expect(near(dir(aPose), dir(vroid), 0.03)).toBe(true);
  });
  it("runs one pose on a minimal, a VRoid and a rich rig without errors, richer where bones allow", () => {
    const lean = {
      spine: [0.3, 0, 0.1] as V3,
      head: [0.1, 0.2, 0] as V3,
      leftUpperArm: [0, -0.4, -1.1] as V3,
    };
    for (const rig of [minimal, vroid, rich]) {
      const out = preparePose(rig, lean);
      expect(out.issues.filter((i) => i.kind === "unknown")).toEqual([]);
      // the head ends up tilted forward by about the same amount whichever spine it has
      const w = fk(rig, out.pose);
      const up = qRotate(w.rot["head"]!, [0, 1, 0]);
      expect(up[2]).toBeGreaterThan(0.25);
    }
    // a three-bone spine shares the bend; a one-bone spine takes it all
    expect(qAngle(preparePose(rich, lean).pose["chest"]!, QI)).toBeGreaterThan(0.05);
    expect(qAngle(preparePose(minimal, lean).pose["spine"]!, QI)).toBeCloseTo(0.316, 2);
  });
});

describe("manifest", () => {
  it("reads what each body can do", () => {
    expect(manifestOf(minimal)).toMatchObject({
      tier: "minimal",
      spineSegments: 1,
      fingers: "none",
    });
    expect(manifestOf(vroid)).toMatchObject({ tier: "standard", spineSegments: 3, toes: true });
    expect(manifestOf(rich)).toMatchObject({
      tier: "rich",
      fingers: "full",
      extras: { twist: ["leftForearmTwist", "rightForearmTwist"], breast: ["J_Sec_L_Bust1"] },
    });
    expect(manifestOf(aPose).armRestDrop).toBeCloseTo(drop, 2);
  });
});

describe("springStep", () => {
  it("settles on the goal without overshoot and bends, not restarts, when the goal moves", () => {
    const goal = qFromEuler([0, 0, 1.2]);
    let s = { q: QI, w: [0, 0, 0] as V3 };
    let last = qAngle(s.q, goal);
    for (let i = 0; i < 60; i++) {
      s = springStep(s, goal, 110, 1000 / 60);
      const now = qAngle(s.q, goal);
      expect(now).toBeLessThanOrEqual(last + 1e-9);
      last = now;
    }
    expect(last).toBeLessThan(0.002);
    // halfway to one goal, a new one: the motion carries its speed into the turn
    s = { q: QI, w: [0, 0, 0] };
    for (let i = 0; i < 8; i++) s = springStep(s, goal, 110, 1000 / 60);
    const speed = len(s.w);
    const next = springStep(s, qFromEuler([0.8, 0, 0]), 110, 1000 / 60);
    expect(len(next.w)).toBeGreaterThan(speed * 0.5);
    // a move starts without a kick: its first frame's acceleration is a fraction of its peak (minimum-jerk onset)
    let r = { q: QI, w: [0, 0, 0] as V3 };
    const acc: number[] = [];
    for (let i = 0; i < 30; i++) {
      const was = len(r.w);
      r = springStep(r, goal, 210, 1000 / 60);
      acc.push((len(r.w) - was) * 60);
    }
    expect(acc[0]!).toBeLessThan(0.35 * Math.max(...acc));
    // at rest it sleeps: a settled bone stepped at its goal stays settled and still, so nothing ticks between blinks
    let rest = { q: goal, w: [0, 0, 0] as V3 };
    for (let i = 0; i < 600; i++) rest = springStep(rest, goal, 210, 1000 / 60);
    expect(settled(rest, goal)).toBe(true);
    expect(qAngle(rest.q, goal)).toBeLessThan(1e-9);
  });
});

describe("fitProxies", () => {
  it("fits each part's thickness to the model's own skin, and keeps her height's share where it has too little", () => {
    const ring = (bone: string, a: V3, b: V3, r: number) =>
      Array.from({ length: 60 }, (_, i) => {
        const t = (i % 10) / 10;
        const ang = (i / 60) * Math.PI * 2;
        return {
          bone,
          p: [
            a[0] + (b[0] - a[0]) * t + r * Math.cos(ang),
            a[1] + (b[1] - a[1]) * t,
            a[2] + r * Math.sin(ang),
          ] as V3,
        };
      });
    const fitted = fitProxies(vroid, [
      ...ring("leftUpperLeg", AT["leftUpperLeg"]!, AT["leftLowerLeg"]!, 0.07),
      ...ring("spine", AT["hips"]!, AT["upperChest"]!, 0.1),
    ]);
    expect(fitted.thigh).toBeCloseTo(0.07, 2);
    expect(fitted.trunk).toBeCloseTo(0.1, 2);
    expect(fitted.head).toBe(proxiesByHeight(vroid.height).head);
    // a model with fuller hips moves a resting hand further out than a slim one
    const hand = (proxies: typeof fitted) => {
      const rig = { ...vroid, proxies };
      const w = fk(rig, preparePose(rig, POSTURES.teasing.bones).pose).pos;
      return Math.hypot(w["leftHand"]![0] - w["hips"]![0], w["leftHand"]![2] - w["hips"]![2]);
    };
    expect(hand({ ...fitted, trunk: 0.14 })).toBeGreaterThan(
      hand({ ...fitted, trunk: 0.09 }) + 0.03,
    );
  });
});

/**
 * Frames the offline MuJoCo checker (tessaya-ops/physics-spike/check.py) failed in her motion library, each at its
 * deepest overlap: a hand inside her head, forearms through each other, a hand on the hip inside the pelvis. Measured
 * with the checker's own capsules (a tapered forearm, a flat hand along its bone, the head a ball above its joint).
 */
const CHECKER_FRAMES: ReadonlyArray<
  readonly [string, number, Record<string, [number, number, number]>]
> = [
  [
    "scared-noise:neck-right_elbow",
    7.0,
    {
      leftUpperArm: [0.328, -0.647, -1.081],
      rightUpperArm: [-1.447, 0.413, 1.902],
      leftLowerArm: [-3.14, -0.845, -3.14],
      rightLowerArm: [-3.14, 0.822, 3.14],
      spine: [-0.026, 0, 0.004],
      chest: [0.014, 0, 0],
      upperChest: [0, 0, 0],
      neck: [0, 0, 0],
      head: [0.021, 0, 0],
      leftShoulder: [0, -0.055, 0.064],
      leftHand: [0, 0, 0.067],
      leftUpperLeg: [0, 0, 0],
      leftLowerLeg: [0, 0, 0],
      leftFoot: [0, 0, 0],
      rightShoulder: [0, 0.055, -0.064],
      rightHand: [0, 0, -0.069],
      rightUpperLeg: [0, 0, 0],
      rightLowerLeg: [0, 0, 0],
      rightFoot: [0, 0, 0],
      hips: [0, 0, -0.006],
    },
  ],
  [
    "hot-drink:left_elbow-neck",
    6.4,
    {
      leftUpperArm: [-1.447, -0.413, -1.902],
      rightUpperArm: [-0.3, 0.564, 1.394],
      leftLowerArm: [-3.14, -0.826, -3.14],
      rightLowerArm: [3.14, 1.568, 3.14],
      spine: [0.008, 0, 0],
      chest: [0.009, 0, 0],
      upperChest: [-0.006, 0, 0],
      neck: [-0.008, 0, 0],
      head: [-0.018, 0, 0],
      leftShoulder: [0, 0.005, 0],
      leftHand: [0, 0, 0],
      leftUpperLeg: [0, 0, 0],
      leftLowerLeg: [0, 0, 0],
      leftFoot: [0, 0, 0],
      rightShoulder: [0, -0.005, 0],
      rightHand: [0, 0, 0],
      rightUpperLeg: [0, 0, 0],
      rightLowerLeg: [0, 0, 0],
      rightFoot: [0, 0, 0],
    },
  ],
  [
    "cold:left_elbow-right_elbow",
    6.4,
    {
      leftUpperLeg: [-1.5, 0, 0],
      rightUpperLeg: [-1.5, 0, 0],
      leftLowerLeg: [2.85, 0, 0],
      rightLowerLeg: [2.85, 0, 0],
      leftFoot: [0.6, 0, 0],
      rightFoot: [0.6, 0, 0],
      leftUpperArm: [-0.367, -0.761, -1.439],
      rightUpperArm: [-0.367, 0.761, 1.439],
      leftLowerArm: [0, -1.134, 0],
      rightLowerArm: [0, 1.134, 0],
      spine: [0.019, 0, -0.003],
      chest: [-0.042, 0, 0],
      upperChest: [0, 0, 0],
      neck: [0, 0, 0],
      head: [0.011, 0, 0],
      leftShoulder: [0, -0.029, 0.02],
      leftHand: [0, 0, 0.004],
      rightShoulder: [0, 0.029, -0.02],
      rightHand: [0, 0, -0.004],
      hips: [0, 0, 0.004],
    },
  ],
  [
    "proud:pelvis-right_elbow",
    4.8,
    {
      leftUpperArm: [1.571, -0.723, 0],
      rightUpperArm: [1.571, 0.723, 0],
      leftLowerArm: [0, -1.529, 0],
      rightLowerArm: [0, 1.529, 0],
      spine: [-0.015, 0, 0],
      chest: [-0.045, 0, 0],
      upperChest: [-0.028, 0, 0],
      neck: [-0.035, 0, 0],
      head: [-0.082, 0, 0],
      leftShoulder: [0, 0.036, 0],
      leftHand: [0, 0, 0],
      leftUpperLeg: [-0.032, 0, 0],
      leftLowerLeg: [0.058, 0, 0],
      leftFoot: [-0.026, 0, 0],
      rightShoulder: [0, -0.036, 0],
      rightHand: [0, 0, 0],
      rightUpperLeg: [-0.032, 0, 0],
      rightLowerLeg: [0.058, 0, 0],
      rightFoot: [-0.026, 0, 0],
    },
  ],
  [
    "disappointed:left_elbow-pelvis",
    5.4,
    {
      leftUpperArm: [1.269, -0.827, -0.258],
      rightUpperArm: [0, 0.22, 1.256],
      leftLowerArm: [0, -1.492, 0],
      rightLowerArm: [0, 0.496, 0],
      leftShoulder: [0, -0.018, 0.095],
      rightShoulder: [0, 0.018, -0.095],
      spine: [0.139, 0, 0],
      chest: [0.102, 0, 0],
      head: [0.376, 0, 0],
      upperChest: [0.015, 0, 0],
      neck: [0.025, 0, 0],
      leftHand: [0, 0, 0.018],
      leftUpperLeg: [-0.022, 0, 0],
      leftLowerLeg: [0.041, 0, 0],
      leftFoot: [0, 0, 0],
      rightHand: [0, 0, -0.018],
      rightUpperLeg: [-0.022, 0, 0],
      rightLowerLeg: [0.041, 0, 0],
      rightFoot: [0, 0, 0],
    },
  ],
];
const checkerDepth = (pair: string, pose: Record<string, Q>): number => {
  const w = fk(REFERENCE_RIG, pose);
  const p = (b: string) => w.pos[b]!;
  type Part = { readonly a: V3; readonly b: V3; readonly r: number };
  const ball = (c: V3, r: number): Part => ({ a: c, b: c, r });
  const arm = (s: "left" | "right"): Part[] => {
    const e = p(`${s}LowerArm`);
    const h = p(`${s}Hand`);
    const mid = v3.add(e, v3.scale(v3.sub(h, e), 0.55));
    // the open hand: flat, wrist to fingertips along the hand bone
    const tip = v3.add(h, qRotate(w.rot[`${s}Hand`]!, [s === "left" ? 0.14 : -0.14, 0, 0]));
    return [
      { a: e, b: mid, r: 0.034 },
      { a: mid, b: h, r: 0.026 },
      { a: h, b: tip, r: 0.02 },
    ];
  };
  const parts: Record<string, Part[]> = {
    left_elbow: arm("left"),
    right_elbow: arm("right"),
    neck: [
      { a: p("neck"), b: p("head"), r: 0.045 },
      ball(v3.add(p("head"), qRotate(w.rot["head"]!, [0, 0.03, 0.02])), 0.1),
    ],
    pelvis: [
      { a: p("leftUpperLeg"), b: p("rightUpperLeg"), r: 0.08 },
      { a: p("hips"), b: p("spine"), r: 0.09 },
    ],
  };
  const [x, y] = pair.split("-");
  const seg = (s: Part, q: V3) => {
    const d = v3.sub(s.b, s.a);
    const t = Math.max(0, Math.min(1, dot(v3.sub(q, s.a), d) / Math.max(1e-12, dot(d, d))));
    return v3.add(s.a, v3.scale(d, t));
  };
  let deepest = 0;
  for (const [i, s] of parts[x!]!.entries())
    for (const [j, t] of parts[y!]!.entries()) {
      // the checker lets hand balls touch each other (a clap)
      if (x!.endsWith("elbow") && y!.endsWith("elbow") && i === 2 && j === 2) continue;
      let a = v3.scale(v3.add(s.a, s.b), 0.5);
      let b = seg(t, a);
      for (let k = 0; k < 8; k++) {
        a = seg(s, b);
        b = seg(t, a);
      }
      deepest = Math.max(deepest, s.r + t.r - Math.hypot(...v3.sub(a, b)));
    }
  return deepest;
};

describe("self-contact on the checker's evidence", () => {
  it.each(CHECKER_FRAMES)(
    "%s: no part more than 3 cm inside another (was %s cm)",
    (label, _was, frame) => {
      const pair = label.split(":")[1]!;
      const { pose } = preparePose(REFERENCE_RIG, frame);
      expect(checkerDepth(pair, pose)).toBeLessThan(0.03);
    },
  );
});
