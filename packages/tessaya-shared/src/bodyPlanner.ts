/**
 * The performance composer (M-070): a direction's feeling (valence, arousal, dominance) and movement (Laban Effort and
 * Shape, as EMOTE drives gesture: Chi et al. 2000) become body, face, gaze and timing over any posture, never a lookup.
 * Phrased as people move (wind-up, minimum-jerk stroke, settle, proximal-to-distal overlap), under human joint speeds.
 */
import type { BodyCue, Weights } from "./bodyCues.ts";
import type { Euler, PoseBone } from "./bodyMotion.ts";
import {
  fk,
  qAngle,
  qFromEuler,
  qRotate,
  qSlerp,
  qToEuler,
  REFERENCE_RIG,
  solveLimbs,
  v3,
  type Q,
  type V3,
} from "./bodyRig.ts";
import { isTwoHandSkill, TWO_HAND_SKILLS, twoHandsAt, type TwoHandSkill } from "./bodySkills.ts";

/**
 * Human speed ceilings per joint (rad/s), the most any frame may ask (M-069): peak values measured in fast human
 * motion, never beyond. Head: saccade-linked gaze shifts, ~400°/s. Trunk: upper-trunk rotation in pitching, ~1100°/s
 * (Fleisig et al. 1995). Shoulder: internal rotation in pitching, ~7000°/s (Fleisig et al. 1995). Elbow: extension in
 * throwing, ~2300°/s. Knee: extension in sprinting, ~1400°/s. Hip, wrist and ankle: kicking and throwing, ~1000–2000°/s.
 */
const DEG = Math.PI / 180;
export const JOINT_SPEED = (bone: string): number =>
  /neck|head/i.test(bone)
    ? 400 * DEG
    : /hips|spine|chest/i.test(bone)
      ? 1100 * DEG
      : /Shoulder|UpperArm/.test(bone)
        ? 7000 * DEG
        : /LowerArm/.test(bone)
          ? 2300 * DEG
          : /Hand/.test(bone)
            ? 2000 * DEG
            : /LowerLeg/.test(bone)
              ? 1400 * DEG
              : 1000 * DEG;

/** What a moment feels like and how it moves; every value -1..1. Only `feel` is needed: the rest follows from it. */
export interface Perform {
  /** Pleasant (+) or not; energised (+) or drained; in control (+) or small. */
  readonly feel: { readonly valence: number; readonly arousal: number; readonly dominance: number };
  /** Laban Effort: strong (+) or light weight; sudden (+) or sustained time; direct (+) or roving space; bound (+) or free flow. */
  readonly effort?: Partial<Record<"weight" | "time" | "space" | "flow", number>>;
  /** Laban Shape: rising (+) or sinking; advancing toward him (+) or retreating; spreading (+) or enclosing. */
  readonly shape?: Partial<Record<"rise" | "advance" | "spread", number>>;
  /** How big, 0..1. */
  readonly intensity?: number;
  /** The whole performance, onset to return, in ms; her pace picks it when absent. */
  readonly ms?: number;
  /** Where her hands go on her own body or around it, found on her own skeleton; `repeat` beats there (a clap). */
  readonly hands?: {
    readonly left?: HandPlace;
    readonly right?: HandPlace;
    /** Beats a second between there and a little apart, through the hold: a clap, rubbing hands, a tap. */
    readonly repeat?: number;
    /** Both hands in one coordinated skill (palms meeting, wrists turned, fingers shaped); left and right are then ignored. */
    readonly skill?: TwoHandSkill;
    /** The skill's manner, one of `TWO_HAND_SKILLS[skill]`. */
    readonly style?: string;
  };
  /** Where her attention goes, when the direction says (a ball coming, a noise behind her): looks at `atMs`. */
  readonly focus?: ReadonlyArray<{ readonly x: number; readonly y: number; readonly atMs: number }>;
}

/** Places a hand can go, found from her own bones: her body is the map, so any skeleton has them. */
export const HAND_PLACES = [
  "together",
  "mouth",
  "face",
  "brow",
  "ear",
  "head",
  "heart",
  "hip",
  "shoulder",
  "forward",
  "up",
  "out",
] as const;
export type HandPlace = (typeof HAND_PLACES)[number];

const c1 = (x: number) => Math.max(-1, Math.min(1, x));
const pos = (x: number) => Math.max(0, Math.min(1, x));
const u01 = (x: number) => (c1(x) + 1) / 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Minimum-jerk position from 0 to 1 (Flash & Hogan 1985): how a person's reach accelerates and lands. */
const mj = (p: number) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

