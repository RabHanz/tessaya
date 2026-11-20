/**
 * What her body costs the phone (D-038), measured by the app itself while he uses it normally: frames the body page
 * drew a minute and how busy the JS thread was, over a ten-minute stretch on the Talk tab and one in the background.
 * Busy is the timer's lateness: a 250 ms tick that arrives late was waiting on the thread.
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
