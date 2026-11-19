/**
 * The rig under every body (M-065): poses in VRM 1.0 normalized axes from a T-pose (she faces +z, her left is +x, Euler
 * XYZ) become joint rotations that stay human on any model: swing-twist limits, hinge elbows and knees, rotation spread
 * along whatever segments exist, and a critically damped spring per bone. Pure, so renderer, validator and tests share it.
 */

export type V3 = readonly [number, number, number];
/** x, y, z, w (three.js order). */
export type Q = readonly [number, number, number, number];
export const QI: Q = [0, 0, 0, 1];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l < 1e-9 ? [0, 0, 0] : scale(a, 1 / l);
};
export const v3 = { add, sub, scale, cross, unit };

export const qMul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qConj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q: Q): Q => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
/** The same rotation with w >= 0 (the short way round). */
const qAbs = (q: Q): Q => (q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);
export const qRotate = (q: Q, v: V3): V3 => {
  const u: V3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
};
/** Euler XYZ (three.js Quaternion.setFromEuler with order "XYZ"). */
export const qFromEuler = (e: V3): Q => {
  const [c1, c2, c3] = [Math.cos(e[0] / 2), Math.cos(e[1] / 2), Math.cos(e[2] / 2)];
  const [s1, s2, s3] = [Math.sin(e[0] / 2), Math.sin(e[1] / 2), Math.sin(e[2] / 2)];
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
};
/** Back to Euler XYZ (three.js Euler.setFromQuaternion, order "XYZ"). */
export const qToEuler = (q: Q): V3 => {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  return Math.abs(m13) < 0.9999999
    ? [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)]
    : [Math.atan2(m32, m22), ey, 0];
};
/** Rotation vector (axis times angle) and back: the log and exp the spring and the limits work in. */
export const qToVec = (q: Q): V3 => {
  const a = qAbs(q);
  const s = Math.hypot(a[0], a[1], a[2]);
  if (s < 1e-9) return [2 * a[0], 2 * a[1], 2 * a[2]];
  const angle = 2 * Math.atan2(s, a[3]);
  return scale([a[0], a[1], a[2]], angle / s);
};
export const qFromVec = (r: V3): Q => {
  const angle = len(r);
  if (angle < 1e-9) return qNorm([r[0] / 2, r[1] / 2, r[2] / 2, 1]);
  const s = Math.sin(angle / 2) / angle;
  return [r[0] * s, r[1] * s, r[2] * s, Math.cos(angle / 2)];
};
/** The angle between two rotations (radians, 0..π). */
export const qAngle = (a: Q, b: Q) => len(qToVec(qMul(a, qConj(b))));
export const qSlerp = (a: Q, b: Q, t: number): Q =>
  qMul(qFromVec(scale(qToVec(qMul(b, qConj(a))), t)), a);
/** The smallest rotation taking unit vector `a` onto unit vector `b`. */
export const qBetween = (a: V3, b: V3): Q => {
  const d = dot(a, b);
  if (d < -0.999999) {
    const ortho = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
    const o = unit(ortho);
    return [o[0], o[1], o[2], 0];
  }
  const c = cross(a, b);
  return qNorm([c[0], c[1], c[2], 1 + d]);
};
/** q = swing · twist, with twist about `axis` (unit): the twist angle and the swing as a rotation vector. */
export const swingTwist = (q: Q, axis: V3): { swing: V3; twist: number } => {
  const a = qAbs(q);
  const p = dot([a[0], a[1], a[2]], axis);
  const twistQ: Q =
    Math.abs(p) < 1e-9 && Math.abs(a[3]) < 1e-9
      ? QI
      : qNorm([axis[0] * p, axis[1] * p, axis[2] * p, a[3]]);
  const twist = 2 * Math.atan2(p, twistQ[3] === 0 ? 1e-9 : Math.abs(a[3])) * Math.sign(a[3] || 1);
  return { swing: qToVec(qMul(a, qConj(twistQ))), twist };
};

/** Every VRM humanoid bone (1.0 names); `required` ones are in every VRM. */
export const HUMANOID_BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftEye",
  "rightEye",
  "jaw",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
  ...(["left", "right"] as const).flatMap((s) =>
    ["Thumb", "Index", "Middle", "Ring", "Little"].flatMap((f) =>
      (f === "Thumb"
        ? ["Metacarpal", "Proximal", "Distal"]
        : ["Proximal", "Intermediate", "Distal"]
      ).map((p) => `${s}${f}${p}`),
    ),
  ),
] as const;
export type HumanBone = (typeof HUMANOID_BONES)[number];
export const REQUIRED_BONES: ReadonlySet<string> = new Set([
  "hips",
  "spine",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
]);
const HUMAN: ReadonlySet<string> = new Set(HUMANOID_BONES);
export const isHumanBone = (b: string): b is HumanBone => HUMAN.has(b);

/** Extra (non-humanoid) bones by name: what each can add to her motion. One place for names, by pattern. */
export const EXTRA_ROLES = [
  { role: "twist", test: /twist|roll/i },
  { role: "breast", test: /breast|bust|oppai|mune/i },
  { role: "butt", test: /butt|glute|hip_?soft|shiri/i },
  { role: "belly", test: /belly|stomach|tummy/i },
  { role: "thigh", test: /thigh_?soft|futomomo/i },
  { role: "tongue", test: /tongue|bero/i },
  { role: "tail", test: /tail(?!.*(pony|twin))/i },
  { role: "ear", test: /(^|[^a-z])ear|mimi/i },
  { role: "hair", test: /hair|kami|ahoge|bangs|ponytail|twintail/i },
  { role: "cloth", test: /skirt|cloth|coat|ribbon|sleeve|cape|scarf|dress/i },
] as const;
export type ExtraRole = (typeof EXTRA_ROLES)[number]["role"];
export const extraRole = (name: string): ExtraRole | null =>
  /earring|pearl|hear|wear/i.test(name)
    ? null
    : (EXTRA_ROLES.find((r) => r.test.test(name))?.role ?? null);

/** The bones a body part's motion is spread over, top-down, in the order the model may have them. */
export const CHAINS = {
  spine: ["spine", "chest", "upperChest"],
  neck: ["neck", "head"],
} as const;

export interface RigBone {
  readonly name: string;
  readonly parent: string | null;
  /** World position at rest (metres, VRM 1.0 axes). */
  readonly rest: V3;
}
export interface Rig {
  readonly bones: Readonly<Record<string, RigBone>>;
  /** Top of the head above the soles at rest. */
  readonly height: number;
  /**
   * Per bone: the rotation from the T-pose this convention assumes to the model's own rest pose (an A-pose model's
   * arms rest lower). Poses are corrected by it, so the same numbers mean the same body on every model.
   */
  readonly restFix: Readonly<Record<string, Q>>;
  /** This model's own thickness (metres) where parts meet, fitted to its mesh (fitProxies); her height's share if not. */
  readonly proxies?: Proxies;
}

