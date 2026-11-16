/**
 * One buzz, felt natively on each vessel (R-079). A pattern's intent is one pulse list (the same table as the
 * Tessel's r1bt_haptic.h); each kind of haptic hardware renders it its own way, at a strength matched across devices
 * (level 1-3 is the same share of each motor's range) and corrected by that device's own feel test (`gain`).
 */
import type { HapticPattern } from "./expressionMap.ts";

/** Android's VibrationEffect.Composition primitives this map uses. */
export type AndroidPrimitive = "CLICK" | "TICK" | "THUD" | "QUICK_RISE";

/** What a vessel's motor is, as its manifest declares it. */
export type HapticHardware =
  /** An ERM coin behind firmware that owns the pulses (the Tessel, Tumble and Tuft bodies): it takes a name. */
  | { readonly kind: "erm" }
  /** iPhone's Taptic Engine through Core Haptics: transients and continuous events, intensity and sharpness. */
  | { readonly kind: "core-haptics" }
  /** An Android vibrator: the primitives it supports, and whether it controls amplitude. */
  | {
      readonly kind: "android";
      readonly primitives: ReadonlyArray<AndroidPrimitive>;
      readonly amplitude: boolean;
    };

/** strength 0-1 of the level, on and gap in ms. */
interface Pulse {
  readonly strength: number;
  readonly on: number;
  readonly gap: number;
}
const p = (pct: number, on4: number, gap4: number): Pulse => ({
  strength: pct / 100,
  on: on4 * 4,
  gap: gap4 * 4,
});

/** Each pattern's intent: its pulses (r1bt_haptic.h's, in 4 ms units there), how crisp it is, and its Android primitive. */
const INTENT: Readonly<
  Record<
    HapticPattern,
    {
      readonly pulses: ReadonlyArray<Pulse>;
      readonly sharpness: number;
      readonly primitive: AndroidPrimitive | null;
    }
  >
> = {
  tap: { pulses: [p(100, 10, 0)], sharpness: 0.8, primitive: "CLICK" },
  double_tap: { pulses: [p(100, 10, 23), p(100, 10, 0)], sharpness: 0.8, primitive: "CLICK" },
  // A rolling hum: continuous wherever the hardware can hold one, never a run of clicks.
  purr: {
    pulses: [p(45, 45, 5), p(35, 45, 5), p(45, 45, 5), p(35, 45, 0)],
    sharpness: 0.1,
    primitive: null,
  },
  giggle: {
    pulses: [p(90, 9, 11), p(80, 9, 11), p(70, 9, 11), p(60, 9, 11), p(50, 9, 0)],
    sharpness: 0.6,
    primitive: "TICK",
  },
  startle: { pulses: [p(100, 30, 0)], sharpness: 0.5, primitive: "QUICK_RISE" },
  thump: { pulses: [p(60, 28, 0)], sharpness: 0.2, primitive: "THUD" },
  heartbeat: {
    pulses: [p(85, 11, 28), p(60, 14, 150), p(85, 11, 28), p(60, 14, 0)],
    sharpness: 0.3,
    primitive: "THUD",
  },
  nudge: { pulses: [p(90, 18, 45), p(90, 18, 0)], sharpness: 0.5, primitive: "CLICK" },
};

/**
 * Level 1-3 as a share of each motor's usable range, matching r1bt_haptic.h's LVL (0.3.151+), where the range starts
 * at the coin's stall floor, not at zero.
 */
const LEVEL_SHARE = { 1: 0.4, 2: 0.7, 3: 1 } as const;
/** A pulse this short is a tap (a transient); longer is held (continuous). */
const TRANSIENT_MS = 50;

export type HapticRendering =
  | { readonly kind: "erm"; readonly p: HapticPattern; readonly lvl: 1 | 2 | 3 }
  | {
      readonly kind: "core-haptics";
      readonly events: ReadonlyArray<{
        readonly type: "transient" | "continuous";
        readonly at: number;
        readonly duration?: number;
        readonly intensity: number;
        readonly sharpness: number;
      }>;
    }
  | {
      readonly kind: "android-composition";
      readonly primitives: ReadonlyArray<{
        readonly primitive: AndroidPrimitive;
        readonly scale: number;
        readonly delay: number;
      }>;
    }
  | {
      readonly kind: "android-waveform";
      readonly timings: ReadonlyArray<number>;
      readonly amplitudes: ReadonlyArray<number>;
    }
  | { readonly kind: "android-timing"; readonly timings: ReadonlyArray<number> };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A pattern at a level on one kind of hardware. `gain` is the device's feel-test correction (1 = as designed). Android
 * takes primitives when it has every one the pattern needs, else a waveform with amplitudes, else plain timing.
 */
export const renderHaptic = (
  hw: HapticHardware,
  pattern: HapticPattern,
  level: 1 | 2 | 3,
  gain = 1,
): HapticRendering => {
  if (hw.kind === "erm") return { kind: "erm", p: pattern, lvl: level };
  const intent = INTENT[pattern];
  const strength = (s: number) => round2(clamp01(s * LEVEL_SHARE[level] * gain));
  if (hw.kind === "core-haptics") {
    let at = 0;
    return {
      kind: "core-haptics",
      events: intent.pulses.map((pulse) => {
        const event =
          pulse.on <= TRANSIENT_MS
            ? {
                type: "transient" as const,
                at,
                intensity: strength(pulse.strength),
                sharpness: intent.sharpness,
              }
            : {
                type: "continuous" as const,
                at,
                duration: pulse.on,
                intensity: strength(pulse.strength),
                sharpness: intent.sharpness,
              };
        at += pulse.on + pulse.gap;
        return event;
      }),
    };
  }
  const primitive = intent.primitive;
  if (primitive !== null && hw.primitives.includes(primitive))
    return {
      kind: "android-composition",
      primitives: intent.pulses.map((pulse, i) => ({
        primitive,
        scale: strength(pulse.strength),
        delay: i === 0 ? 0 : intent.pulses[i - 1]!.gap,
      })),
    };
  // Waveform and timing both start with an off segment, then alternate on and off.
  const timings = [0, ...intent.pulses.flatMap((pulse) => [pulse.on, pulse.gap])].filter(
    (t, i, all) => i < all.length - 1 || t > 0,
  );
  if (hw.amplitude)
    return {
      kind: "android-waveform",
      timings,
      amplitudes: timings.map((_, i) =>
        i % 2 === 1
          ? Math.max(1, Math.round(255 * strength(intent.pulses[(i - 1) / 2]!.strength)))
          : 0,
      ),
    };
  return { kind: "android-timing", timings };
};

export type FeelRating = "weak" | "right" | "strong";
/**
 * A device's gain from its feel test: each "too weak" asks for a quarter more, each "too strong" a fifth less, averaged
 * over the patterns rated, on top of the gain it had; bounded so one bad test cannot mute or max a motor.
 */
export const gainFromFeel = (ratings: ReadonlyArray<FeelRating>, before = 1): number => {
  if (ratings.length === 0) return before;
  const step = { weak: 1.25, right: 1, strong: 0.8 } as const;
  const mean = ratings.reduce((sum, r) => sum + step[r], 0) / ratings.length;
  return round2(Math.min(2, Math.max(0.4, before * mean)));
};