/** Effort and Shape, filled from the feeling where the direction left them open, then clamped. */
export const qualitiesOf = (p: Perform) => {
  const {
    valence: v,
    arousal: a,
    dominance: d,
  } = {
    valence: c1(p.feel.valence),
    arousal: c1(p.feel.arousal),
    dominance: c1(p.feel.dominance),
  };
  const e = p.effort ?? {};
  const s = p.shape ?? {};
  return {
    v,
    a,
    d,
    weight: c1(e.weight ?? 0.5 * d + 0.3 * a),
    time: c1(e.time ?? 0.8 * a),
    space: c1(e.space ?? 0.4 * d),
    // tension binds the flow; ease frees it
    flow: c1(e.flow ?? -0.6 * v + 0.3 * pos(a) * pos(-v)),
    rise: c1(s.rise ?? 0.55 * v + 0.35 * a),
    advance: c1(s.advance ?? 0.35 * d + 0.25 * v),
    spread: c1(s.spread ?? 0.6 * v * u01(a) - 0.4 * pos(-d)),
    k: pos(p.intensity ?? 0.8),
  };
};
type Qualities = ReturnType<typeof qualitiesOf>;

type Pose = Partial<Record<PoseBone, Euler>>;
const SIDES = ["left", "right"] as const;
/** Her right side is her left mirrored through x = 0: (x, -y, -z). */
const side = (s: "left" | "right", e: Euler): Euler => (s === "left" ? e : [e[0], -e[1], -e[2]]);

/** The apex of the performance as changes from her base posture (VRM 1.0 axes, her left side; mirrored for the right). */
const apexDelta = (q: Qualities, grounded: boolean): Pose => {
  const lift = pos(q.rise);
  // sinking out of energy slumps; sinking with energy crouches
  const collapse = pos(-q.rise) * pos(0.6 - q.a);
  const crouch = grounded ? 0 : pos(-q.rise) * pos(q.a + 0.4);
  const elevate = lift * pos(q.a + 0.2);
  const open = pos(q.spread) * (1 - elevate);
  const enclose = pos(-q.spread);
  const tension = pos(q.flow) * Math.abs(q.a);
  const reach = pos(q.advance) * pos(q.a);
  const out: Record<string, Euler> = {
    spine: [0.2 * collapse + 0.1 * q.advance + 0.16 * crouch - 0.06 * lift, 0, 0],
    chest: [0.12 * collapse + 0.05 * q.advance - 0.07 * lift, 0, 0],
    upperChest: [0.05 * collapse - 0.04 * lift, 0, 0],
    neck: [0.08 * collapse - 0.05 * lift, 0, 0],
    head: [0.25 * collapse - 0.12 * lift + 0.06 * pos(-q.d) - 0.05 * crouch, 0, 0],
  };
  for (const s of SIDES) {
    out[`${s}Shoulder`] = side(s, [0, -0.12 * enclose + 0.06 * pos(q.spread), 0.14 * tension]);
    out[`${s}UpperArm`] = side(s, [
      0,
      -0.3 * elevate + 0.15 * open - 0.75 * enclose - 0.4 * reach,
      2.2 * elevate + 0.7 * open + 0.15 * enclose,
    ]);
    out[`${s}LowerArm`] = side(s, [
      0,
      -(0.9 * enclose + 0.5 * elevate * pos(q.weight + 0.5) + 0.4 * tension),
      0,
    ]);
    out[`${s}Hand`] = side(s, [0, 0, 0.15 * tension]);
    if (!grounded) {
      out[`${s}UpperLeg`] = side(s, [-0.9 * crouch - 0.08 * collapse, 0, 0]);
      out[`${s}LowerLeg`] = side(s, [1.5 * crouch + 0.15 * collapse, 0, 0]);
      out[`${s}Foot`] = side(s, [-0.6 * crouch, 0, 0]);
    }
  }
  return Object.fromEntries(
    Object.entries(out).map(([b, e]) => [b, e.map((x) => x * q.k) as unknown as Euler]),
  );
};

/** Proximal to distal: the trunk leads, then shoulders and head, arms, hands (legs lead with the trunk). */
const ORDER = (bone: string): number =>
  /UpperLeg|LowerLeg|Foot|hips|spine/.test(bone)
    ? 0
    : /chest|Chest/.test(bone)
      ? 1
      : /neck|Shoulder/.test(bone)
        ? 2
        : /head|UpperArm/.test(bone)
          ? 3
          : /LowerArm/.test(bone)
            ? 4
            : 5;

export interface Timing {
  readonly antic: number;
  readonly stroke: number;
  readonly settle: number;
  readonly hold: number;
  readonly back: number;
  readonly anticAmp: number;
  readonly overshoot: number;
  readonly stagger: number;
}
/** Phrasing from Effort: sudden time is a short stroke with a wind-up; free flow overlaps and overshoots more. */
export const timingOf = (q: Qualities, ms: number | undefined, stretch = 1): Timing => {
  const stroke = lerp(1100, 300, u01(q.time)) * stretch;
  const antic = q.time > -0.2 ? 0.4 * stroke : 0;
  const settle = 0.8 * stroke;
  const back = Math.max(600, 1.5 * stroke);
  const natural = 1800 + 1500 * Math.abs(q.v);
  const hold = Math.max(
    300,
    (ms ?? antic + stroke + settle + natural + back) - antic - stroke - settle - back,
  );
  return {
    antic,
    stroke,
    settle,
    hold,
    back,
    anticAmp: 0.25 * pos(q.time + 0.2),
    overshoot: 0.15 * (1 - u01(q.flow)) * u01(q.time),
    stagger: 35 + 45 * (1 - u01(q.flow)),
  };
};
/** The last part (a hand, ORDER 5) starts its return 5 staggers after the trunk, so it ends that much later. */
const endOf = (t: Timing) => t.antic + t.stroke + t.settle + t.hold + t.back + 5 * t.stagger;