export interface Proxies {
  readonly trunk: number;
  readonly head: number;
  readonly thigh: number;
  readonly forearm: number;
}
/** Proxy sizes as shares of her height, for a model whose mesh was not measured. */
export const proxiesByHeight = (height: number): Proxies => ({
  trunk: 0.075 * height,
  head: 0.055 * height,
  thigh: 0.038 * height,
  forearm: 0.01 * height,
});
/** Which proxy a skinned vertex belongs to, by the bone that moves it most. */
const PROXY_OF: Readonly<Record<string, keyof Proxies>> = {
  hips: "trunk",
  spine: "trunk",
  chest: "trunk",
  upperChest: "trunk",
  neck: "head",
  head: "head",
  leftUpperLeg: "thigh",
  rightUpperLeg: "thigh",
  leftLowerArm: "forearm",
  rightLowerArm: "forearm",
};
const PROXY_SEGMENT: Readonly<Record<keyof Proxies, (side: string) => readonly [string, string]>> =
  {
    trunk: () => ["hips", "upperChest"],
    head: () => ["neck", "head"],
    thigh: (side) => [`${side}UpperLeg`, `${side}LowerLeg`],
    forearm: (side) => [`${side}LowerArm`, `${side}Hand`],
  };
/**
 * Proxy sizes fitted to this model's mesh at rest: for each part, how far its skin (and clothes) sit from its bone
 * line, taken at a high percentile so a hand rests on the surface rather than in it. `samples` are rest positions of
 * skinned vertices with the humanoid bone that moves each most; a part with too few keeps its share of her height.
 */
export const fitProxies = (
  rig: Rig,
  samples: ReadonlyArray<{ readonly bone: string; readonly p: V3 }>,
): Proxies => {
  const fallback = proxiesByHeight(rig.height);
  const dist: Record<keyof Proxies, number[]> = { trunk: [], head: [], thigh: [], forearm: [] };
  for (const { bone, p } of samples) {
    const part = PROXY_OF[bone];
    if (part === undefined) continue;
    const side = bone.startsWith("right") ? "right" : "left";
    const [from, to] = PROXY_SEGMENT[part](side);
    const a = rig.bones[from === "upperChest" && !rig.bones["upperChest"] ? "chest" : from]?.rest;
    const b = rig.bones[to]?.rest;
    if (a && b) dist[part].push(segPoint(a, b, p));
  }
  const pick = (part: keyof Proxies, pct: number) => {
    const d = dist[part].toSorted((x, y) => x - y);
    if (d.length < 20) return fallback[part];
    // never thinner than half, never fatter than twice, her height's share: a stray vertex can't break it
    const r = d[Math.floor(d.length * pct)]!;
    return Math.max(fallback[part] / 2, Math.min(fallback[part] * 2, r));
  };
  return {
    trunk: pick("trunk", 0.5),
    head: pick("head", 0.6),
    // the median: clothes are skinned to the trunk and thighs too (a puffy sweater, a skirt's flare), and their outer
    // surface is cloth a resting arm lies against, not body
    thigh: pick("thigh", 0.5),
    forearm: pick("forearm", 0.8),
  };
};

export interface RigManifest {
  readonly tier: "minimal" | "standard" | "rich";
  readonly humanoid: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly spineSegments: number;
  readonly neckSegments: number;
  readonly fingers: "none" | "partial" | "full";
  readonly toes: boolean;
  readonly eyes: boolean;
  readonly jaw: boolean;
  readonly extras: Readonly<Partial<Record<ExtraRole, ReadonlyArray<string>>>>;
  readonly expressions: ReadonlyArray<string>;
  /** Shape keys on its meshes, which direct control can drive by name. */
  readonly morphs: ReadonlyArray<string>;
  readonly springChains: number;
  /** Arms at rest below horizontal by this much (radians): an A-pose model, corrected by restFix. */
  readonly armRestDrop: number;
  /** Her thickness where parts meet (metres), fitted to the mesh when it was measured. */
  readonly proxies?: Proxies;
}

/** The T-pose direction each limb and trunk bone points along (to its child), in her own axes. */
const T_DIR: Readonly<Record<string, V3>> = {
  hips: [0, 1, 0],
  spine: [0, 1, 0],
  chest: [0, 1, 0],
  upperChest: [0, 1, 0],
  neck: [0, 1, 0],
  leftShoulder: [1, 0, 0],
  leftUpperArm: [1, 0, 0],
  leftLowerArm: [1, 0, 0],
  rightShoulder: [-1, 0, 0],
  rightUpperArm: [-1, 0, 0],
  rightLowerArm: [-1, 0, 0],
  leftUpperLeg: [0, -1, 0],
  leftLowerLeg: [0, -1, 0],
  rightUpperLeg: [0, -1, 0],
  rightLowerLeg: [0, -1, 0],
};
const CHILD: Readonly<Record<string, ReadonlyArray<string>>> = {
  hips: ["spine"],
  spine: ["chest", "upperChest", "neck"],
  chest: ["upperChest", "neck"],
  upperChest: ["neck"],
  neck: ["head"],
  leftShoulder: ["leftUpperArm"],
  leftUpperArm: ["leftLowerArm"],
  leftLowerArm: ["leftHand"],
  rightShoulder: ["rightUpperArm"],
  rightUpperArm: ["rightLowerArm"],
  rightLowerArm: ["rightHand"],
  leftUpperLeg: ["leftLowerLeg"],
  leftLowerLeg: ["leftFoot"],
  rightUpperLeg: ["rightLowerLeg"],
  rightLowerLeg: ["rightFoot"],
};

/**
 * A rig from the model's bones (humanoid by VRM name, any others by their own name) and its rest positions. Rest
 * corrections are measured only on the arms and legs, where an A-pose or a splayed rest changes what a pose means.
 */
export const makeRig = (bones: ReadonlyArray<RigBone>): Rig => {
  const map = Object.fromEntries(bones.map((b) => [b.name, b]));
  const restFix: Record<string, Q> = {};
  for (const [name, t] of Object.entries(T_DIR)) {
    // arms only: an A-pose changes what an arm pose means; a leg's own stance at rest is kept as it is
    if (!/Arm/.test(name)) continue;
    const b = map[name];
    const child = CHILD[name]?.map((c) => map[c]).find((c) => c !== undefined);
    if (b === undefined || child === undefined) continue;
    const d = unit(sub(child.rest, b.rest));
    // only a real lean from the T-pose, never noise on a model that already rests in it
    if (len(d) > 0 && Math.acos(Math.max(-1, Math.min(1, dot(d, t)))) > 0.1)
      restFix[name] = qBetween(t, d);
  }
  const ys = bones.map((b) => b.rest[1]);
  const head = map["head"]?.rest[1] ?? Math.max(...ys);
  const soles = Math.min(...ys);
  return { bones: map, height: Math.max(0.3, head - soles + 0.12), restFix };
};

