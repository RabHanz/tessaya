/**
 * A hand that touches her (M-065 phase 5): one shape for every input. The pointer, an agent, a tracked hand (Leap,
 * later) or a controller each produce frames of the same hand: its palm, how open it is, how hard it presses and how
 * sure the source is. Frames are smoothed and lightly predicted (One Euro filter), and when tracking is lost the hand
 * relaxes and fades instead of freezing. Pure, so every body and its tests share it.
 */
import type { V3 } from "./bodyRig.ts";

export const HAND_SOURCES = [
  "pointer",
  "touch",
  "agent",
  "tracked",
  "controller",
  "keyboard",
] as const;
export type HandSource = (typeof HAND_SOURCES)[number];

export interface HandFrame {
  readonly at: number;
  readonly source: HandSource;
  /** 0..1: how sure the source is that the hand is where it says (a tracker's own confidence; 1 for a pointer). */
  readonly confidence: number;
  /** The palm's centre, the way it faces (unit), and the way the fingers point (unit), in her world. */
  readonly palm: V3;
  readonly normal: V3;
  readonly direction: V3;
  /** 0 open .. 1 fist; a fingertip touch is a point with the rest curled. */
  readonly curl: number;
  /** 0..1 against her: 0 brushing, 1 as firm as the input allows. */
  readonly pressure: number;
  /**
   * Per digit (thumb, index, middle, ring, little), each joint's bend in radians, when the source tracks fingers
   * (Ultraleap: four bones a digit). Absent for a synthesised hand, which bends them all by `curl`.
   */
  readonly digits?: ReadonlyArray<readonly [number, number, number, number]>;
}

/** One Euro filter (Casiez, Roussel & Vogel, 2012): smooth when still, quick when moving; per axis of a point. */
export interface EuroState {
  readonly x: V3;
  readonly dx: V3;
  readonly at: number;
}
const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};
export const euroStep = (
  s: EuroState | null,
  x: V3,
  at: number,
  { minCutoff = 1.2, beta = 0.02, dCutoff = 1 } = {},
): EuroState => {
  if (s === null || at <= s.at) return { x, dx: [0, 0, 0], at };
  const dt = (at - s.at) / 1000;
  const rawDx = x.map((v, i) => (v - s.x[i]!) / dt) as unknown as V3;
  const ad = alpha(dCutoff, dt);
  const dx = rawDx.map((v, i) => s.dx[i]! + ad * (v - s.dx[i]!)) as unknown as V3;
  const out = x.map((v, i) => {
    const a = alpha(minCutoff + beta * Math.abs(dx[i]!), dt);
    return s.x[i]! + a * (v - s.x[i]!);
  }) as unknown as V3;
  return { x: out, dx, at };
};
/** Where the hand will be `aheadMs` from its last frame, from its filtered speed (covers the input's own latency). */
export const predict = (s: EuroState, aheadMs: number): V3 =>
  s.x.map((v, i) => v + s.dx[i]! * (aheadMs / 1000)) as unknown as V3;

/** After the last frame (or a confident one turning unsure) the hand relaxes open and fades over this long. */
export const HAND_FADE_MS = 400;
/** How much of the hand is shown now (0..1), and how far it has relaxed open (0..1). */
export const handPresence = (
  last: HandFrame | null,
  now: number,
): { shown: number; relax: number } => {
  if (last === null) return { shown: 0, relax: 1 };
  const since = Math.max(0, now - last.at);
  const lost = Math.min(1, since / HAND_FADE_MS);
  return { shown: Math.max(0, last.confidence * (1 - lost)), relax: lost };
};

/**
 * A pointer's hand: on her surface at `hit`, palm toward her (`normal` points out of her), sized to her. A short
 * firm press is a fingertip; a slow or long one lays the palm on her; hovering, the fingertips brush.
 */
export const pointerHand = (input: {
  readonly at: number;
  readonly hit: V3;
  readonly normal: V3;
  readonly pressure: number;
  readonly pressed: boolean;
  readonly fingertip: boolean;
  readonly source?: HandSource;
}): HandFrame => {
  const n = input.normal;
  // the fingers point up along her (or across, when the surface faces up or down)
  const up: V3 = Math.abs(n[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const d = up.map(
    (v, i) => v - n[i]! * (up[0] * n[0] + up[1] * n[1] + up[2] * n[2]),
  ) as unknown as V3;
  const l = Math.hypot(...d) || 1;
  return {
    at: input.at,
    source: input.source ?? "pointer",
    confidence: 1,
    palm: input.hit,
    normal: n.map((v) => -v) as unknown as V3,
    direction: d.map((v) => v / l) as unknown as V3,
    curl: input.fingertip ? 0.75 : input.pressed ? 0.1 : 0.3,
    pressure: input.pressed ? Math.max(0.2, input.pressure) : 0.05,
  };
};

/** What she feels of a hand: how much of it meets her (fingertip or palm, in cm²) and how firmly. */
export const handContact = (
  h: HandFrame,
  handLength: number,
): { readonly area: number; readonly pressure: number } => {
  const palmWidth = handLength * 0.45;
  const fingertip = 1.4;
  const palm = palmWidth * 100 * (handLength * 0.5 * 100);
  return {
    area: Math.round(fingertip + (palm - fingertip) * Math.max(0, 1 - h.curl / 0.75)),
    pressure: h.pressure,
  };
};