/** How far into its change a bone is `u` ms after it starts: wind-up, stroke, overshoot and settle, hold, return. */
const envelope = (t: Timing, u: number): number => {
  if (u <= 0) return 0;
  if (u < t.antic) return -t.anticAmp * Math.sin((Math.PI / 2) * (u / t.antic));
  let x = u - t.antic;
  if (x < t.stroke) return -t.anticAmp + (1 + t.overshoot + t.anticAmp) * mj(x / t.stroke);
  x -= t.stroke;
  if (x < t.settle) return 1 + t.overshoot - t.overshoot * mj(x / t.settle);
  x -= t.settle;
  if (x < t.hold) return 1;
  return 1 - mj((x - t.hold) / t.back);
};

/** A full tremor at the hands (rad), as the body's own tremble draws it: about 0.7 degrees. */
export const TREMOR_HAND = 0.012;
/** Two near sines at 9.2 and 11.1 Hz, slowly waxing and waning: a fine quiver, never a regular buzz. Peak about 1. */
const fineShake = (t: number, seed: number) =>
  ((Math.sin(t * 2 * Math.PI * 9.2 + seed) + 0.7 * Math.sin(t * 2 * Math.PI * 11.1 + seed * 2.3)) /
    1.7) *
  (0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 0.7 + seed));

/**
 * What runs on its own while she performs (the involuntary layer): breath, a bounce of joy, a nervous weight shift,
 * a tremor of fear or effort. Amplitudes in rad, times in ms; each fades in over the stroke and out with the return.
 */
const rhythms = (q: Qualities, t: Timing, ms: number, grounded: boolean): Record<string, Euler> => {
  const out: Record<string, [number, number, number]> = {};
  const add = (b: string, k: 0 | 1 | 2, x: number) => {
    out[b] ??= [0, 0, 0];
    out[b]![k] += x;
  };
  const sec = ms / 1000;
  const start = t.antic + t.stroke;
  const live = envelope(t, ms) > 0.5 ? 1 : pos(envelope(t, ms) * 2);
  // breath: faster and deeper with arousal; a gasp in at a sudden onset
  const hz = 0.25 + 0.3 * u01(q.a);
  add("chest", 0, -(0.012 + 0.02 * pos(q.a)) * Math.sin(2 * Math.PI * hz * sec));
  if (t.antic > 0 && ms < start)
    add("chest", 0, -0.06 * pos(q.time) * Math.sin(Math.PI * (ms / start)));
  // a bounce of joy: arousal with pleasure and free flow, a few beats into the hold
  const bounce = pos((q.a - 0.3) / 0.7) * pos(q.v) * (1 - pos(q.flow));
  const beats = 2 + Math.round(2 * bounce);
  const bhz = 1.6 + 1.2 * pos(q.a);
  const bt = (ms - start) / 1000;
  if (!grounded && bounce > 0.05 && bt > 0 && bt < beats / bhz) {
    const b = bounce * q.k * (0.5 - 0.5 * Math.cos(2 * Math.PI * bhz * bt));
    for (const s of SIDES) {
      add(`${s}UpperLeg`, 0, -0.22 * b);
      add(`${s}LowerLeg`, 0, 0.4 * b);
      add(`${s}Foot`, 0, -0.18 * b);
    }
  }
  // a nervous shift from foot to foot: energy held in (bound flow) without pleasure
  const fidget = pos(q.a) * pos(q.flow) * pos(-q.d + 0.2) * live;
  if (fidget > 0.05) {
    add("hips", 2, 0.04 * fidget * Math.sin(2 * Math.PI * 0.6 * sec));
    add("spine", 2, -0.03 * fidget * Math.sin(2 * Math.PI * 0.6 * sec));
  }
  // a tremor: fear (displeasure, arousal, smallness) or extreme strong effort, too fast to stop. Physiological: about
  // 0.7 degrees at the hands, 9 to 11 Hz (Elble 2003), a brief burst that settles to a faint quiver, never the hips
  const tremor = Math.max(pos(-q.v) * pos(q.a - 0.4) * pos(-q.d), pos(q.weight - 0.8)) * live;
  if (tremor > 0.05) {
    const burst = Math.max(0.25, 1 - Math.max(0, bt - 2.5) / 1.5);
    for (const [i, s] of SIDES.entries())
      add(`${s}Hand`, 2, TREMOR_HAND * tremor * burst * fineShake(sec, 1 + 3 * i));
  }
  // a sigh as a drained, unhappy moment lets go
  const sigh = pos(-q.v) * pos(-q.a);
  const r = ms - (endOf(t) - 5 * t.stagger - t.back);
  if (sigh > 0.1 && r > 0 && r < t.back)
    add("chest", 0, 0.05 * sigh * Math.sin(Math.PI * (r / t.back)));
  return out;
};