export const manifestOf = (
  rig: Rig,
  extra: {
    readonly expressions?: ReadonlyArray<string>;
    readonly morphs?: ReadonlyArray<string>;
    readonly springChains?: number;
  } = {},
): RigManifest => {
  const names = Object.keys(rig.bones);
  const humanoid = names.filter(isHumanBone);
  const has = (b: string) => Object.hasOwn(rig.bones, b);
  const fingerBones = humanoid.filter((b) => /Thumb|Index|Middle|Ring|Little/.test(b));
  const extras: Partial<Record<ExtraRole, string[]>> = {};
  for (const n of names) {
    if (isHumanBone(n)) continue;
    const role = extraRole(n);
    if (role !== null) (extras[role] ??= []).push(n);
  }
  const spineSegments = CHAINS.spine.filter(has).length;
  const fingers = fingerBones.length === 0 ? "none" : fingerBones.length >= 30 ? "full" : "partial";
  const leftArm = rig.bones["leftUpperArm"];
  const leftFore = rig.bones["leftLowerArm"];
  const drop =
    leftArm && leftFore
      ? Math.atan2(
          leftArm.rest[1] - leftFore.rest[1],
          Math.abs(leftFore.rest[0] - leftArm.rest[0]) || 1e-6,
        )
      : 0;
  const rich = fingers === "full" && spineSegments >= 3 && (extras.twist?.length ?? 0) > 0;
  return {
    tier: rich ? "rich" : fingers === "none" && spineSegments <= 1 ? "minimal" : "standard",
    humanoid,
    missing: HUMANOID_BONES.filter((b) => !has(b)),
    spineSegments,
    neckSegments: CHAINS.neck.filter(has).length,
    fingers,
    toes: has("leftToes") || has("rightToes"),
    eyes: has("leftEye") || has("rightEye"),
    jaw: has("jaw"),
    extras,
    expressions: extra.expressions ?? [],
    morphs: extra.morphs ?? [],
    springChains: extra.springChains ?? 0,
    armRestDrop: Math.round(drop * 1000) / 1000,
    ...(rig.proxies === undefined ? {} : { proxies: rig.proxies }),
  };
};

/** A joint's range: twist about its bone axis, and swing as a rotation vector's parts along u and v (radians). */
export interface JointLimit {
  readonly axis: V3;
  readonly twist: readonly [number, number];
  readonly u: V3;
  readonly uRange: readonly [number, number];
  readonly v: V3;
  readonly vRange: readonly [number, number];
  /** Elbows and knees: the limb is re-solved as a hinge (one way only) before limits apply. */
  readonly hinge?: boolean;
}
const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const lim = (
  axis: V3,
  twist: readonly [number, number],
  u: V3,
  uRange: readonly [number, number],
  v: V3,
  vRange: readonly [number, number],
  hinge?: boolean,
): JointLimit => ({ axis, twist, u, uRange, v, vRange, ...(hinge ? { hinge } : {}) });
/** Her right side is her left mirrored through x = 0 (rotation vectors mirror as (x, -y, -z)). */
const mirror = (l: JointLimit): JointLimit => {
  const m = (a: V3): V3 => [a[0], -a[1], -a[2]];
  return { ...l, axis: m(l.axis), u: m(l.u), v: m(l.v) };
};
/**
 * Ranges a person's joints reach, in this convention (u, v are the swing's flex and side parts). Trunk bones flex
 * forward on +x and bend sideways on z; limbs swing on their own frames from the T-pose. Wide enough for every
 * authored posture, dance and gesture; tight where a joint can only go one way.
 */
const LEFT: Readonly<Record<string, JointLimit>> = {
  leftShoulder: lim(X, [-0.3, 0.3], Y, [-0.35, 0.35], Z, [-0.3, 0.5]),
  // the arm: down to the side (z -), up overhead (z +), forward (y -) and back (y +) as a rotation from the T-pose
  leftUpperArm: lim(X, [-1.6, 1.6], Y, [-1.9, 1.0], Z, [-1.65, 2.6]),
  // the elbow folds the forearm forward only (y -); pronation and supination as twist
  leftLowerArm: lim(X, [-1.6, 1.6], Y, [-2.7, 0.02], Z, [-0.12, 0.12], true),
  leftHand: lim(X, [-0.9, 0.9], Y, [-0.6, 0.6], Z, [-1.3, 1.3]),
  // the hip: forward (x -), back (x +), out to the side (z +), across (z -)
  leftUpperLeg: lim(Y, [-0.8, 0.8], X, [-2.3, 0.6], Z, [-0.5, 1.2]),
  // the knee folds the shin back only (x +)
  leftLowerLeg: lim(Y, [-0.35, 0.35], X, [-0.02, 2.9], Z, [-0.1, 0.1], true),
  leftFoot: lim(Z, [-0.5, 0.5], X, [-0.9, 1.0], Y, [-0.5, 0.5]),
  leftToes: lim(Z, [-0.1, 0.1], X, [-0.8, 0.8], Y, [-0.1, 0.1]),
  leftEye: lim(Z, [0, 0], X, [-0.45, 0.45], Y, [-0.6, 0.6]),
};
export const JOINT_LIMITS: Readonly<Record<string, JointLimit>> = {
  hips: lim(Y, [-Math.PI, Math.PI], X, [-Math.PI, Math.PI], Z, [-Math.PI, Math.PI]),
  spine: lim(Y, [-0.6, 0.6], X, [-0.8, 0.5], Z, [-0.5, 0.5]),
  chest: lim(Y, [-0.5, 0.5], X, [-0.6, 0.4], Z, [-0.4, 0.4]),
  upperChest: lim(Y, [-0.4, 0.4], X, [-0.5, 0.3], Z, [-0.3, 0.3]),
  neck: lim(Y, [-0.9, 0.9], X, [-0.6, 0.8], Z, [-0.5, 0.5]),
  head: lim(Y, [-1.0, 1.0], X, [-0.7, 0.8], Z, [-0.5, 0.5]),
  jaw: lim(Z, [0, 0], X, [-0.05, 0.45], Y, [-0.1, 0.1]),
  ...LEFT,
  ...Object.fromEntries(
    Object.entries(LEFT).map(([k, l]) => [k.replace(/^left/, "right"), mirror(l)]),
  ),
};

export interface RigIssue {
  readonly bone: string;
  readonly kind:
    | "range"
    | "twist"
    | "reversal"
    | "sideBend"
    | "penetration"
    | "nonFinite"
    | "unknown";
  /** How far past the limit it was (radians). */
  readonly by: number;
}

