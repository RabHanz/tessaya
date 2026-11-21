/**
 * Two-hand skills (M-081): clapping, rubbing, praying, wringing, interlaced fingers, a hand holding the other wrist.
 * Each is parametric (rate, intensity, style) and placed on her own skeleton: both palms are targets relative to one
 * meeting point in front of her trunk, so they meet surface to surface (never through each other) whatever her
 * posture, with each wrist turned so the palms face, and finger curl where the model has fingers.
 */
import { contactPoint, type ContactPlace, type PalmShape, type TrunkPoint } from "./bodyContact.ts";
import type { Euler, PoseBone } from "./bodyMotion.ts";
import {
  clampJoint,
  dot,
  fk,
  qBetween,
  qConj,
  qFromEuler,
  qFromVec,
  qMul,
  qRotate,
  qToEuler,
  REFERENCE_RIG,
  solveLimbs,
  swingTwist,
  v3,
  type Q,
  type V3,
} from "./bodyRig.ts";

export const TWO_HAND_SKILLS = {
  clap: ["polite", "excited", "slow"],
  rub: ["cold", "scheming", "eager"],
  pray: ["calm", "pleading"],
  wring: ["nervous", "anguished"],
  interlace: ["relaxed", "fidget"],
  holdWrist: ["patient", "shy"],
} as const;
export type TwoHandSkill = keyof typeof TWO_HAND_SKILLS;
export const isTwoHandSkill = (s: unknown): s is TwoHandSkill =>
  typeof s === "string" && Object.hasOwn(TWO_HAND_SKILLS, s);

/** Finger shape per hand as one clip entry, [curl 0..1, spread 0..1, thumb 0..1]: the renderer bends whatever finger bones the model has. */
export const FINGER_KEYS = ["leftFingers", "rightFingers"] as const;
export type FingerKey = (typeof FINGER_KEYS)[number];
/**
 * A clip frame's palms, [skin gap m, weight 0..1, offset kept along the palms 0..1]: the renderer closes her own palms
 * to that gap (handIk), since the arm angles are solved on the reference body and her arms are not its length.
 */
export const PALMS_KEY = "palms";
/**
 * Where the palms meet, [ahead, up, 0] m from her upper chest in her trunk's frame on the 1.6 m body: the renderer
 * puts the meeting there on her own midline, scaled to her height.
 */
export const MEET_KEY = "meet";
/** Every clip key that is not a bone. */
export const HAND_KEYS = [...FINGER_KEYS, PALMS_KEY, MEET_KEY] as const;
export type HandKey = (typeof HAND_KEYS)[number];
/** How much of the palms' offset along each other a skill keeps when they close: a rub slides, a clap lands. */
const MEETS: Partial<Record<TwoHandSkill, number>> = { clap: 0, rub: 1, pray: 0, wring: 1 };

type Side = "left" | "right";
interface HandGoal {
  /** Centre of the palm's surface, world. */
  readonly palm: V3;
  /** Where the fingers point, and the way the palm faces (unit, perpendicular). */
  readonly fingers: V3;
  readonly normal: V3;
  readonly curl: number;
  readonly spread: number;
}

// her hand on the 1.6 m reference body: wrist to palm centre, and half the hand's thickness
const PALM_REACH = 0.075;
// half a hand's thickness at the palm, fingers included: a VRoid hand at 1.6 m is about 3.5 cm through
const PALM_HALF = 0.018;
/** Palm surfaces this far apart count as touching (cloth, soft tissue); never closer. */
export const PALM_CONTACT = 0.004;

const unit = v3.unit;
const mix = (...k: Array<[V3, number]>): V3 =>
  k.reduce<V3>((p, [d, m]) => v3.add(p, v3.scale(d, m)), [0, 0, 0]);
const turn = (v: V3, axis: V3, a: number) => qRotate(qFromVec(v3.scale(unit(axis), a)), v);
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** Default beats a second per skill and style, when the direction gives none. */
const RATE: Record<TwoHandSkill, number> = {
  clap: 2.6,
  rub: 2.2,
  pray: 0.25,
  wring: 0.8,
  interlace: 0.4,
  holdWrist: 0.3,
};

