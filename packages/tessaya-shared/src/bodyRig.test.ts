import { describe, expect, it } from "vite-plus/test";

import { POSTURES, danceAt } from "./bodyMotion.ts";
import {
  JOINT_LIMITS,
  QI,
  clampJoint,
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
      for (const end of ["leftHand", "rightHand", "leftFoot", "rightFoot"])
        expect(near(before[end]!, after[end]!, 0.02)).toBe(true);
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
  });
});
