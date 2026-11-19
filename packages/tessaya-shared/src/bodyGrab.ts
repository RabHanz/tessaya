/**
 * A hand that holds her (M-072): a constraint between a point on her (skin, hair, clothes, an accessory) and a hand,
 * with a break force. The pull travels into the bones it hangs from, capped inside human range; what they cannot give
 * stretches what is held, which her nerves feel. She can pull free. Pure.
 */
import { dot, len, v3, type V3 } from "./bodyRig.ts";

const GRAB_KINDS = ["skin", "hair", "cloth", "accessory"] as const;
export type GrabKind = (typeof GRAB_KINDS)[number];

/**
 * The bones a pull on each root moves, nearest the pull last: each takes its share of the turn it would need, up to
 * its own cap (radians, inside the AAOS active ranges: cervical rotation 60–80°, flexion 45°; thoracolumbar ~35°).
 * C1–C2 carries about half of a head turn, so neck and head share it.
 */
const CHAINS: Readonly<Record<string, ReadonlyArray<readonly [string, number, number]>>> = {
  head: [
    ["upperChest", 0.15, 0.1],
    ["neck", 0.5, 0.45],
    ["head", 0.5, 0.4],
  ],
  neck: [
    ["upperChest", 0.2, 0.1],
    ["neck", 0.8, 0.45],
  ],
  upperChest: [
    ["spine", 0.4, 0.2],
    ["chest", 0.35, 0.2],
    ["upperChest", 0.25, 0.15],
  ],
  chest: [
    ["spine", 0.55, 0.2],
    ["chest", 0.45, 0.2],
  ],
  spine: [["spine", 1, 0.2]],
  hips: [["spine", 0.6, 0.15]],
  ...Object.fromEntries(
    (["left", "right"] as const).flatMap((s) => [
      [
        `${s}UpperArm`,
        [
          [`${s}Shoulder`, 0.25, 0.2],
          [`${s}UpperArm`, 0.75, 0.9],
        ],
      ],
      [
        `${s}LowerArm`,
        [
          [`${s}UpperArm`, 0.5, 0.7],
          [`${s}LowerArm`, 0.5, 0.6],
        ],
      ],
      [
        `${s}Hand`,
        [
          [`${s}LowerArm`, 0.5, 0.6],
          [`${s}Hand`, 0.5, 0.5],
        ],
      ],
      [`${s}UpperLeg`, [[`${s}UpperLeg`, 1, 0.12]]],
      [`${s}LowerLeg`, [[`${s}UpperLeg`, 1, 0.12]]],
    ]),
  ),
};
/** The humanoid bone a pull acts through, for a node a grab may hold: a bone in a chain, or the nearest one up. */
export const pullRoot = (bone: string): string | null =>
  CHAINS[bone] !== undefined
    ? bone
    : bone === "upperChest" || bone === "chest"
      ? "chest"
      : bone.endsWith("Foot") || bone.endsWith("Toes")
        ? bone.replace(/Foot|Toes/, "LowerLeg")
        : null;

/**
 * How much each kind gives before it holds: a lock of hair or a fold of cloth stretches further than skin, and how
 * hard a pull can get (0..1 of a firm full pull) before the hold breaks. An accessory's clasp gives first.
 */
const KIND: Readonly<Record<GrabKind, { readonly slack: number; readonly breaks: number }>> = {
  skin: { slack: 0.03, breaks: 1.3 },
  hair: { slack: 0.05, breaks: 1.6 },
  cloth: { slack: 0.08, breaks: 1.8 },
  accessory: { slack: 0.04, breaks: 1.1 },
};
/** A pull of this far (m) is a full one; each m/s of the hand adds this much more (a yank pulls harder than a tug). */
const FULL_PULL_M = 0.12;
const SPEED_GAIN = 0.6;

export interface Grab {
  readonly kind: GrabKind;
  /** The bone the pull acts through (pullRoot). */
  readonly root: string;
  /** Where she was held, as it sits with her pose before the pull (so her give never feeds back into the pull). */
  readonly anchor: V3;
}
export interface PullAnswer {
  /** World turns to add on top of her pose (axis, radians), bone by bone, root first. */
  readonly turns: ReadonlyArray<{
    readonly bone: string;
    readonly axis: V3;
    readonly angle: number;
  }>;
  /** 0..~2: how hard it pulls, from how far and how fast. */
  readonly force: number;
  /** 0..1: how far what is held is stretched past its slack, after her bones gave: what her nerves feel. */
  readonly stretch: number;
  /** The hold gave way: too hard, or she pulled free. */
  readonly broke: boolean;
}

/**
 * Her body's answer to a hand at `hand` holding her by `g`, moving at `speed` m/s. `pos` is her bones' world
 * positions before the pull. `free` is her own will to pull away; `stiff` (0..1, her bracing) lessens how far she
 * gives. Each bone in the chain turns about itself so the held point moves toward the hand, by its share and cap.
 */