/**
 * Where each palm is at `t` seconds into the beat (0 = hands just arrived), in her trunk's frame: forward f, up u,
 * her left x, from the meeting point m. Rate in beats a second, k (intensity) 0..1.
 */
const goals = (
  skill: TwoHandSkill,
  style: string,
  t: number,
  rate: number,
  k: number,
  frame: { readonly m: V3; readonly f: V3; readonly u: V3; readonly x: V3; readonly hips: V3 },
  /** Placed by intent: the meeting point is `m` itself, not the skill's own spot in front of her. */
  placed: boolean,
  palm: PalmShape,
): Record<Side, HandGoal> => {
  const { f, u, x } = frame;
  const ph = rate * t;
  const wave = Math.sin(2 * Math.PI * ph);
  // a pair of palms facing each other across the midline, `gap` apart (surface to surface), fingers along `fingers`
  const facing = (at: V3, fingers: V3, across: V3, gap: number, curl: number, spread = 0) => {
    const n = unit(v3.sub(across, v3.scale(fingers, dot(across, fingers))));
    const half = PALM_CONTACT / 2 + gap / 2;
    return {
      left: { palm: v3.add(at, v3.scale(n, half)), fingers, normal: v3.scale(n, -1), curl, spread },
      right: { palm: v3.sub(at, v3.scale(n, half)), fingers, normal: n, curl, spread },
    };
  };
  switch (skill) {
    case "clap": {
      const big = style === "excited" ? 1 : style === "polite" ? 0.45 : 0.8;
      const open = (0.1 + 0.22 * k) * big;
      const p = ph - Math.floor(ph);
      // a clap speeds up into the impact, the palms stay pressed a moment, rebound a little, then open slower
      // the rebound pops the palms a few mm apart at once, and the opening carries on from there
      const rebound = 0.008 * k * smooth((p - 0.5) / 0.08);
      const g =
        p < 0.28
          ? open * (1 - (p / 0.28) ** 2)
          : p < 0.5
            ? 0
            : rebound * (1 - smooth((p - 0.5) / 0.5)) + open * smooth((p - 0.5) / 0.5) ** 2;
      // a little higher when excited, unless she was asked where
      const at = placed
        ? frame.m
        : mix([frame.m, 1], [f, -0.06], [u, style === "excited" ? 0.04 : 0]);
      // the fingers point up and out, or up overhead, or down behind her back
      const fromHips = v3.sub(at, frame.hips);
      const fingers = unit(
        dot(fromHips, f) < 0
          ? mix([u, -1], [f, -0.3])
          : dot(fromHips, u) > 0.45
            ? mix([u, 1], [f, 1])
            : mix([f, 1], [u, 0.75]),
      );
      // relaxed fingers, a little curled (cupped: a hollow between the palms), spreading as the hands open
      const curl = (palm === "cupped" ? 0.4 : 0.06) + 0.08 * (open > 0 ? g / open : 0);
      return facing(at, fingers, x, g, curl, open > 0 ? (0.35 * g) / open : 0);
    }
    case "rub": {
      const d = (style === "eager" ? 0.035 : 0.025) + 0.02 * k;
      const fingers = unit(mix([f, 1], [u, style === "cold" ? 0.8 : 0.3]));
      const pair = facing(frame.m, fingers, x, 0, style === "scheming" ? 0.2 : 0.04);
      // the palms slide against each other along the fingers, in opposition, with a small circle across them
      const slide = v3.scale(fingers, d * wave);
      const lift = v3.scale(u, 0.008 * Math.cos(2 * Math.PI * ph));
      return {
        left: { ...pair.left, palm: v3.add(v3.add(pair.left.palm, slide), lift) },
        right: { ...pair.right, palm: v3.sub(v3.sub(pair.right.palm, slide), lift) },
      };
    }
    case "pray": {
      const high = style === "pleading" ? 0.1 + 0.06 * k : 0.02;
      const at = mix([frame.m, 1], [f, -0.1], [u, high + 0.004 * wave]);
      return facing(at, unit(mix([u, 1], [f, 0.7])), x, 0, 0.04);
    }
    case "wring": {
      // clasped hands turning over each other about the forward axis, gripping
      const a = (style === "anguished" ? 0.75 : 0.5) * (0.5 + 0.5 * k) * wave;
      const at = mix([frame.m, 1], [u, -0.14], [f, -0.03]);
      const fingers = unit(mix([f, 1], [u, -0.2]));
      const across = turn(x, fingers, a);
      const pair = facing(at, fingers, across, 0, 0.55, 0.1);
      const slide = v3.scale(fingers, 0.015 * Math.cos(2 * Math.PI * ph));
      return {
        left: { ...pair.left, palm: v3.add(pair.left.palm, slide) },
        right: { ...pair.right, palm: v3.sub(pair.right.palm, slide) },
      };
    }
    case "interlace": {
      // fingers crossing between each other: each hand's fingers point across to the other side, palms facing
      const at = mix([frame.hips, 1], [u, 0.16], [f, 0.2]);
      const lf = unit(mix([f, 1], [x, -0.55], [u, -0.15]));
      const rf = unit(mix([f, 1], [x, 0.55], [u, -0.15]));
      const squeeze = style === "fidget" ? 0.12 * (0.5 + 0.5 * wave) : 0.04 * (0.5 + 0.5 * wave);
      const nl = unit(v3.sub(v3.scale(x, -1), v3.scale(lf, dot(v3.scale(x, -1), lf))));
      const nr = unit(v3.sub(x, v3.scale(rf, dot(x, rf))));
      const half = PALM_CONTACT / 2 + 0.006;
      return {
        left: {
          palm: v3.sub(at, v3.scale(nl, half)),
          fingers: lf,
          normal: nl,
          curl: 0.72 + squeeze,
          spread: 0.6,
        },
        right: {
          palm: v3.sub(at, v3.scale(nr, half)),
          fingers: rf,
          normal: nr,
          curl: 0.72 + squeeze,
          spread: 0.6,
        },
      };
    }
    case "holdWrist": {
      // her right hand hangs relaxed in front; her left wraps its wrist from above
      const low = style === "shy" ? 0.02 : 0.06;
      const wrist = mix([frame.hips, 1], [f, 0.2], [u, low + 0.006 * wave], [x, -0.03]);
      const rFingers = unit(mix([u, -1], [f, 0.45]));
      const rNormal = unit(v3.sub(x, v3.scale(rFingers, dot(x, rFingers))));
      const right = {
        palm: mix([wrist, 1], [rFingers, PALM_REACH], [rNormal, PALM_HALF]),
        fingers: rFingers,
        normal: rNormal,
        curl: 0.25,
        spread: 0,
      };
      // the holding palm sits on top of the wrist, its fingers wrapping round toward her right
      const lNormal = v3.scale(u, -1);
      const lFingers = unit(
        v3.sub(v3.scale(x, -1), v3.scale(lNormal, dot(v3.scale(x, -1), lNormal))),
      );
      const left = {
        palm: mix([wrist, 1], [u, 0.035 + PALM_CONTACT], [x, 0.03]),
        fingers: lFingers,
        normal: lNormal,
        curl: 0.68,
        spread: 0,
      };
      return { left, right };
    }
  }
};

