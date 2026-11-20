/**
 * What her body costs the phone (D-038), measured by the app itself while he uses it normally: frames the body page
 * drew a minute and how busy the JS thread was, over a ten-minute stretch on the Talk tab and one in the background.
 * Busy is the timer's lateness: a 250 ms tick that arrives late was waiting on the thread. Battery is the drop per
 * hour across the stretch, only when the phone was on battery at both ends.
 */
export const STRETCH_MS = 10 * 60_000;
export const TICK_MS = 250;

export interface Stretch {
  readonly startedAt: number;
  readonly frames: number;
  readonly lateMs: number;
  readonly lastTick: number;
}

export const startStretch = (now: number): Stretch => ({
  startedAt: now,
  frames: 0,
  lateMs: 0,
  lastTick: now,
});

/** One timer tick: whatever arrived after its due time counts as the thread being busy. */
export const tick = (s: Stretch, now: number): Stretch => ({
  ...s,
  lateMs: s.lateMs + Math.max(0, now - s.lastTick - TICK_MS),
  lastTick: now,
});

export const addFrames = (s: Stretch, n: number): Stretch => ({
  ...s,
  frames: s.frames + Math.max(0, n),
});

/** The stretch as one line for the brain, once it has run its ten minutes; null before. */
export const stretchSummary = (
  s: Stretch,
  now: number,
  where: "visible" | "background",
): string | null => {
  const ms = now - s.startedAt;
  if (ms < STRETCH_MS) return null;
  const minutes = ms / 60_000;
  return `${where}: ${Math.round(s.frames / minutes)} frames/min, JS busy ${((100 * s.lateMs) / ms).toFixed(1)}% over ${Math.round(minutes)} min`;
};

export interface BatteryRead {
  /** 0 to 1; -1 when the phone can't say. */
  readonly level: number;
  readonly charging: boolean;
  readonly at: number;
}

/** How fast the battery fell across a stretch, or null when charging, unknown or too short to say. */
export const batteryDrain = (from: BatteryRead | null, to: BatteryRead | null): string | null => {
  if (from === null || to === null || from.charging || to.charging) return null;
  if (from.level < 0 || to.level < 0 || to.at - from.at < STRETCH_MS) return null;
  const perHour = ((from.level - to.level) * 100) / ((to.at - from.at) / 3_600_000);
  return `battery ${perHour.toFixed(1)}%/h`;
};
