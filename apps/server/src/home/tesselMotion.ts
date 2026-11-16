/**
 * The Tessel's motion sensor in, a moment she may answer out (§9.7M S3). Pure: HomeDevices keeps the state per device
 * and does the answering. Firmware 0.3.95+ publishes `event/motion` for every move over its threshold and
 * `state/placement` as it changes; a gentle pick-up often moves only the placement (16 Nov: lifted to carried, no lift).
 */
import type {
  TessayaHapticSettings,
  TessayaMotionSensitivity,
  TessayaMotionSettings,
} from "@t3tools/contracts";
import type { HandledHow } from "@t3tools/tessaya-shared/affect";
import type { HapticPattern } from "@t3tools/tessaya-shared/expressionMap";
import type { LineEvent } from "@t3tools/tessaya-shared/expression";

export interface MotionSeen {
  placement: string | null;
  liftedAt: number;
  /** A voice session is open on it (`event/session/start` to `event/session/end`). */
  live: boolean;
}
export const freshSeen = (): MotionSeen => ({
  placement: null,
  liftedAt: Number.NEGATIVE_INFINITY,
  live: false,
});

export interface MotionMoment {
  readonly how: HandledHow;
  /** Hard enough to cut into a conversation: a drop that landed, a long or hard shake. */
  readonly strong: boolean;
  /** A session or a call is open: only a strong moment speaks. */
  readonly busy: boolean;
}

const RESTING = new Set(["bench", "desk", "dock", "bedside", "perch", "plush"]);
const HELD = new Set(["handheld", "carried"]);
/** A placement change this soon after a lift event is the same pick-up. */
const SAME_LIFT_MS = 10_000;

export const MOTION_LINE: Readonly<Record<HandledHow, LineEvent>> = {
  lifted: "moment.lifted",
  carried: "moment.carried",
  setdown: "moment.setdown",
  shaken: "moment.shaken",
  dropped: "moment.dropped",
};

/** His on/off per reaction; being carried about counts as picking up. */
export const motionAllowed = (s: TessayaMotionSettings, how: HandledHow): boolean =>
  how === "carried" ? s.lifted : s[how];

/**
 * Firmware thresholds per sensitivity, in its units (16384 = 1 g at ±4 g; rest noise ~150, 16 Nov stats). The
 * firmware's own eyes need 1.4× these; the server answers at 1×. Low is the old desk-grade `focus` profile.
 */
export const MOTION_TUNING: Readonly<
  Record<TessayaMotionSensitivity, { readonly shake: number; readonly lift: number }>
> = {
  low: { shake: 13_000, lift: 9_000 },
  normal: { shake: 9_000, lift: 6_000 },
  high: { shake: 6_000, lift: 4_500 },
};

export type HapticCategory = "reactions" | "moods" | "wake" | "reminders";
export interface HapticAsk {
  readonly pattern: HapticPattern;
  readonly category: HapticCategory;
  readonly placement: string | null;
  /** Quiet hours or his do-not-disturb, unless what asks may break them (an urgent note). */
  readonly quiet: boolean;
  readonly batteryPct: number | null;
  readonly charging: boolean | null;
}
const HAPTIC_LEVEL = { off: 0, low: 1, normal: 2, high: 3 } as const;
/** A rattle on a hard surface sounds cheap: one level softer there. */
const HARD = new Set(["desk", "dock", "bench"]);
/** In a pocket or a bag, or by the bed: nobody feels it, or it wakes him. */
const UNFELT = new Set(["carried", "bedside"]);

/**
 * The level (firmware `cmd/haptic` lvl 1-3) a Tessel plays a pattern at, or null for none: his setting, quiet, where
 * she is, then her battery. The firmware adds its own budget and ducks while she speaks.
 */
export const hapticLevel = (s: TessayaHapticSettings, a: HapticAsk): 1 | 2 | 3 | null => {
  let level: number = HAPTIC_LEVEL[s.intensity];
  if (level === 0 || !s[a.category] || a.quiet) return null;
  const at = a.placement;
  if (at !== null && UNFELT.has(at)) return null;
  // Face down is his do-not-disturb: a reminder's nudge is all that comes through.
  if (at === "face_down" && a.pattern !== "nudge") return null;
  // A wake or a reminder buzz is for a hand; on a desk her eyes and voice carry them.
  if (
    (a.category === "wake" || a.category === "reminders") &&
    at !== "handheld" &&
    at !== "face_down"
  )
    return null;
  if (at !== null && HARD.has(at)) level -= 1;
  if (a.batteryPct !== null && a.charging !== true) {
    if (a.batteryPct < 10) return null;
    if (a.batteryPct < 25) level -= 1;
  }
  return Math.max(1, level) as 1 | 2 | 3;
};

type Body = Readonly<Record<string, unknown>> | null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const motionMoment = (
  tail: string,
  body: Body,
  seen: MotionSeen,
  now: number,
): MotionMoment | null => {
  if (tail === "event/session/start") seen.live = true;
  if (tail === "event/session/end") seen.live = false;
  if (tail === "event/motion") {
    const inside = body?.["in"] as Body;
    const busy = inside?.["session"] === true || inside?.["call"] === true;
    const conf = num(body?.["conf"]) ?? 0;
    switch (body?.["kind"]) {
      case "shake":
      case "shake_long": {
        const strong = body["kind"] === "shake_long" || (num(body["intensity"]) ?? 0) >= 50;
        return { how: "shaken", strong, busy: busy && !strong };
      }
      case "lift":
        seen.liftedAt = now;
        return { how: "lifted", strong: false, busy };
      case "drop":
        // 0.5 is free fall with no landing (a toss caught): nothing to say.
        return conf >= 0.9 ? { how: "dropped", strong: true, busy: false } : null;
      default:
        return null;
    }
  }
  if (tail === "state/placement") {
    const next = typeof body?.["placement"] === "string" ? body["placement"] : null;
    const was = seen.placement;
    seen.placement = next;
    if (was === null || next === null || was === next) return null;
    const busy = seen.live;
    if (RESTING.has(was) && HELD.has(next))
      return now - seen.liftedAt < SAME_LIFT_MS ? null : { how: "lifted", strong: false, busy };
    if (was === "handheld" && next === "carried") return { how: "carried", strong: false, busy };
    if (HELD.has(was) && RESTING.has(next)) return { how: "setdown", strong: false, busy };
  }
  return null;
};