/** The hand's world rotation that points its fingers along `fingers` with its palm facing `normal`. */
const handRot = (s: Side, fingers: V3, normal: V3): Q => {
  const q1 = qBetween(s === "left" ? [1, 0, 0] : [-1, 0, 0], fingers);
  const palm = qRotate(q1, [0, -1, 0]);
  const a = Math.atan2(dot(v3.cross(palm, normal), fingers), dot(palm, normal));
  return qMul(qFromVec(v3.scale(fingers, a)), q1);
};

const r3 = (q: Q): Euler => qToEuler(q).map((n) => Math.round(n * 1000) / 1000) as unknown as Euler;

/**
 * The arm that brings a wrist to `wrist` with the hand turned to `hand` (world), choosing where the elbow goes around
 * the shoulder-to-wrist line so the wrist bends least: the forearm takes the twist (pronation, supination) as a
 * person's does, and the elbow stays low and out of her trunk.
 */
const bestArm = (
  s: Side,
  local: Record<string, Q>,
  w: ReturnType<typeof fk>,
  wrist: V3,
  hand: Q,
): Partial<Record<PoseBone, Euler>> => {
  const up = `${s}UpperArm`;
  const fore = `${s}LowerArm`;
  const S = w.pos[up]!;
  const la = Math.hypot(...v3.sub(REFERENCE_RIG.bones[fore]!.rest, REFERENCE_RIG.bones[up]!.rest));
  const lb = Math.hypot(
    ...v3.sub(REFERENCE_RIG.bones[`${s}Hand`]!.rest, REFERENCE_RIG.bones[fore]!.rest),
  );
  const toW = v3.sub(wrist, S);
  const r = Math.max(Math.abs(la - lb) + 1e-3, Math.min(la + lb - 1e-3, Math.hypot(...toW)));
  const d = unit(toW);
  const cosA = (la * la + r * r - lb * lb) / (2 * la * r);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const natural: V3 = [s === "left" ? 0.35 : -0.35, -1, -0.45];
  const b1 = unit(v3.sub(natural, v3.scale(d, dot(natural, d))));
  const b2 = v3.cross(d, b1);
  const parent = w.rot[`${s}Shoulder`] ?? w.rot["upperChest"]!;
  const axis: V3 = s === "left" ? [1, 0, 0] : [-1, 0, 0];
  let best: { cost: number; pose: Partial<Record<PoseBone, Euler>> } | null = null;
  for (let i = 0; i < 24; i++) {
    const phi = ((i < 12 ? i : 12 - i) * Math.PI) / 12;
    const e = mix(
      [S, 1],
      [d, la * cosA],
      [b1, la * sinA * Math.cos(phi)],
      [b2, la * sinA * Math.sin(phi)],
    );
    const aim = qRotate(qConj(parent), unit(v3.sub(e, S)));
    const pre = { ...local, [up]: qBetween(axis, aim) };
    const solved = solveLimbs(REFERENCE_RIG, pre, { [`${s}Hand`]: wrist }).pose;
    const sw = fk(REFERENCE_RIG, solved);
    const want = qMul(qConj(sw.rot[fore]!), hand);
    const { twist } = swingTwist(want, axis);
    const t = Math.max(-1.5, Math.min(1.5, twist));
    const tw = qFromVec(v3.scale(axis, t));
    const wristQ = qMul(qConj(tw), want);
    const over = clampJoint(`${s}Hand`, wristQ).issues.reduce((n, x) => n + x.by, 0);
    const elbow = sw.pos[fore]!;
    // a forearm her trunk pushed out leaves the hands apart: as wrong as a wrist past its range
    const miss = Math.hypot(...v3.sub(sw.pos[`${s}Hand`]!, wrist));
    const cost =
      10 * over +
      50 * miss +
      2 * Math.abs(twist - t) +
      3 * Math.max(0, elbow[1] - S[1] + 0.05) +
      3 * Math.max(0, 0.12 - Math.abs(elbow[0])) +
      0.05 * Math.abs(phi);
    if (best === null || cost < best.cost - 1e-9)
      best = {
        cost,
        pose: {
          [up]: r3(solved[up]!),
          [fore]: r3(qMul(solved[fore]!, tw)),
          [`${s}Hand`]: r3(wristQ),
        },
      };
  }
  return best!.pose;
};