type Keys = ReadonlyArray<{ readonly atMs: number; readonly bones: Pose }>;
/** Her own keyed action at `ms`, between its keys, held at its end. */
const keysAt = (keys: Keys, ms: number): Pose => {
  const i = Math.max(
    0,
    keys.findLastIndex((k) => k.atMs <= ms),
  );
  const a = keys[i]!;
  const b = keys[Math.min(keys.length - 1, i + 1)]!;
  const u = b.atMs === a.atMs ? 0 : mj(Math.min(1, (ms - a.atMs) / (b.atMs - a.atMs)));
  const out: Record<string, Euler> = {};
  for (const bone of new Set([...Object.keys(a.bones), ...Object.keys(b.bones)])) {
    const x = a.bones[bone as PoseBone] ?? b.bones[bone as PoseBone]!;
    const y = b.bones[bone as PoseBone] ?? x;
    out[bone] = [0, 1, 2].map((k) => x[k]! + (y[k]! - x[k]!) * u) as unknown as Euler;
  }
  return out;
};

/**
 * One frame `ms` into the performance over a base posture. Parts the agent placed itself (its bones, its keys) are its
 * own: the performance does not bend them, though breath and tremor still run through them.
 */
const frameAt = (
  base: Pose,
  delta: Pose,
  q: Qualities,
  t: Timing,
  ms: number,
  grounded: boolean,
  own: { readonly bones: Pose; readonly keys: Keys | undefined },
): Pose => {
  const extra = rhythms(q, t, ms, grounded);
  const placed = { ...own.bones, ...(own.keys === undefined ? {} : keysAt(own.keys, ms)) };
  base = { ...base, ...placed };
  const bones = new Set([...Object.keys(base), ...Object.keys(delta), ...Object.keys(extra)]);
  const out: Record<string, Euler> = {};
  for (const b of bones) {
    const e = envelope(t, ms - ORDER(b) * t.stagger);
    const from = base[b as PoseBone] ?? [0, 0, 0];
    const d = (b in placed ? undefined : delta[b as PoseBone]) ?? [0, 0, 0];
    const x = extra[b] ?? [0, 0, 0];
    out[b] = [0, 1, 2].map(
      (k) => Math.round((from[k]! + e * d[k]! + x[k]!) * 1000) / 1000,
    ) as unknown as Euler;
  }
  return out;
};

/** The fastest any bone moves between frames, against its human ceiling (1 is at the limit). */
export const speedRatio = (frames: ReadonlyArray<Pose>, fps: number): number => {
  let worst = 0;
  for (let i = 1; i < frames.length; i += 1)
    for (const [b, e] of Object.entries(frames[i]!)) {
      const was = frames[i - 1]![b as PoseBone];
      if (was === undefined) continue;
      worst = Math.max(worst, (qAngle(qFromEuler(was), qFromEuler(e)) * fps) / JOINT_SPEED(b));
    }
  return worst;
};

/** The face through the performance: a startle at a sudden onset, then the feeling itself, at `k`. */
const faces = (q: Qualities, t: Timing): Array<{ atMs: number; weights: Weights; ms: number }> => {
  const k = 0.5 + 0.5 * q.k;
  const apex: Weights = {
    happy: pos(q.v) * (0.55 + 0.45 * u01(q.a)),
    relaxed: pos(q.v) * pos(-q.a) * 0.8,
    sad: pos(-q.v) * (1 - pos(q.a)) * 0.9,
    angry: pos(-q.v) * pos(q.a) * pos(q.d + 0.2) * 0.9,
    surprised: pos(q.a) * pos(-q.d) * pos(-q.v) * 0.8 + 0.2 * pos(q.a) * pos(q.v) * u01(q.time),
    aa: 0.35 * pos(q.a) * pos(q.v) * u01(q.time),
    blink: 0.35 * pos(-q.a),
  };
  const out: Array<{ atMs: number; weights: Weights; ms: number }> = [];
  const peakAt = t.antic + 0.4 * t.stroke;
  if (t.antic > 0 && Math.abs(q.a) > 0.3)
    out.push({
      atMs: 0,
      weights: { surprised: 0.7 * u01(q.time) * Math.abs(q.a), aa: 0.25 * pos(q.v), blink: 0 },
      ms: Math.round(Math.max(200, peakAt)),
    });
  out.push({
    atMs: Math.round(peakAt),
    weights: Object.fromEntries(
      Object.entries(apex)
        .map(([p, w]) => [p, Math.round(Math.min(1, (w ?? 0) * k) * 100) / 100])
        .filter(([, w]) => (w as number) > 0.04),
    ),
    ms: Math.max(200, Math.round(endOf(t) - peakAt - 0.5 * t.back)),
  });
  return out;
};