const clampTo = (x: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, x));
/** One joint held to its range: twist and each swing part clamped; reports what it had to change. */
export const clampJoint = (bone: string, q: Q): { q: Q; issues: RigIssue[] } => {
  const l = JOINT_LIMITS[bone];
  if (l === undefined) return { q, issues: [] };
  const { swing, twist } = swingTwist(q, l.axis);
  const su = dot(swing, l.u);
  const sv = dot(swing, l.v);
  const t2 = clampTo(twist, l.twist);
  const u2 = clampTo(su, l.uRange);
  const v2 = clampTo(sv, l.vRange);
  const issues: RigIssue[] = [];
  if (Math.abs(t2 - twist) > 1e-3) issues.push({ bone, kind: "twist", by: Math.abs(t2 - twist) });
  if (Math.abs(u2 - su) > 1e-3)
    issues.push({ bone, kind: l.hinge ? "reversal" : "range", by: Math.abs(u2 - su) });
  if (Math.abs(v2 - sv) > 1e-3)
    issues.push({ bone, kind: l.hinge ? "sideBend" : "range", by: Math.abs(v2 - sv) });
  if (issues.length === 0) return { q, issues };
  const swing2 = add(scale(l.u, u2), scale(l.v, v2));
  const twistQ = qFromVec(scale(l.axis, t2));
  return { q: qMul(qFromVec(swing2), twistQ), issues };
};

export type Pose = Readonly<Record<string, Q>>;
export interface World {
  readonly rot: Record<string, Q>;
  readonly pos: Record<string, V3>;
}
/** Every bone's world rotation and position for local rotations `pose` (missing bones rest), root at its rest. */
export const fk = (rig: Rig, pose: Pose): World => {
  const rot: Record<string, Q> = {};
  const pos: Record<string, V3> = {};
  const visit = (name: string): void => {
    if (rot[name] !== undefined) return;
    const b = rig.bones[name]!;
    const local = pose[name] ?? QI;
    if (b.parent === null || rig.bones[b.parent] === undefined) {
      rot[name] = local;
      pos[name] = b.rest;
      return;
    }
    visit(b.parent);
    const pr = rot[b.parent]!;
    rot[name] = qMul(pr, local);
    pos[name] = add(pos[b.parent]!, qRotate(pr, sub(b.rest, rig.bones[b.parent]!.rest)));
  };
  for (const n of Object.keys(rig.bones)) visit(n);
  return { rot, pos };
};

const LIMBS = (["left", "right"] as const).flatMap((s) => [
  {
    side: s,
    root: `${s}UpperArm`,
    mid: `${s}LowerArm`,
    end: `${s}Hand`,
    // the elbow points down and a little back and out: where it falls when a hand is held anywhere
    pole: [s === "left" ? 0.35 : -0.35, -1, -0.45] as V3,
    // the elbow's folding axis at rest (forearm forward = rotation about -y on the left)
    hingeAxis: (s === "left" ? [0, -1, 0] : [0, 1, 0]) as V3,
  },
  {
    side: s,
    root: `${s}UpperLeg`,
    mid: `${s}LowerLeg`,
    end: `${s}Foot`,
    // the knee points forward, the way the foot does
    pole: [0, 0, 1] as V3,
    // the knee folds the shin back (rotation about +x)
    hingeAxis: [1, 0, 0] as V3,
  },
]);

/**
 * How far to move a part out of another it is `d` inside (negative: that far off it): nothing well clear of it, all of
 * it well inside, and a smooth, continuous ramp across the surface, so a limb sliding past never jumps on contact.
 */
const SOFT_MARGIN = 0.008;
const softPush = (d: number): number =>
  d <= -SOFT_MARGIN ? 0 : d >= SOFT_MARGIN ? d : (d + SOFT_MARGIN) ** 2 / (4 * SOFT_MARGIN);
/** The point of the segment a..b nearest to p, and its distance. */
const closestOn = (a: V3, b: V3, p: V3): V3 => {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return add(a, scale(ab, t));
};
const segPoint = (a: V3, b: V3, p: V3): number => len(sub(p, closestOn(a, b, p)));

/** What a hand or forearm may rest on but not pass into: her trunk, pelvis, skull and thighs (proxies by her height). */
const restingParts = (
  rig: Rig,
  pos: Readonly<Record<string, V3>>,
): Array<{ readonly a: V3; readonly b: V3; readonly r: number }> => {
  const size = rig.proxies ?? proxiesByHeight(rig.height);
  const top = pos["upperChest"] ?? pos["chest"] ?? pos["spine"];
  const neck = pos["neck"];
  const head = pos["head"];
  // the skull's centre sits above the head joint, along the neck
  const skull =
    neck && head ? add(head, scale(unit(sub(head, neck)), 0.07 * (rig.height / 1.6))) : undefined;
  return (
    [
      // the trunk from her waist up: below it the pelvis is its own narrower part, so a hand hanging at her hip
      // rests against the pelvis's side instead of being held off by the trunk's rounded end
      [pos["spine"] ?? pos["hips"], top, size.trunk],
      [neck, skull, size.head],
      [pos["leftUpperLeg"], pos["rightUpperLeg"], 0.65 * size.trunk],
      [pos["leftUpperLeg"], pos["leftLowerLeg"], size.thigh],
      [pos["rightUpperLeg"], pos["rightLowerLeg"], size.thigh],
    ] as const
  ).flatMap(([a, b, r]) => (a && b ? [{ a, b, r }] : []));
};
/** The hand past the wrist, as a ball: what lands on her face or hip is the hand, not the wrist. */
const handBall = (rig: Rig) => ({
  reach: 0.06 * (rig.height / 1.6),
  // about the hand's own thickness (palm 3.6 cm, PALM_HALF): a fist-sized ball held a hanging hand off her hip
  r: 1.2 * (rig.proxies ?? proxiesByHeight(rig.height)).forearm,
});

/**
 * Re-solves each arm and leg as a two-bone chain: the hand or foot stays where the pose put it, and the elbow or knee
 * folds only its own way, on the side the pose put it unless that needs an impossible twist (then the nearest side
 * that doesn't, never inside her trunk). Wrists and ankles keep their authored bend. Returns the corrected local
 * rotations and what it changed.
 */