/** One frame of a two-hand skill over a base posture: both arms, both wrists, and each hand's finger shape. */
export const twoHandsAt = (
  skill: TwoHandSkill,
  opts: {
    readonly rate?: number;
    readonly intensity?: number;
    readonly style?: string;
    readonly where?: ContactPlace | TrunkPoint;
    readonly palm?: PalmShape;
  },
  base: Partial<Record<PoseBone, Euler>>,
  t: number,
): Partial<Record<PoseBone | HandKey, Euler>> => {
  const local: Record<string, Q> = Object.fromEntries(
    Object.entries(base).map(([b, e]) => [b, qFromEuler(e as V3)]),
  );
  const w = fk(REFERENCE_RIG, local);
  const trunk = w.rot["upperChest"] ?? w.rot["chest"]!;
  const f = qRotate(trunk, [0, 0, 1]);
  const u = qRotate(trunk, [0, 1, 0]);
  const x = qRotate(trunk, [1, 0, 0]);
  // each skill's own spot is about a hand's breadth further out than a clap's, when she was not asked where
  const [ahead, high, left] =
    opts.where === undefined ? ([0.3, -0.08, 0] as const) : contactPoint(opts.where);
  const m = mix([w.pos["upperChest"]!, 1], [f, ahead], [u, high], [x, left]);
  const styles: ReadonlyArray<string> = TWO_HAND_SKILLS[skill];
  const style = styles.includes(opts.style ?? "") ? opts.style! : styles[0]!;
  const rate = Math.max(0.1, Math.min(6, opts.rate ?? RATE[skill] * (style === "slow" ? 0.4 : 1)));
  const g = goals(
    skill,
    style,
    Math.max(0, t),
    rate,
    opts.intensity ?? 0.8,
    { m, f, u, x, hips: w.pos["hips"]! },
    opts.where !== undefined,
    opts.palm ?? "flat",
  );
  const wrists = Object.fromEntries(
    (["left", "right"] as const).map((s) => [
      `${s}Hand`,
      mix([g[s].palm, 1], [g[s].normal, -PALM_HALF], [g[s].fingers, -PALM_REACH]),
    ]),
  );
  const out: Partial<Record<PoseBone | HandKey, Euler>> = {};
  const keep = MEETS[skill];
  if (keep !== undefined) {
    const gap = Math.max(PALM_CONTACT, dot(v3.sub(g.right.palm, g.left.palm), g.left.normal));
    out[PALMS_KEY] = [Math.round(gap * 1000) / 1000, 1, keep];
    const at = v3.sub(v3.scale(v3.add(g.left.palm, g.right.palm), 0.5), w.pos["upperChest"]!);
    out[MEET_KEY] = [
      Math.round(dot(at, f) * 1000) / 1000,
      Math.round(dot(at, u) * 1000) / 1000,
      Math.round(dot(at, x) * 1000) / 1000,
    ];
  }
  for (const s of ["left", "right"] as const) {
    const arm = bestArm(s, local, w, wrists[`${s}Hand`]!, handRot(s, g[s].fingers, g[s].normal));
    // the girdle is part of the skill: a performance's shrug or reach would carry the palms apart
    out[`${s}Shoulder`] = base[`${s}Shoulder`] ?? [0, 0, 0];
    Object.assign(out, arm);
    const c = Math.max(0, Math.min(1, g[s].curl));
    out[`${s}Fingers`] = [
      Math.round(c * 100) / 100,
      Math.round(g[s].spread * 100) / 100,
      Math.round(Math.min(1, c * 1.1) * 100) / 100,
    ];
  }
  return out;
};

