import { describe, expect, it } from "vite-plus/test";

import { GAIT_STYLES, gaitAt, gaitOf, type GaitStyle } from "./bodyGait.ts";
import { POSTURES, type Euler, type PoseBone } from "./bodyMotion.ts";
import { fk, qFromEuler, REFERENCE_RIG, type V3 } from "./bodyRig.ts";

const stand = POSTURES.stand.bones as Partial<Record<PoseBone, Euler>>;
const worldFoot = (bones: Partial<Record<PoseBone, Euler>>, side: "left" | "right"): V3 =>
  fk(
    REFERENCE_RIG,
    Object.fromEntries(
      Object.entries({ ...stand, ...bones }).map(([b, e]) => [b, qFromEuler(e as V3)]),
    ),
  ).pos[`${side}Foot`]!;

describe("her gait", () => {
  it("steps faster as she hurries, and a sneak is slower than a stroll", () => {
    const slow = gaitOf(REFERENCE_RIG, 0);
    const fast = gaitOf(REFERENCE_RIG, 1);
    expect(fast.speed).toBeGreaterThan(slow.speed);
    expect(fast.cadence).toBeGreaterThan(slow.cadence);
    expect(gaitOf(REFERENCE_RIG, 0.5, "sneak").speed).toBeLessThan(
      gaitOf(REFERENCE_RIG, 0.5).speed,
    );
  });

  it.each(Object.keys(GAIT_STYLES) as GaitStyle[])(
    "%s: a planted heel stays put on the ground while she travels over it",
    (style) => {
      const g = gaitOf(REFERENCE_RIG, 0.5, style);
      const dt = 1 / 60;
      let travel = 0;
      let was: V3 | null = null;
      const speeds: number[] = [];
      for (let t = 0; t < 2; t += dt) {
        const f = gaitAt(REFERENCE_RIG, g, t, stand);
        travel += f.speed * dt;
        const p = worldFoot(f.bones, "left");
        const now: V3 = [p[0], p[1], p[2] + travel];
        // the flat part of the stance: the heel is down and the foot not yet rolling
        const phase = (t * g.cadence) / 2 - Math.floor((t * g.cadence) / 2);
        if (was !== null && phase > 0.05 && phase < g.stance * 0.6)
          speeds.push(Math.hypot(now[0] - was[0], now[2] - was[2]) / dt);
        was = now;
      }
      speeds.sort((a, b) => a - b);
      expect(speeds[Math.floor(speeds.length * 0.9)]!).toBeLessThan(0.06);
    },
  );
});