/** Where she looks: up with a rising joy, down when drained, away when small, roving when indirect; then him. */
const looks = (
  q: Qualities,
  t: Timing,
  focus: Perform["focus"],
): Array<{ atMs: number; x: number; y: number; ms: number }> => {
  if (focus !== undefined && focus.length > 0)
    return focus.map((f, i) => ({
      atMs: f.atMs,
      x: c1(f.x),
      y: c1(f.y),
      ms: Math.max(200, (focus[i + 1]?.atMs ?? endOf(t)) - f.atMs),
    }));
  const out: Array<{ atMs: number; x: number; y: number; ms: number }> = [];
  const after = t.antic + t.stroke;
  const away = pos(-q.d - 0.2);
  const up = pos(q.rise) * pos(q.a);
  const down = pos(-q.rise) * pos(-q.a);
  const rove = pos(-q.space - 0.3);
  if (up > 0.3)
    out.push({ atMs: Math.round(t.antic), x: 0, y: 0.5 * up, ms: Math.round(t.stroke + t.settle) });
  if (down > 0.2)
    out.push({ atMs: Math.round(after), x: 0, y: -0.5 * down, ms: Math.round(t.hold) });
  if (away > 0.1)
    out.push({ atMs: Math.round(after), x: 0.45, y: -0.4 * away, ms: Math.round(0.6 * t.hold) });
  if (rove > 0.05)
    for (let i = 0; i < 3; i += 1)
      out.push({
        atMs: Math.round(after + (i * t.hold) / 3),
        x: i % 2 === 0 ? 0.5 : -0.5,
        y: 0.15,
        ms: Math.round(t.hold / 3),
      });
  // eyes on him when nothing else draws them: a direct, engaged moment says so
  if (out.length === 0) out.push({ atMs: 0, x: 0, y: 0, ms: Math.round(endOf(t)) });
  return out.toSorted((a, b) => a.atMs - b.atMs);
};

/**
 * Where on (or around) her body a place is, for one hand, on the T-pose reference body her poses are written for (the
 * rig maps them onto each model), from the base posture's bones: so a hand to her mouth finds her mouth sitting too.
 */
const placeOf = (place: HandPlace, side: "left" | "right", base: Pose, apart: number): V3 => {
  const w = fk(
    REFERENCE_RIG,
    Object.fromEntries(Object.entries(base).map(([b, e]) => [b, qFromEuler(e as V3)])),
  );
  const s = REFERENCE_RIG.height / 1.6;
  const trunk = w.rot["upperChest"] ?? w.rot["chest"]!;
  const f = qRotate(trunk, [0, 0, 1]);
  const u = qRotate(trunk, [0, 1, 0]);
  const x = v3.scale(qRotate(trunk, [1, 0, 0]), side === "left" ? 1 : -1);
  const head = v3.add(w.pos["head"]!, v3.scale(u, 0.08 * s));
  const shoulder = w.pos[`${side}UpperArm`]!;
  const at = (o: V3, ...k: Array<[V3, number]>) =>
    k.reduce((p, [d, m]) => v3.add(p, v3.scale(d, m * s)), o);
  const spot = {
    together: at(w.pos["upperChest"]!, [f, 0.3], [u, -0.06], [x, 0.03 + apart]),
    mouth: at(head, [f, 0.1 + apart], [u, -0.05], [x, 0.02]),
    face: at(head, [f, 0.11 + apart], [x, 0.04]),
    brow: at(head, [f, 0.1], [u, 0.03 + apart], [x, 0.05]),
    ear: at(head, [x, 0.09 + apart]),
    head: at(head, [u, 0.11 + apart], [x, 0.03]),
    heart: at(w.pos["upperChest"]!, [f, 0.13 + apart], [u, -0.02], [x, 0.04]),
    hip: at(w.pos["hips"]!, [x, 0.15 + apart], [u, 0.04]),
    shoulder: at(w.pos[`${side === "left" ? "right" : "left"}UpperArm`]!, [f, 0.06 + apart]),
    forward: at(shoulder, [f, 0.52], [u, -0.05 + apart]),
    up: at(shoulder, [u, 0.58], [x, 0.08 + apart]),
    out: at(shoulder, [x, 0.55], [u, -0.05 + apart]),
  } satisfies Record<HandPlace, V3>;
  return spot[place];
};
/** Where each hand is on her body in a pose, by the nearest place within a hand's breadth (her proprioception, and the eval's words). */
export const handPlacesIn = (pose: Pose): Partial<Record<"left" | "right", HandPlace>> => {
  const w = fk(
    REFERENCE_RIG,
    Object.fromEntries(Object.entries(pose).map(([b, e]) => [b, qFromEuler(e as V3)])),
  );
  const out: Partial<Record<"left" | "right", HandPlace>> = {};
  for (const side of SIDES) {
    const hand = w.pos[`${side}Hand`];
    if (hand === undefined) continue;
    let best: { place: HandPlace; d: number } | null = null;
    for (const place of HAND_PLACES) {
      const d = Math.hypot(...v3.sub(hand, placeOf(place, side, pose, 0)));
      if (d < 0.1 && (best === null || d < best.d)) best = { place, d };
    }
    if (best !== null) out[side] = best.place;
  }
  return out;
};
/** The arm, as Euler bones, that brings a hand to its place (two-bone IK on the reference body). */
const armTo = (base: Pose, side: "left" | "right", target: V3): Pose => {
  const local: Record<string, Q> = Object.fromEntries(
    Object.entries(base).map(([b, e]) => [b, qFromEuler(e as V3)]),
  );
  const solved = solveLimbs(REFERENCE_RIG, local, { [`${side}Hand`]: target }).pose;
  const out: Record<string, Euler> = {};
  for (const b of [`${side}UpperArm`, `${side}LowerArm`])
    if (solved[b] !== undefined)
      out[b] = qToEuler(solved[b]).map((x) => Math.round(x * 1000) / 1000) as unknown as Euler;
  return out;
};
/** Each placed hand's arm there, and a little apart (for a beat), over the base posture. */
const handArms = (p: Perform, base: Pose): { at: Pose; apart: Pose } | null => {
  if (p.hands === undefined) return null;
  const at: Record<string, Euler> = {};
  const apart: Record<string, Euler> = {};
  for (const side of SIDES) {
    const place = p.hands[side];
    if (place === undefined) continue;
    Object.assign(at, armTo(base, side, placeOf(place, side, base, 0)));
    Object.assign(apart, armTo(base, side, placeOf(place, side, base, 0.12)));
  }
  return Object.keys(at).length === 0 ? null : { at, apart };
};