export const solveLimbs = (
  rig: Rig,
  pose: Pose,
  /** World positions an end (hand or foot) is moved to, the limb re-solved to reach it. */
  targets: Readonly<Record<string, V3>> = {},
): { pose: Record<string, Q>; issues: RigIssue[] } => {
  const out: Record<string, Q> = { ...pose };
  const issues: RigIssue[] = [];
  const w = fk(rig, pose);
  const top = w.pos["upperChest"] ?? w.pos["chest"] ?? w.pos["spine"];
  const size = rig.proxies ?? proxiesByHeight(rig.height);
  const trunk = w.pos["hips"] && top ? { a: w.pos["hips"], b: top, r: size.trunk } : null;
  const body = restingParts(rig, w.pos);
  const { reach: handReach, r: handR } = handBall(rig);
  for (const l of LIMBS) {
    const [a, b, c] = [rig.bones[l.root], rig.bones[l.mid], rig.bones[l.end]];
    if (!a || !b || !c || a.parent === null) continue;
    const parentRot = w.rot[a.parent] ?? QI;
    const s = w.pos[l.root]!;
    const e0 = w.pos[l.mid]!;
    const t0 = w.pos[l.end]!;
    const la = len(sub(b.rest, a.rest));
    const lb = len(sub(c.rest, b.rest));
    if (la < 1e-6 || lb < 1e-6) continue;
    // where the posed limb bends now, measured in the T-pose convention against the joint's own hinge
    const fixA = rig.restFix[l.root] ?? QI;
    const fixB = rig.restFix[l.mid] ?? QI;
    const midT = qMul(qMul(qConj(fixA), pose[l.mid] ?? QI), fixB);
    const { swing } = swingTwist(midT, T_DIR[l.mid]!);
    const flex = dot(swing, l.hingeAxis);
    const side = len(sub(swing, scale(l.hingeAxis, flex)));
    if (flex < -0.02) issues.push({ bone: l.mid, kind: "reversal", by: -flex });
    if (side > 0.12) issues.push({ bone: l.mid, kind: "sideBend", by: side });
    // a hand or forearm inside her body is moved out to rest on it, and the arm re-solved to reach it there
    let tOut = targets[l.end] ?? t0;
    if (l.root.endsWith("UpperArm")) {
      for (let pass = 0; pass < 3; pass++) {
        let deepest: { depth: number; dir: V3 } | null = null;
        const fore = len(sub(tOut, e0));
        for (let k = 0; k <= 5; k++) {
          const p =
            k < 5
              ? add(e0, scale(sub(tOut, e0), k / 4))
              : add(tOut, scale(sub(tOut, e0), handReach / Math.max(1e-6, fore)));
          for (const c of body) {
            const away = sub(p, closestOn(c.a, c.b, p));
            const depth = c.r + (k === 5 ? handR : size.forearm) - len(away);
            if (softPush(depth) > 1e-4 && (deepest === null || depth > deepest.depth))
              deepest = {
                depth,
                dir: len(away) < 1e-6 ? [Math.sign(p[0]) || 1, 0, 0] : unit(away),
              };
          }
        }
        if (deepest === null) break;
        if (pass === 0 && deepest.depth > 0.004)
          issues.push({ bone: l.end, kind: "penetration", by: deepest.depth });
        tOut = add(tOut, scale(deepest.dir, softPush(deepest.depth)));
      }
    }
    const moved = len(sub(tOut, t0)) > 1e-4;
    if (flex >= -0.02 && side <= 0.12 && !moved) continue;
    // target: the posed end, within reach
    const toT = sub(tOut, s);
    const reach = Math.max(Math.abs(la - lb) + 1e-4, Math.min(la + lb - 1e-4, len(toT)));
    const d = unit(toT);
    const t = add(s, scale(d, reach));
    // pole: the posed elbow's side when it bent the right way, else her natural one (elbow down and back, knee
    // forward); around it, the side that keeps the shoulder or hip and the wrist or ankle inside their twist
    const natural = qRotate(parentRot, l.pole);
    const posedSide = sub(sub(e0, s), scale(d, dot(sub(e0, s), d)));
    // the posed elbow or knee is where the author put it: keep it there unless that needs an impossible twist
    const prefer = unit(len(posedSide) > 1e-3 ? posedSide : natural);
    const perp = (v: V3) => sub(v, scale(d, dot(v, d)));
    const base = len(perp(prefer)) > 1e-6 ? unit(perp(prefer)) : unit(perp(natural));
    const cosA = (la * la + reach * reach - lb * lb) / (2 * la * reach);
    const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const rootParentFix = rig.restFix[a.parent] ?? QI;
    const solveWith = (m: V3) => {
      const e = add(s, add(scale(d, la * Math.cos(alpha)), scale(m, la * Math.sin(alpha))));
      const dirA = unit(sub(e, s));
      const dirB = unit(sub(t, e));
      // both bones share one hinge: across the bend, or (straight) across the side the elbow goes
      let n = cross(dirA, dirB);
      if (len(n) < 1e-6) n = cross(dirA, scale(m, -1));
      n = unit(n);
      // each bone's rest frame (its direction and its hinge at rest) turned onto the solved one
      const frame = (dir: V3, restDir: V3, hingeRest: V3): Q => {
        const q1 = qBetween(restDir, dir);
        const h = qRotate(q1, hingeRest);
        const h1 = unit(sub(h, scale(dir, dot(h, dir))));
        const ang = Math.atan2(dot(cross(h1, n), dir), dot(h1, n));
        return qMul(qFromVec(scale(dir, ang)), q1);
      };
      const worldA = frame(dirA, unit(sub(b.rest, a.rest)), qRotate(fixA, l.hingeAxis));
      const worldB = frame(dirB, unit(sub(c.rest, b.rest)), qRotate(fixB, l.hingeAxis));
      const root = qMul(qConj(parentRot), worldA);
      // the wrist keeps its authored bend: it turns with the forearm, as a real one does
      const end = pose[l.end] ?? QI;
      const over = (bone: string, q: Q) =>
        clampJoint(bone, q).issues.reduce((sum, i) => sum + i.by, 0);
      // an elbow inside her trunk is as wrong as a joint past its range
      const inside = trunk === null ? 0 : Math.max(0, trunk.r - segPoint(trunk.a, trunk.b, e));
      const cost =
        over(l.root, qMul(qMul(qConj(rootParentFix), root), fixA)) +
        10 * inside +
        0.15 * Math.acos(Math.max(-1, Math.min(1, dot(m, base))));
      return { root, mid: qMul(qConj(worldA), worldB), end, cost };
    };
    let best = solveWith(base);
    for (let k = 1; k < 12 && best.cost > 1e-3; k++) {
      const m = qRotate(qFromVec(scale(d, (k * Math.PI) / 6)), base);
      const tryIt = solveWith(m);
      if (tryIt.cost < best.cost) best = tryIt;
    }
    out[l.root] = best.root;
    out[l.mid] = best.mid;
    out[l.end] = best.end;
  }
  // a hand that rests on her lies along her: fingers that would go in are bent back at the wrist, onto the surface
  const after = fk(rig, out);
  for (const side of ["left", "right"] as const) {
    const end = `${side}Hand`;
    const wrist = after.pos[end];
    const parent = rig.bones[end]?.parent;
    if (wrist === undefined || parent == null || after.rot[end] === undefined) continue;
    const dir = qRotate(after.rot[end], handRest(rig, side));
    const s = rig.height / 1.6;
    let deepest: { depth: number; n: V3 } | null = null;
    for (const k of [0.07, 0.12]) {
      const p = add(wrist, scale(dir, k * s));
      for (const c of body) {
        const away = sub(p, closestOn(c.a, c.b, p));
        const depth = c.r + 0.02 * s - len(away);
        if (depth > 0 && len(away) > 1e-6 && (deepest === null || depth > deepest.depth))
          deepest = { depth, n: unit(away) };
      }
    }
    if (deepest === null) continue;
    const along = sub(dir, scale(deepest.n, dot(dir, deepest.n)));
    if (len(along) < 1e-3) continue;
    const bent = unit(add(unit(along), scale(deepest.n, 0.15)));
    const world = qMul(qBetween(dir, bent), after.rot[end]);
    out[end] = qMul(qConj(after.rot[parent] ?? QI), world);
  }
  return { pose: out, issues };
};
/** Where a hand's fingers point at rest, on this rig: toward its middle finger, else along the forearm. */
const handRest = (rig: Rig, side: string): V3 => {
  const hand = rig.bones[`${side}Hand`];
  const finger = rig.bones[`${side}MiddleProximal`];
  const fore = rig.bones[`${side}LowerArm`];
  if (hand && finger) return unit(sub(finger.rest, hand.rest));
  if (hand && fore) return unit(sub(hand.rest, fore.rest));
  return [side === "left" ? 1 : -1, 0, 0];
};

