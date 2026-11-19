/**
 * Her walk on any skeleton: real steps, each planted foot still while the world carries her (the renderer pins her
 * hips). Cadence and stance follow adult gait norms (Grieve & Gear 1966, Perry 1992), scaled by her height; the
 * pelvis rises over the planted leg and drops as the next heel lands, and the arms swing against the legs.
 */
import type { Euler, PoseBone } from "./bodyMotion.ts";
import {
  fk,
  len,
  qConj,
  qFromEuler,
  qRotate,
  qToEuler,
  QI,
  v3,
  type Q,
  type Rig,
  type V3,
} from "./bodyRig.ts";

const sub = v3.sub;
const add3 = v3.add;
const rotX = (v: V3, a: number): V3 => qRotate(qFromEuler([a, 0, 0]), v);

/** Gait styles as data: what each changes from a plain walk. */
export const GAIT_STYLES = {
  stroll: {
    speed: 1,
    cadence: 1,
    stance: 0.62,
    lift: 0.07,
    crouch: 0,
    heel: 0,
    bob: 1,
    lean: 0.03,
    arms: 1,
  },
  sneak: {
    speed: 0.45,
    cadence: 0.7,
    stance: 0.72,
    lift: 0.1,
    crouch: 0.35,
    heel: 0.15,
    bob: 0.4,
    lean: 0.18,
    arms: 0.2,
  },
  bounce: {
    speed: 1,
    cadence: 1.15,
    stance: 0.55,
    lift: 0.1,
    crouch: 0.05,
    heel: 0.2,
    bob: 2.4,
    lean: 0,
    arms: 1.4,
  },
  stomp: {
    speed: 0.9,
    cadence: 0.9,
    stance: 0.6,
    lift: 0.13,
    crouch: 0.1,
    heel: 0,
    bob: 1.6,
    lean: 0.1,
    arms: 1.3,
  },
  tiptoe: {
    speed: 0.5,
    cadence: 1.1,
    stance: 0.6,
    lift: 0.05,
    crouch: 0.05,
    heel: 1,
    bob: 0.6,
    lean: 0.02,
    arms: 0.4,
  },
} as const;
export type GaitStyle = keyof typeof GAIT_STYLES;
export const isGaitStyle = (s: unknown): s is GaitStyle =>
  typeof s === "string" && Object.hasOwn(GAIT_STYLES, s);

/** Walking speed (m/s on a 1.7 m adult) for speed 0 (a stroll) to 1 (hurrying). */
const speedOf = (speed: number) => 0.8 + 1.0 * Math.max(0, Math.min(1, speed));
/** Steps a second at a walking speed (m/s, height-normalised): linear in the normal range of adult walking. */
const cadenceOf = (v: number) => 1.0 + 0.75 * v;

export interface Gait {
  /** Her body's speed over the floor (m/s, her own scale) and steps a second. */
  readonly speed: number;
  readonly cadence: number;
  readonly stance: number;
  readonly style: GaitStyle;
}
export const gaitOf = (rig: Rig, speed: number, style: GaitStyle = "stroll"): Gait => {
  const s = GAIT_STYLES[style];
  const scale = rig.height / 1.7;
  const v = speedOf(speed) * s.speed;
  return {
    speed: v * scale,
    cadence: cadenceOf(v) * s.cadence,
    // hurrying shortens stance toward running's
    stance: s.stance - 0.06 * Math.max(0, Math.min(1, speed)),
    style,
  };
};

