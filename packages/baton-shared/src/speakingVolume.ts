/**
 * How loud she speaks, 0-100 on every device, changed by him in words ("speak up", "too loud", "max volume"). The R1's
 * 71 is its DAC at 0 dB (firmware r1bt_volume_get); the desktop's 100 is its player at full scale, its old default.
 */
export type VolumeTo = "up" | "down" | "max" | "default" | number;

export const VOLUME_STEP = 15;
/** Never so quiet by voice that he could not ask her to come back up. */
export const VOLUME_FLOOR = 10;

/** The level after his request, from where it is now and the device's own default. */
export const volumeAfter = (current: number, to: VolumeTo, fallback: number): number => {
  const next =
    to === "up"
      ? current + VOLUME_STEP
      : to === "down"
        ? current - VOLUME_STEP
        : to === "max"
          ? 100
          : to === "default"
            ? fallback
            : to;
  return Math.round(Math.min(100, Math.max(VOLUME_FLOOR, next)));
};

/** What the tool hands back to her: data to confirm from, never words to read out. */
export const volumeLine = (before: number, after: number): string =>
  after === before
    ? after === 100
      ? "Already as loud as this device goes."
      : after === VOLUME_FLOOR
        ? "Already as quiet as she goes by voice."
        : "Unchanged."
    : `Now ${after < before ? "quieter" : "louder"} (${after} of 100, was ${before}); her next sentence plays at it.`;