/** The nearest points of segments a..b and c..d (alternating projections; exact for crossing limbs). */
const nearestPair = (a: V3, b: V3, c: V3, d: V3): readonly [V3, V3] => {
  let p = scale(add(a, b), 0.5);
  let q = closestOn(c, d, p);
  for (let i = 0; i < 6; i++) {
    p = closestOn(a, b, q);
    q = closestOn(c, d, p);
  }
  return [p, q];
};
const LEG_PAIRS = [
  ["thigh", "thigh"],
  ["shin", "shin"],
  ["thigh", "shin"],
  ["shin", "thigh"],
] as const;
/**
 * Her legs pass beside or in front of each other, never through: where a thigh or shin is inside the other leg, the
 * foot that moves it (both feet, half each, for thigh on thigh or shin on shin) is moved out along the contact and the
 * leg re-solved to reach it. Leg thickness is her height's share (the fitted thigh includes skirts, which are shared).
 */
const separateLegs = (rig: Rig, pose: Record<string, Q>): RigIssue[] => {
  const r = { thigh: 0.038 * rig.height, shin: 0.026 * rig.height };
  const issues: RigIssue[] = [];
  if (!["left", "right"].every((s) => `${s}Foot` in rig.bones && `${s}UpperLeg` in rig.bones))
    return issues;
  for (let pass = 0; pass < 6; pass++) {
    const w = fk(rig, pose).pos;
    const seg = (s: string, part: "thigh" | "shin") =>
      part === "thigh"
        ? ([w[`${s}UpperLeg`]!, w[`${s}LowerLeg`]!] as const)
        : ([w[`${s}LowerLeg`]!, w[`${s}Foot`]!] as const);
    let deepest: { depth: number; dir: V3; at: V3; pair: (typeof LEG_PAIRS)[number] } | null = null;
    for (const pair of LEG_PAIRS) {
      const [a, b] = seg("left", pair[0]);
      const [c, d] = seg("right", pair[1]);
      const [p, q] = nearestPair(a, b, c, d);
      const gap = sub(p, q);
      const depth = r[pair[0]] + r[pair[1]] - len(gap);
      if (softPush(depth) > 1e-4 && (deepest === null || depth > deepest.depth)) {
        // touching through each other: the leg whose knee is further forward goes in front
        const front = w["leftLowerLeg"]![2] >= w["rightLowerLeg"]![2] ? 1 : -1;
        deepest = { depth, dir: len(gap) < 1e-4 ? [0, 0, front] : unit(gap), at: p, pair };
      }
    }
    if (deepest === null) break;
    const { depth, dir, at, pair } = deepest;
    // left moves along dir, right against it; a thigh-on-shin contact moves the shin's leg alone
    const share = { left: pair[0] === pair[1] ? 0.5 : pair[0] === "shin" ? 1 : 0, right: 0 };
    share.right = 1 - share.left;
    const targets: Record<string, V3> = {};
    for (const s of ["left", "right"] as const) {
      if (share[s] === 0) continue;
      const hip = w[`${s}UpperLeg`]!;
      const foot = w[`${s}Foot`]!;
      // a foot moved by d moves a point partway down the leg by less: scale up by how far down it is
      const lever = Math.min(3, len(sub(foot, hip)) / Math.max(1e-3, len(sub(at, hip))));
      const k = share[s] * 1.5 * softPush(depth) * Math.max(1, lever) * (s === "left" ? 1 : -1);
      targets[`${s}Foot`] = add(foot, scale(dir, k));
    }
    if (pass === 0 && depth > 0.004)
      issues.push({
        bone: share.left > 0 ? "leftFoot" : "rightFoot",
        kind: "penetration",
        by: depth,
      });
    Object.assign(pose, solveLimbs(rig, pose, targets).pose);
  }
  return issues;
};

/**
 * Her forearms rest on each other, never through (arms folded, hugging herself): where one is inside the other, both
 * wrists move apart along the contact, half each, and the arms are re-solved to reach them. Wrists and hands may meet.
 */
const separateArms = (rig: Rig, pose: Record<string, Q>): RigIssue[] => {
  const r = 0.02 * rig.height;
  const issues: RigIssue[] = [];
  if (!["left", "right"].every((s) => `${s}Hand` in rig.bones && `${s}LowerArm` in rig.bones))
    return issues;
  for (let pass = 0; pass < 6; pass++) {
    const w = fk(rig, pose).pos;
    // the thick part of each forearm, below the elbow: wrists and palms may meet (a clap, rubbing hands)
    const thick = (s: string) =>
      add(w[`${s}LowerArm`]!, scale(sub(w[`${s}Hand`]!, w[`${s}LowerArm`]!), 0.6));
    // the wrists themselves only so close that palms still meet
    const pairs = [
      [nearestPair(w["leftLowerArm"]!, thick("left"), w["rightLowerArm"]!, thick("right")), 2 * r],
      [
        nearestPair(thick("left"), w["leftHand"]!, thick("right"), w["rightHand"]!),
        0.015 * rig.height,
      ],
    ] as const;
    const [[p, q], reach] = pairs.reduce((a, b) =>
      b[1] - len(sub(b[0][0], b[0][1])) > a[1] - len(sub(a[0][0], a[0][1])) ? b : a,
    );
    const gap = sub(p, q);
    const depth = reach - len(gap);
    if (softPush(depth) <= 1e-4) break;
    if (pass === 0 && depth > 0.004)
      issues.push({ bone: "leftLowerArm", kind: "penetration", by: depth });
    // crossing exactly: the left forearm goes on top
    const dir = len(gap) < 1e-4 ? ([0, 1, 0] as V3) : unit(gap);
    const k = 0.75 * softPush(depth);
    Object.assign(
      pose,
      solveLimbs(rig, pose, {
        leftHand: add(w["leftHand"]!, scale(dir, k)),
        rightHand: add(w["rightHand"]!, scale(dir, -k)),
      }).pose,
    );
  }
  return issues;
};