export const pullOn = (
  g: Grab,
  pos: Readonly<Record<string, V3>>,
  hand: V3,
  speed: number,
  options: { readonly free?: boolean; readonly stiff?: number } = {},
): PullAnswer => {
  const d = v3.sub(hand, g.anchor);
  const reach = len(d);
  const force = reach / FULL_PULL_M + SPEED_GAIN * Math.max(0, speed);
  const broke = options.free === true || force > KIND[g.kind].breaks;
  if (broke || reach < 1e-4) return { turns: [], force, stretch: 0, broke };
  const give = Math.min(1, force) * (1 - 0.6 * Math.max(0, Math.min(1, options.stiff ?? 0)));
  const turns: Array<{ bone: string; axis: V3; angle: number }> = [];
  // root first, each bone takes its share of what is still left between the held point and the hand
  let at = g.anchor;
  for (const [bone, share, cap] of CHAINS[g.root] ?? []) {
    const pivot = pos[bone];
    if (pivot === undefined) continue;
    const left = v3.sub(hand, at);
    const r = v3.sub(at, pivot);
    const rl = len(r);
    if (rl < 1e-4) continue;
    // the part of the pull across the lever turns the bone; along it, nothing does
    const across = v3.sub(left, v3.scale(r, dot(left, r) / (rl * rl)));
    const axis = v3.cross(r, across);
    if (len(axis) < 1e-9) continue;
    const angle = Math.min(cap, share * Math.atan2(len(across), rl) * give);
    turns.push({ bone, axis: v3.unit(axis), angle });
    at = v3.add(at, v3.scale(v3.unit(across), angle * rl));
  }
  const stretch = Math.min(
    1,
    Math.max(0, len(v3.sub(hand, at)) - KIND[g.kind].slack) / FULL_PULL_M,
  );
  return { turns, force, stretch, broke: false };
};

/**
 * Fingers closing around a part of radius `radius` (m): each finger's joint turns (proximal first) so its joints sit
 * on a circle just outside the part, wide enough that no segment's middle passes into it, until the finger curls
 * fully. `segments` are a finger's bone lengths and `thick` its own radius. The base sits on that circle too.
 */
export const wrapCircle = (radius: number, segments: ReadonlyArray<number>, thick: number) =>
  Math.hypot(Math.max(1e-3, radius + thick), Math.max(0, ...segments) / 2);
export const wrapAround = (
  radius: number,
  segments: ReadonlyArray<number>,
  thick: number,
): ReadonlyArray<number> => {
  const R = wrapCircle(radius, segments, thick);
  const turns: number[] = [];
  let total = 0;
  let prev = 0;
  for (const l of segments) {
    // a chord of the circle: it subtends 2·asin(l / 2R), and each joint turns by half of the two it joins
    const a = 2 * Math.asin(Math.min(1, l / (2 * R)));
    const turn = (prev + a) / 2;
    // a finger curls about 270° at most over its three joints (a fist)
    if (total + turn > 4.7) break;
    turns.push(turn);
    total += turn;
    prev = a;
  }
  while (turns.length < segments.length) turns.push(0);
  return turns;
};

/** What a hand closing on her holds, from the names of what it met (VRoid names its meshes and materials so). */
export const grabKindOf = (names: string, springy: boolean): GrabKind =>
  /hair/i.test(names)
    ? "hair"
    : /acc|ribbon|glass|hat|cap\b|ear.?ring|necklace|choker|bag|bow\b|clip|pin\b|crown|tiara/i.test(
          names,
        )
      ? "accessory"
      : /cloth|tops?\b|bottoms?\b|shirt|skirt|dress|jacket|coat|onepiece|sleeve|hood|pants|shorts|sweater|blouse|uniform/i.test(
            names,
          ) || springy
        ? "cloth"
        : "skin";

/** Each root bone's own segment, toward the bone it carries; the head and hands run on a little past their joint. */
const SEGMENT: Readonly<Record<string, string>> = {
  hips: "spine",
  spine: "chest",
  chest: "upperChest",
  upperChest: "neck",
  neck: "head",
  ...Object.fromEntries(
    (["left", "right"] as const).flatMap((s) => [
      [`${s}UpperArm`, `${s}LowerArm`],
      [`${s}LowerArm`, `${s}Hand`],
      [`${s}UpperLeg`, `${s}LowerLeg`],
      [`${s}LowerLeg`, `${s}Foot`],
    ]),
  ),
};
/** The root bone whose segment runs nearest `p`: what a grab of her skin or clothes there pulls on. */
export const nearestRoot = (p: V3, pos: Readonly<Record<string, V3>>): string | null => {
  let best: { bone: string; d: number } | null = null;
  for (const bone of Object.keys(CHAINS)) {
    const a = pos[bone];
    if (a === undefined) continue;
    const b = pos[SEGMENT[bone] ?? ""] ?? v3.add(a, [0, 0.12, 0]);
    const ab = v3.sub(b, a);
    const t = Math.max(0, Math.min(1, dot(v3.sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
    const d = len(v3.sub(p, v3.add(a, v3.scale(ab, t))));
    if (best === null || d < best.d) best = { bone, d };
  }
  return best?.bone ?? null;
};