export const PERFORM_FPS = 30;
/**
 * A performance as cues the body already plays: one clip over its base posture (released at its end, so she is
 * hers again), and its faces and looks on her own clock. Every joint is slowed until it is within human speed.
 */
export const performCues = (
  p: Perform,
  base: Pose = {},
  grounded = false,
  id = "perform",
  /** What the agent placed itself, kept as placed; `look` and `face` it gave in the same step win over composed ones. */
  own: {
    readonly bones?: Pose;
    readonly keys?: Keys;
    readonly look?: boolean;
    readonly face?: boolean;
  } = {},
): { readonly cues: BodyCue[]; readonly ms: number } => {
  const q = qualitiesOf(p);
  const delta = apexDelta(q, grounded);
  const keysEnd = own.keys?.at(-1)?.atMs ?? 0;
  let t = timingOf(q, p.ms === undefined && keysEnd > 0 ? Math.max(keysEnd + 800, 2400) : p.ms);
  const hands = handArms(p, { ...base, ...own.bones });
  const hz = Math.max(0, Math.min(6, p.hands?.repeat ?? 0));
  const skill = p.hands?.skill;
  /** Both hands in their skill `ms` in: carried there on the performance's phrasing, its rhythm through the hold. */
  const skillAt = (tm: Timing, ms: number): Pose => {
    if (skill === undefined) return {};
    const beatFrom = tm.antic + tm.stroke + tm.settle;
    const from = { ...base, ...own.bones };
    const there = twoHandsAt(
      skill,
      {
        ...(hz > 0 ? { rate: hz } : {}),
        intensity: q.k,
        ...(p.hands?.style === undefined ? {} : { style: p.hands.style }),
      },
      from,
      Math.min(tm.hold, ms - beatFrom) / 1000,
    );
    const out: Record<string, Euler> = {};
    // one envelope for both arms: staggered joints would carry one palm through the other on the way in
    const e = Math.max(0, Math.min(1, envelope(tm, ms - ORDER("leftUpperArm") * tm.stagger)));
    for (const [b, to] of Object.entries(there)) {
      out[b] = /Fingers$/.test(b)
        ? (to.map((x) => Math.round(x * e * 100) / 100) as unknown as Euler)
        : (qToEuler(
            qSlerp(qFromEuler((from[b as PoseBone] ?? [0, 0, 0]) as V3), qFromEuler(to as V3), e),
          ).map((x) => Math.round(x * 1000) / 1000) as unknown as Euler);
    }
    return out;
  };
  /** A placed hand's arm `ms` in: carried there on the performance's own phrasing, beating through the hold. */
  const handsAt = (tm: Timing, ms: number): Pose => {
    if (skill !== undefined) return skillAt(tm, ms);
    if (hands === null) return {};
    const out: Record<string, Euler> = {};
    const beatFrom = tm.antic + tm.stroke + tm.settle;
    const beat =
      hz > 0 && ms > beatFrom && ms < beatFrom + tm.hold
        ? 0.5 - 0.5 * Math.cos(2 * Math.PI * hz * ((ms - beatFrom) / 1000))
        : 0;
    // as rotations, not angle by angle: a solved arm can sit where Euler angles wrap
    for (const [b, to] of Object.entries(hands.at)) {
      const e = Math.max(0, Math.min(1, envelope(tm, ms - ORDER(b) * tm.stagger)));
      const from = qFromEuler((base[b as PoseBone] ?? [0, 0, 0]) as V3);
      const there = qSlerp(
        qFromEuler(to as V3),
        qFromEuler((hands.apart[b as PoseBone] ?? to) as V3),
        beat,
      );
      out[b] = qToEuler(qSlerp(from, there, e)).map(
        (x) => Math.round(x * 1000) / 1000,
      ) as unknown as Euler;
    }
    return out;
  };
  const sample = (tm: Timing) => {
    const end = endOf(tm);
    const frames: Pose[] = [];
    for (let ms = 0; ms <= end; ms += 1000 / PERFORM_FPS)
      frames.push(
        frameAt(base, delta, q, tm, ms, grounded, {
          bones: { ...handsAt(tm, ms), ...own.bones },
          keys: own.keys,
        }),
      );
    return frames;
  };
  let frames = sample(t);
  const ratio = speedRatio(frames, PERFORM_FPS);
  if (ratio > 1) {
    t = timingOf(q, p.ms, ratio * 1.05);
    frames = sample(t);
  }
  const ms = Math.round(endOf(t));
  const timed: Array<{ atMs: number; cues: BodyCue[] }> = [
    ...(own.face === true ? [] : faces(q, t)).map((f) => ({
      atMs: f.atMs,
      cues: [{ kind: "face", weights: f.weights, ms: f.ms } as const],
    })),
    ...(own.look === true && p.focus === undefined ? [] : looks(q, t, p.focus)).map((l) => ({
      atMs: l.atMs,
      cues: [{ kind: "gaze", x: l.x, y: l.y, ms: l.ms } as const],
    })),
  ].toSorted((a, b) => a.atMs - b.atMs);
  const now = timed.filter((s) => s.atMs === 0).flatMap((s) => s.cues);
  const later = timed.filter((s) => s.atMs > 0);
  return {
    ms,
    cues: [
      ...now,
      ...(later.length === 0 ? [] : [{ kind: "seq", steps: later } as const]),
      {
        kind: "clip",
        id,
        fps: PERFORM_FPS,
        loop: false,
        grounded,
        frames,
        // her springs follow the composed curve closely: the phrasing is already in it
        ms: 100,
        // she is hers again when it ends: the clip lets go, and her posture (the same base) carries on
        lapseMs: ms + 100,
      },
    ],
  };
};