const mj = (p: number) => {
  const x = Math.max(0, Math.min(1, p));
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

export interface GaitFrame {
  readonly bones: Partial<Record<PoseBone, Euler>>;
  /** Her speed over the floor at this frame (m/s, her heading): the world carries her by it. */
  readonly speed: number;
  /** Each foot's target (world, rig space with hips pinned) and whether it is planted. */
  readonly feet: Readonly<Record<"left" | "right", { readonly at: V3; readonly planted: boolean }>>;
}

/**
 * One frame `t` seconds into a walk over a base posture, on this rig. `ramp` (0..1) eases the stride in and out at the
 * start and end, so a walk begins and stops with short steps, never a cut.
 */
export const gaitAt = (
  rig: Rig,
  gait: Gait,
  t: number,
  base: Partial<Record<PoseBone, Euler>> = {},
  ramp = 1,
): GaitFrame => {
  const st = GAIT_STYLES[gait.style];
  const h = rig.height / 1.7;
  const k = Math.max(0, Math.min(1, ramp));
  const v = gait.speed * k;
  const period = 2 / gait.cadence;
  const beta = gait.stance;
  const rest = fk(rig, {});
  // half the distance a stance foot travels back under her while planted
  const half = (v * beta * period) / 2;
  const feet = {} as Record<"left" | "right", { at: V3; planted: boolean }>;
  const phaseOf = (s: "left" | "right") => {
    const p = t / period + (s === "left" ? 0 : 0.5);
    return p - Math.floor(p);
  };
  const leg =
    len(sub(rest.pos["leftLowerLeg"]!, rest.pos["leftUpperLeg"]!)) +
    len(sub(rest.pos["leftFoot"]!, rest.pos["leftLowerLeg"]!));
  // the heel lands a little ahead of her; rolling heel to toe covers the rest of the stance
  const z0 = 0.6 * half;
  // an inverted pendulum: her pelvis is highest over the planted foot and lowest as the next heel lands, two bobs a
  // cycle; the knee never locks (about 15 degrees mid-stance, Perry 1992)
  const top = 0.975 * leg;
  const low = Math.sqrt(Math.max(0, top * top - z0 * z0));
  const swayH =
    top -
    (top - low) * (0.5 + 0.5 * Math.cos(4 * Math.PI * (t / period))) * (0.6 + (0.4 * st.bob) / 2.4);
  const crouch = st.crouch * 0.12 * h;
  const footAt = (s: "left" | "right") => rest.pos[`${s}UpperLeg`]![1] - swayH + crouch;
  const toe0 = sub(
    rest.pos["leftToes"] ?? add3(rest.pos["leftFoot"]!, [0, -0.05 * h, 0.12 * h]),
    rest.pos["leftFoot"]!,
  );
  const pitch: Record<"left" | "right", number> = { left: 0, right: 0 };
  for (const s of ["left", "right"] as const) {
    const p = phaseOf(s);
    const hip = rest.pos[`${s}UpperLeg`]!;
    // a step width that keeps the swinging shin clear of the planted one
    const x = hip[0] * 1.1;
    const y0 = footAt(s) + st.heel * 0.05 * h;
    // late stance rolls onto the toes: the toe stays planted while the heel rises
    const heelOff = beta * 0.65;
    let at: V3;
    let planted = true;
    if (p < heelOff) {
      at = [x, y0, z0 - v * p * period];
      pitch[s] = st.heel * 0.5;
    } else if (p < beta) {
      const u = (p - heelOff) / (beta - heelOff);
      const th = st.heel * 0.5 + 0.55 * k * mj(u);
      const toe = add3([x, y0, z0 - v * heelOff * period], toe0);
      const toeNow: V3 = [toe[0], toe[1], toe[2] - v * (p - heelOff) * period];
      at = sub(toeNow, rotX(toe0, th));
      pitch[s] = th;
      // toe-off: the last of the stance is the toe leaving the floor, no longer bearing weight
      planted = u < 0.75;
    } else {
      const u = (p - beta) / (1 - beta);
      // swing: from where push-off left the ankle to the next heel strike, lifted clear
      const th = (st.heel * 0.5 + 0.55 * k) * (1 - mj(u * 1.6));
      const toe = add3([x, y0, z0 - v * heelOff * period], toe0);
      const from = sub(
        [toe[0], toe[1], toe[2] - v * (beta - heelOff) * period],
        rotX(toe0, st.heel * 0.5 + 0.55 * k),
      );
      const to: V3 = [x, y0, z0];
      const w = mj(u);
      at = [
        x,
        from[1] + (to[1] - from[1]) * w + st.lift * h * k * Math.sin(Math.PI * u) ** 1.5,
        from[2] + (to[2] - from[2]) * w,
      ];
      pitch[s] = th;
      planted = false;
    }
    feet[s] = { at, planted };
  }
  // pelvis turns toward the swinging leg and lists toward the stance side; trunk turns against it; arms swing
  const swing = Math.sin(2 * Math.PI * (t / period));
  const amp = k * Math.min(1, v / h / 1.2);
  const pose: Record<string, Q> = Object.fromEntries(
    Object.entries(base).map(([b, e]) => [b, qFromEuler(e as V3)]),
  );
  const add = (b: string, e: Euler) => {
    const was = base[b as PoseBone] ?? [0, 0, 0];
    pose[b] = qFromEuler([was[0] + e[0], was[1] + e[1], was[2] + e[2]]);
  };
  add("hips", [st.lean * 0.3, 0.07 * amp * swing, 0.04 * amp * swing]);
  add("spine", [st.lean, -0.05 * amp * swing, -0.02 * amp * swing]);
  add("chest", [0, -0.04 * amp * swing, 0]);
  add("leftUpperArm", [0, -0.3 * st.arms * amp * swing, 0]);
  add("rightUpperArm", [0, -0.3 * st.arms * amp * swing, 0]);
  add("leftLowerArm", [0, -0.2 - 0.15 * st.arms * amp, 0]);
  add("rightLowerArm", [0, 0.2 + 0.15 * st.arms * amp, 0]);
  // each leg in its own plane, solved exactly (hip flexion, knee flexion, a little abduction): no pole to flip, so
  // a planted foot stays where it is from frame to frame
  const solved: Record<string, Q> = { ...pose };
  const hipsQ = pose["hips"] ?? QI;
  for (const s of ["left", "right"] as const) {
    const hip = rest.pos[`${s}UpperLeg`]!;
    const l1 = len(sub(rest.pos[`${s}LowerLeg`]!, hip));
    const l2 = len(sub(rest.pos[`${s}Foot`]!, rest.pos[`${s}LowerLeg`]!));
    // the target in the pelvis's own frame (she leans and turns her hips as she walks)
    const hipNow = add3(rest.pos["hips"]!, qRotate(hipsQ, sub(hip, rest.pos["hips"]!)));
    // her rest leg is not quite straight down: aim again by what the last solve missed, until the foot is there
    let aim = feet[s].at;
    let knee = 0;
    let flex = 0;
    for (let pass = 0; pass < 3; pass++) {
      const rel = qRotate(qConj(hipsQ), sub(aim, hipNow));
      const down = -rel[1];
      const reach = Math.min(l1 + l2 - 1e-4, Math.hypot(rel[2], down));
      knee =
        Math.PI -
        Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - reach * reach) / (2 * l1 * l2))));
      const toward = Math.atan2(rel[2], down);
      const inner = Math.acos(
        Math.max(-1, Math.min(1, (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach))),
      );
      flex = toward + inner;
      const out = Math.atan2(rel[0], down) * (s === "left" ? 1 : -1);
      solved[`${s}UpperLeg`] = qFromEuler([-flex, 0, s === "left" ? out : -out]);
      solved[`${s}LowerLeg`] = qFromEuler([knee, 0, 0]);
      const got = fk(rig, solved).pos[`${s}Foot`]!;
      aim = add3(aim, sub(feet[s].at, got));
    }
    // the foot pitched in the world as its phase wants (flat, rolling onto the toes), within the ankle's range
    const footX = pitch[s] + flex - knee - qToEuler(hipsQ)[0];
    solved[`${s}Foot`] = qFromEuler([Math.max(-0.6, Math.min(0.8, footX)), 0, 0]);
  }
  const bones: Partial<Record<PoseBone, Euler>> = {};
  for (const b of [
    "hips",
    "spine",
    "chest",
    "leftUpperArm",
    "rightUpperArm",
    "leftLowerArm",
    "rightLowerArm",
    "leftUpperLeg",
    "rightUpperLeg",
    "leftLowerLeg",
    "rightLowerLeg",
    "leftFoot",
    "rightFoot",
  ] as const)
    if (solved[b] !== undefined)
      bones[b] = qToEuler(solved[b]).map((x) => Math.round(x * 1000) / 1000) as unknown as Euler;
  return { bones, speed: v, feet };
};

/** How long a walk of `metres` takes at this gait, with a step's ramp at each end, in seconds. */
export const walkSeconds = (gait: Gait, metres: number): number =>
  Math.max(0, metres) / Math.max(1e-3, gait.speed) + 2 / gait.cadence;