export interface SoftContact {
  /** Where the surfaces meet (world, metres). */
  readonly at: V3;
  /** Out of the part that gives, toward what presses it (unit). */
  readonly normal: V3;
  /** How far around it the skin gives (metres). */
  readonly radius: number;
  /** How deep it gives at the centre (metres). */
  readonly depth: number;
}
/** The deepest a firm contact dents her (metres): skin over soft tissue, not a crush. */
export const SOFT_DEPTH = 0.012;
/**
 * Where her parts meet now, for soft deformation: a hand on her trunk, head or a thigh dents it, and legs pressed
 * together flatten each other (one contact each way). Firmest first, at most `max`. Positions are world joints.
 */
export const softContacts = (
  rig: Rig,
  pos: Readonly<Record<string, V3>>,
  max = 4,
): SoftContact[] => {
  const h = rig.height;
  const radius = 0.04 * h;
  // a contact starts 1 cm off the surface and is at its firmest 1 cm in
  const depthOf = (gap: number) => SOFT_DEPTH * Math.max(0, Math.min(1, (0.01 - gap) / 0.02));
  const out: SoftContact[] = [];
  const body = restingParts(rig, pos);
  const hand = handBall(rig);
  for (const side of ["left", "right"] as const) {
    const wrist = pos[`${side}Hand`];
    const elbow = pos[`${side}LowerArm`];
    if (!wrist || !elbow) continue;
    // the palm's middle, a little past the wrist: the same ball the limbs rest by
    const palm = add(wrist, scale(unit(sub(wrist, elbow)), hand.reach));
    for (const c of body) {
      const axis = closestOn(c.a, c.b, palm);
      const away = sub(palm, axis);
      const gap = len(away) - c.r - hand.r;
      if (gap >= 0.01 || len(away) < 1e-6) continue;
      const normal = unit(away);
      out.push({ at: add(axis, scale(normal, c.r)), normal, radius, depth: depthOf(gap) });
    }
  }
  const leg = { thigh: 0.038 * h, shin: 0.026 * h };
  const seg = (s: string, p: "thigh" | "shin") =>
    p === "thigh"
      ? ([pos[`${s}UpperLeg`], pos[`${s}LowerLeg`]] as const)
      : ([pos[`${s}LowerLeg`], pos[`${s}Foot`]] as const);
  for (const [pa, pb] of LEG_PAIRS) {
    const [a, b] = seg("left", pa);
    const [c, d] = seg("right", pb);
    if (!a || !b || !c || !d) continue;
    const [p, q] = nearestPair(a, b, c, d);
    const gap = len(sub(p, q)) - leg[pa] - leg[pb];
    if (gap >= 0.01 || len(sub(p, q)) < 1e-6) continue;
    const n = unit(sub(q, p));
    const at = add(p, scale(n, leg[pa] + Math.max(0, gap) / 2));
    const depth = depthOf(gap) / 2;
    out.push({ at, normal: n, radius, depth }, { at, normal: scale(n, -1), radius, depth });
  }
  return out.toSorted((x, y) => y.depth - x.depth).slice(0, max);
};

/**
 * Spreads a part's rotation along however many segments the model has: a spine of one bone takes it all, of three
 * shares it evenly, so more bones give a smoother curve of the same overall bend.
 */
export const distribute = (rig: Rig, chain: ReadonlyArray<string>, total: Q): Record<string, Q> => {
  const present = chain.filter((b) => Object.hasOwn(rig.bones, b));
  if (present.length === 0) return {};
  const step = qFromVec(scale(qToVec(total), 1 / present.length));
  return Object.fromEntries(present.map((b) => [b, step]));
};

/** Bones a pose names that this rig lacks are carried by the nearest one it has, so nothing is lost or errors. */
const STAND_IN: Readonly<Record<string, string>> = {
  upperChest: "chest",
  chest: "spine",
  neck: "head",
  leftShoulder: "leftUpperArm",
  rightShoulder: "rightUpperArm",
  leftToes: "leftFoot",
  rightToes: "rightFoot",
};

/** Finger curl over whatever finger bones the hand has (0 open .. 1 fist); none means the whole hand stays as posed. */
export const handCurl = (rig: Rig, side: "left" | "right", curl: number): Record<string, Q> => {
  const s = side === "left" ? -1 : 1;
  const out: Record<string, Q> = {};
  for (const b of Object.keys(rig.bones)) {
    if (!b.startsWith(side) || !/Index|Middle|Ring|Little|Thumb/.test(b)) continue;
    // fingers fold about the hand's forward axis (z on the left, -z on the right), the thumb across the palm
    const k = /Thumb/.test(b) ? 0.6 : /Proximal/.test(b) ? 1.2 : 1.0;
    out[b] = qFromVec(
      /Thumb/.test(b) ? [0, s * -0.5 * curl, s * 0.4 * curl] : [0, 0, s * k * curl * -1],
    );
  }
  return out;
};

/**
 * Scapulohumeral rhythm (Inman 1944): past about 30° of arm elevation the shoulder girdle takes about a third of the
 * rest, so a raised arm lifts its shoulder as a person's does. Only when the model has a shoulder bone and the pose
 * left it alone; the arm keeps its direction, carried up a little with the girdle.
 */
const coupleShoulders = (
  rig: Rig,
  local: Record<string, Q>,
  euler: Readonly<Record<string, unknown>>,
): void => {
  const rot = fk(rig, local).rot;
  for (const side of ["left", "right"] as const) {
    const sh = `${side}Shoulder`;
    const arm = `${side}UpperArm`;
    if (!Object.hasOwn(rig.bones, sh) || sh in euler || rot[arm] === undefined) continue;
    const dir = qRotate(rot[arm]!, T_DIR[arm]!);
    const elevation = Math.acos(Math.max(-1, Math.min(1, -dir[1])));
    const lift = Math.min(0.4, Math.max(0, (elevation - 0.52) / 3));
    if (lift < 1e-3) continue;
    // left raises on +z, right on -z; the arm is counter-turned so it points where the pose put it
    const girdle = qFromVec([0, 0, side === "left" ? lift : -lift]);
    local[sh] = qMul(local[sh] ?? QI, girdle);
    local[arm] = qMul(qConj(girdle), local[arm] ?? QI);
  }
};

export interface Prepared {
  readonly pose: Record<string, Q>;
  readonly issues: ReadonlyArray<RigIssue>;
}
/**
 * Any pose, from any source, made right for this rig: Euler in this convention to quaternions, each part moved to the
 * bones the rig has (a missing upper chest's share goes to the chest, a three-bone spine shares the bend), arms and
 * legs re-solved as hinges, then every joint held to its range. Unknown or non-finite input is dropped and reported.
 */