/**
 * One hand holding something in front of her, over a base posture (a held prop): the palm's centre `at` [ahead, up,
 * her left] m from her upper chest, the fingers and the way the palm faces in her trunk's frame, the hand closed by
 * `curl`. The arm and wrist come from the same solve as the two-hand skills; the other arm is left as it is.
 */
export const oneHandAt = (
  s: Side,
  goal: {
    readonly at: V3;
    readonly fingers: V3;
    readonly normal: V3;
    readonly curl: number;
    /** How far the thumb folds over (0..1); with the fingers' curl when absent. */
    readonly thumb?: number;
  },
  base: Partial<Record<PoseBone, Euler>>,
): Partial<Record<PoseBone | HandKey, Euler>> => {
  const local: Record<string, Q> = Object.fromEntries(
    Object.entries(base).map(([b, e]) => [b, qFromEuler(e as V3)]),
  );
  const w = fk(REFERENCE_RIG, local);
  const trunk = w.rot["upperChest"] ?? w.rot["chest"]!;
  const inTrunk = (v: V3) =>
    mix(
      [qRotate(trunk, [0, 0, 1]), v[0]],
      [qRotate(trunk, [0, 1, 0]), v[1]],
      [qRotate(trunk, [1, 0, 0]), v[2]],
    );
  const fingers = unit(inTrunk(goal.fingers));
  const n = inTrunk(goal.normal);
  const normal = unit(v3.sub(n, v3.scale(fingers, dot(n, fingers))));
  const palm = v3.add(w.pos["upperChest"]!, inTrunk(goal.at));
  const wrist = mix([palm, 1], [normal, -PALM_HALF], [fingers, -PALM_REACH]);
  const c = Math.max(0, Math.min(1, goal.curl));
  return {
    [`${s}Shoulder`]: base[`${s}Shoulder`] ?? [0, 0, 0],
    ...bestArm(s, local, w, wrist, handRot(s, fingers, normal)),
    [`${s}Fingers`]: [c, 0, Math.max(0, Math.min(1, goal.thumb ?? c * 1.1))],
  };
};