/**
 * The involuntary systems (M-070's two layers), as data a pack can extend: what drives each, what it moves, and what
 * a voluntary hold may do to it. She can hold her breath, keep from blinking or smiling, and keep still, each to a
 * human limit; she cannot stop a reflex. Breath holds: untrained adults reach about 30–90 s; blinks: about 10–30 s.
 */
export interface InvoluntarySystem {
  readonly id: string;
  readonly drives: ReadonlyArray<string>;
  readonly channels: ReadonlyArray<string>;
  readonly override: {
    readonly allowed: boolean;
    readonly maxHoldMs: number;
    readonly floor: number;
  };
}
export const INVOLUNTARY: ReadonlyArray<InvoluntarySystem> = [
  {
    id: "breath",
    drives: ["arousal", "effort", "speech"],
    channels: ["bones:chest"],
    override: { allowed: true, maxHoldMs: 30_000, floor: 0 },
  },
  {
    id: "blink",
    drives: ["time", "startle"],
    channels: ["face:blink"],
    override: { allowed: true, maxHoldMs: 10_000, floor: 0 },
  },
  {
    id: "saccade",
    drives: ["blink", "attention"],
    channels: ["gaze"],
    override: { allowed: true, maxHoldMs: 20_000, floor: 0 },
  },
  {
    id: "moodLeak",
    drives: ["mood"],
    channels: ["face", "posture"],
    override: { allowed: true, maxHoldMs: 8000, floor: 0.25 },
  },
  {
    id: "tremor",
    drives: ["effort", "fear"],
    channels: ["bones:hands"],
    override: { allowed: false, maxHoldMs: 0, floor: 1 },
  },
  {
    id: "withdrawal",
    drives: ["touch:nociceptive"],
    channels: ["bones"],
    override: { allowed: false, maxHoldMs: 0, floor: 1 },
  },
  {
    id: "startle",
    drives: ["sudden stimulus"],
    channels: ["bones", "face"],
    override: { allowed: false, maxHoldMs: 0, floor: 1 },
  },
  {
    id: "balance",
    drives: ["centre of mass"],
    channels: ["bones:legs"],
    override: { allowed: false, maxHoldMs: 0, floor: 1 },
  },
  {
    id: "flush",
    drives: ["arousal", "embarrassment"],
    channels: ["skin"],
    override: { allowed: false, maxHoldMs: 0, floor: 1 },
  },
];
const SYSTEMS = new Map(INVOLUNTARY.map((s) => [s.id, s]));

