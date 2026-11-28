/**
 * A phone Sleeve's motion sensor, read as her body's moments (M-158): picked up, raised to him, put face down, turned
 * back up, shaken. Pure, fed accelerometer samples in g (expo-sensors, both platforms): z is -1 lying face up, +1 face
 * down, and y goes toward -1 as the screen is raised to face him.
 */
export interface Accel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export type SleeveMoment = "lifted" | "raised" | "facedown" | "faceup" | "shaken";

/** Still this long before a move counts as a pick-up. */
const STILL_MS = 2_000;
/** A move this far from 1 g is a hand on her. */
const MOVED_G = 0.15;
/** After a lift, this long to come up facing him. */
const RAISE_MS = 1_500;
/** Lying screen-down this long. */
const FACEDOWN_MS = 800;
const SHAKE_G = 1.2;

export const makeMotionReader = () => {
  let stillSince: number | null = null;
  let liftedAt: number | null = null;
  let downSince: number | null = null;
  let down = false;
  let shakes: number[] = [];
  return (a: Accel, now: number): SleeveMoment | null => {
    const g = Math.hypot(a.x, a.y, a.z);
    const moving = Math.abs(g - 1) > MOVED_G;
    if (Math.abs(g - 1) > SHAKE_G) {
      shakes = [...shakes.filter((t) => now - t < 1_000), now];
      if (shakes.length >= 3) {
        shakes = [];
        return "shaken";
      }
    }
    // face down: the screen toward the table, still
    if (a.z > 0.85 && !moving) {
      downSince ??= now;
      if (!down && now - downSince >= FACEDOWN_MS) {
        down = true;
        liftedAt = null;
        return "facedown";
      }
    } else downSince = null;
    if (down && a.z < 0.3) {
      down = false;
      stillSince = null;
      return "faceup";
    }
    if (down) return null;
    if (!moving) {
      stillSince ??= now;
      // up and facing him after the lift: raised to talk
      if (liftedAt !== null && now - liftedAt <= RAISE_MS && a.y < -0.5) {
        liftedAt = null;
        return "raised";
      }
      if (liftedAt !== null && now - liftedAt > RAISE_MS) liftedAt = null;
      return null;
    }
    const wasStill = stillSince !== null && now - stillSince >= STILL_MS;
    stillSince = null;
    if (wasStill) {
      liftedAt = now;
      return "lifted";
    }
    return null;
  };
};