export const preparePose = (
  rig: Rig,
  euler: Readonly<Record<string, V3 | readonly number[]>>,
): Prepared => {
  const issues: RigIssue[] = [];
  const local: Record<string, Q> = {};
  const put = (b: string, q: Q) => {
    local[b] = local[b] === undefined ? q : qMul(local[b], q);
  };
  for (const [bone, e] of Object.entries(euler)) {
    if (!Array.isArray(e) || e.length !== 3 || !e.every((x) => Number.isFinite(x))) {
      issues.push({ bone, kind: "nonFinite", by: 0 });
      continue;
    }
    let target = bone;
    while (!Object.hasOwn(rig.bones, target) && STAND_IN[target] !== undefined)
      target = STAND_IN[target]!;
    if (!Object.hasOwn(rig.bones, target)) {
      if (!isHumanBone(bone)) issues.push({ bone, kind: "unknown", by: 0 });
      continue;
    }
    put(target, qFromEuler(e as unknown as V3));
  }
  // a single spine bone carrying a whole-trunk bend is spread over the trunk bones the model has
  const trunk = CHAINS.spine.filter((b) => Object.hasOwn(rig.bones, b));
  if (trunk.length > 1 && local["spine"] !== undefined && !trunk.slice(1).some((b) => b in euler)) {
    Object.assign(local, distribute(rig, trunk, local["spine"]));
  }
  coupleShoulders(rig, local, euler);
  // the T-pose convention onto this model's rest: local' = F(parent) · local · F(bone)⁻¹
  const fixOf = (b: string) => rig.restFix[b] ?? QI;
  const parentFix = (b: string) => fixOf(rig.bones[b]?.parent ?? "");
  const toModel = (b: string, q: Q) => qMul(qMul(parentFix(b), q), qConj(fixOf(b)));
  const toT = (b: string, q: Q) => qMul(qMul(qConj(parentFix(b)), q), fixOf(b));
  const fixed = (b: string) =>
    rig.restFix[b] !== undefined || rig.restFix[rig.bones[b]?.parent ?? ""] !== undefined;
  for (const b of Object.keys(rig.bones)) if (fixed(b)) local[b] = toModel(b, local[b] ?? QI);
  const limbs = solveLimbs(rig, local);
  issues.push(...limbs.issues, ...separateLegs(rig, limbs.pose), ...separateArms(rig, limbs.pose));
  const out: Record<string, Q> = {};
  for (const [b, q] of Object.entries(limbs.pose)) {
    // limits are written for the T-pose convention: check in it, then back onto the model's rest
    const c = clampJoint(b, fixed(b) ? toT(b, q) : q);
    issues.push(...c.issues);
    out[b] = fixed(b) ? toModel(b, c.q) : c.q;
  }
  return { pose: out, issues };
};

/** How quickly each part follows (ms to close half the gap): the trunk leads, hands and head follow through. */
export const halfLifeOf = (bone: string): number =>
  bone === "hips"
    ? 200
    : /spine|chest/i.test(bone)
      ? 190
      : /neck|head/i.test(bone)
        ? 230
        : /UpperArm|UpperLeg|Shoulder/.test(bone)
          ? 210
          : /LowerArm|LowerLeg/.test(bone)
            ? 235
            : 260;

export interface BoneSpring {
  readonly q: Q;
  /** Angular velocity (rad/s as a rotation vector). */
  readonly w: V3;
  /** Where the spring is heading now, itself springing toward the goal (absent: from where the bone is). */
  readonly g?: Q;
  readonly gw?: V3;
}
/** A critically damped spring's exact step (D. Holden, "Spring-It-On"). */
const damped = (q: Q, w: V3, goal: Q, halfLifeMs: number, dt: number): { q: Q; w: V3 } => {
  const y = (4 * Math.LN2) / (Math.max(1, halfLifeMs) / 1000) / 2;
  const j0 = qToVec(qMul(q, qConj(goal)));
  const j1 = add(w, scale(j0, y));
  const eydt = Math.exp(-y * dt);
  return {
    q: qNorm(qMul(qFromVec(scale(add(j0, scale(j1, dt)), eydt)), goal)),
    w: scale(sub(w, scale(j1, y * dt)), eydt),
  };
};
/**
 * One step of a bone toward `goal`: no overshoot, and a goal that changes mid-move keeps the velocity, so a new pose
 * bends the motion instead of restarting it. Two critically damped springs in series (the bone follows a lead that
 * follows the goal), so a move starts and ends without a kick of acceleration, as a person's does (the bell-shaped,
 * minimum-jerk speed profile of Flash & Hogan 1985), instead of a single spring's full pull on the first frame.
 */
export const springStep = (
  s: BoneSpring,
  goal: Q,
  halfLifeMs: number,
  dtMs: number,
): BoneSpring => {
  const dt = dtMs / 1000;
  const lead = damped(s.g ?? s.q, s.gw ?? [0, 0, 0], goal, 0.6 * halfLifeMs, dt);
  const body = damped(s.q, s.w, lead.q, 0.6 * halfLifeMs, dt);
  return { q: body.q, w: body.w, g: lead.q, gw: lead.w };
};
/** Settled: within a hair of the goal and barely moving, so the renderer may stop drawing. */
export const settled = (s: BoneSpring, goal: Q) => qAngle(s.q, goal) < 0.002 && len(s.w) < 0.01;

/** A 1.6 m T-pose body in VRM 1.0 axes, for a dry run before the model is known. */
export const REFERENCE_RIG: Rig = (() => {
  const left: Record<string, readonly [string | null, V3]> = {
    hips: [null, [0, 0.95, 0]],
    spine: ["hips", [0, 1.02, 0]],
    chest: ["spine", [0, 1.12, 0]],
    upperChest: ["chest", [0, 1.22, 0]],
    neck: ["upperChest", [0, 1.36, 0]],
    head: ["neck", [0, 1.44, 0]],
    leftShoulder: ["upperChest", [0.04, 1.32, 0]],
    leftUpperArm: ["leftShoulder", [0.12, 1.33, 0]],
    leftLowerArm: ["leftUpperArm", [0.37, 1.33, 0]],
    leftHand: ["leftLowerArm", [0.61, 1.33, 0]],
    leftUpperLeg: ["hips", [0.08, 0.88, 0]],
    leftLowerLeg: ["leftUpperLeg", [0.09, 0.48, 0.01]],
    leftFoot: ["leftLowerLeg", [0.09, 0.07, 0]],
    leftToes: ["leftFoot", [0.09, 0.02, 0.12]],
  };
  const bones: RigBone[] = [];
  for (const [name, [parent, rest]] of Object.entries(left)) {
    bones.push({ name, parent, rest });
    if (name.startsWith("left"))
      bones.push({
        name: name.replace("left", "right"),
        parent: parent?.startsWith("left") ? parent.replace("left", "right") : parent,
        rest: [-rest[0], rest[1], rest[2]],
      });
  }
  return makeRig(bones);
})();