/** A voluntary hold on her involuntary systems, checked against their rules: each held only as long as a person can. */
export const decodeHold = (
  raw: unknown,
):
  | { readonly ok: true; readonly hold: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly error: string } => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "hold is {system: ms}, e.g. {breath: 5000}" };
  const hold: Record<string, number> = {};
  for (const [id, v] of Object.entries(raw)) {
    const s = SYSTEMS.get(id);
    if (s === undefined)
      return {
        ok: false,
        error: `hold names a system: ${INVOLUNTARY.filter((x) => x.override.allowed)
          .map((x) => x.id)
          .join(", ")}`,
      };
    if (!s.override.allowed) return { ok: false, error: `${id} is a reflex: she cannot hold it` };
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
      return { ok: false, error: `hold.${id} is how long in ms` };
    hold[id] = Math.min(v, s.override.maxHoldMs);
  }
  return { ok: true, hold };
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const n11 = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? c1(v) : undefined;
const dims = <K extends string>(v: unknown, keys: ReadonlyArray<K>): Partial<Record<K, number>> =>
  isObj(v)
    ? (Object.fromEntries(
        keys.flatMap((k) => (n11(v[k]) === undefined ? [] : [[k, n11(v[k])!]])),
      ) as Partial<Record<K, number>>)
    : {};
/** A performance off the wire, bounded; errors say how to fix it. */
export const decodePerform = (
  raw: unknown,
):
  | { readonly ok: true; readonly perform: Perform }
  | { readonly ok: false; readonly error: string } => {
  if (!isObj(raw) || !isObj(raw["feel"]))
    return {
      ok: false,
      error: "perform needs feel: {valence, arousal, dominance}, each -1 to 1",
    };
  const f = raw["feel"];
  const [valence, arousal, dominance] = [f["valence"], f["arousal"], f["dominance"]].map(n11);
  if (valence === undefined || arousal === undefined || dominance === undefined)
    return { ok: false, error: "perform.feel needs valence, arousal and dominance, each -1 to 1" };
  const focus = Array.isArray(raw["focus"])
    ? raw["focus"]
        .slice(0, 8)
        .filter(isObj)
        .map((l) => ({
          x: n11(l["x"]) ?? 0,
          y: n11(l["y"]) ?? 0,
          atMs: Math.max(0, Math.min(15_000, typeof l["atMs"] === "number" ? l["atMs"] : 0)),
        }))
        .toSorted((a, b) => a.atMs - b.atMs)
    : undefined;
  const ms = typeof raw["ms"] === "number" && Number.isFinite(raw["ms"]) ? raw["ms"] : undefined;
  const intensity = n11(raw["intensity"]);
  const h = raw["hands"];
  const placeOk = (v: unknown): v is HandPlace =>
    (HAND_PLACES as ReadonlyArray<unknown>).includes(v);
  if (isObj(h) && [h["left"], h["right"]].some((v) => v !== undefined && !placeOk(v)))
    return { ok: false, error: `perform.hands places are ${HAND_PLACES.join(", ")}` };
  if (isObj(h) && h["skill"] !== undefined && !isTwoHandSkill(h["skill"]))
    return {
      ok: false,
      error: `perform.hands.skill is one of ${Object.keys(TWO_HAND_SKILLS).join(", ")}`,
    };
  const hands = isObj(h)
    ? {
        ...(placeOk(h["left"]) ? { left: h["left"] } : {}),
        ...(placeOk(h["right"]) ? { right: h["right"] } : {}),
        ...(typeof h["repeat"] === "number" && Number.isFinite(h["repeat"])
          ? { repeat: Math.max(0, Math.min(6, h["repeat"])) }
          : {}),
        ...(isTwoHandSkill(h["skill"]) ? { skill: h["skill"] } : {}),
        ...(isTwoHandSkill(h["skill"]) &&
        (TWO_HAND_SKILLS[h["skill"]] as ReadonlyArray<unknown>).includes(h["style"])
          ? { style: h["style"] as string }
          : {}),
      }
    : undefined;
  return {
    ok: true,
    perform: {
      feel: { valence, arousal, dominance },
      effort: dims(raw["effort"], ["weight", "time", "space", "flow"] as const),
      shape: dims(raw["shape"], ["rise", "advance", "spread"] as const),
      ...(intensity === undefined ? {} : { intensity: pos(intensity) }),
      ...(ms === undefined ? {} : { ms: Math.max(1200, Math.min(15_000, ms)) }),
      ...(focus === undefined || focus.length === 0 ? {} : { focus }),
      ...(hands === undefined ||
      (hands.left === undefined && hands.right === undefined && hands.skill === undefined)
        ? {}
        : { hands }),
    },
  };
};