/** Where each palm's surface is in a pose (reference body), with the way it faces: what the tests and grader read. */
export const palmsIn = (
  pose: Partial<Record<string, Euler>>,
): Record<Side, { readonly palm: V3; readonly normal: V3; readonly fingers: V3 }> => {
  const w = fk(
    REFERENCE_RIG,
    Object.fromEntries(
      Object.entries(pose).flatMap(([b, e]) => (e === undefined ? [] : [[b, qFromEuler(e as V3)]])),
    ),
  );
  const one = (s: Side) => {
    const r = w.rot[`${s}Hand`]!;
    const fingers = qRotate(r, s === "left" ? [1, 0, 0] : [-1, 0, 0]);
    const normal = qRotate(r, [0, -1, 0]);
    return {
      palm: mix([w.pos[`${s}Hand`]!, 1], [fingers, PALM_REACH], [normal, PALM_HALF]),
      normal,
      fingers,
    };
  };
  return { left: one("left"), right: one("right") };
};

/**
 * How far each finger joint folds in a resting hand (rad, proximal, intermediate, distal): the median of a person's
 * hands over a minute of talking (BEAT speaker 1, retargeted with tessaya-ops/anim-pipeline/beat-hands.py; the data
 * stays in tessaya-private-data). A real resting hand folds most at the middle joints, and the ring finger most of all.
 */
const RELAXED_FOLD = {
  Index: [0.44, 0.67, 0.4],
  Middle: [0.45, 0.67, 0.4],
  Ring: [0.41, 0.81, 0.24],
  Little: [0.23, 0.64, 0.42],
} as const;
/** How the knuckles fan out as a hand spreads, the little finger most. */
const FAN = { Index: 1, Middle: 0.3, Ring: -0.4, Little: -1 } as const;
/** Each joint's human range of flexion (MCP ~90°, PIP ~100°, DIP ~70°, AAOS normal ranges): the clamp on any shape. */
const FINGER_LIMITS = [1.57, 1.75, 1.22] as const;
const SPREAD_MAX = 0.3;
/** Her hands when nothing shapes them: the captured resting fold (curl), a little fan, the thumb eased in. */
export const RELAXED_FINGERS: Euler = [0.22, 0.15, 0.3] as unknown as Euler;

/**
 * Finger bones for one hand's shape [curl, spread, thumb], as local Euler on the bones the model has (VRM 1.0 axes):
 * the captured resting fold, scaled toward flat (curl 0) or a fist (curl 1) joint by joint, within each joint's range.
 */
export const fingerBones = (
  s: Side,
  shape: Euler,
  has: (bone: string) => boolean,
): Record<string, Euler> => {
  const [curl, spread, thumb] = shape;
  const sg = s === "left" ? -1 : 1;
  const k = Math.max(0, curl) / RELAXED_FINGERS[0];
  const out: Record<string, Euler> = {};
  for (const [finger, fan] of Object.entries(FAN))
    for (const [i, part] of ["Proximal", "Intermediate", "Distal"].entries()) {
      const b = `${s}${finger}${part}`;
      if (!has(b)) continue;
      // the capture's fold, joint by joint; its small twists and splay are left out (they differ from rig to rig and
      // cross neighbouring fingers on some), the knuckles fanning out by the spread instead
      const z = RELAXED_FOLD[finger as keyof typeof FAN][i]!;
      out[b] = [
        0,
        i === 0 ? sg * -Math.min(SPREAD_MAX, 0.18 * spread) * fan : 0,
        sg * Math.min(FINGER_LIMITS[i]!, z * k),
      ];
    }
  // the thumb stays the anatomical model's: the capture's thumb rest differs from VRM's, and retargeted it juts forward
  for (const [i, part] of ["Metacarpal", "Proximal", "Distal"].entries()) {
    const b = `${s}Thumb${part}`;
    const t = Math.min(1, thumb);
    if (has(b)) out[b] = [0.5 * t * (i === 0 ? 0.6 : 1), sg * 0.25 * t, sg * 0.3 * t];
  }
  return out;
};
