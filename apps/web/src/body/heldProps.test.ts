import { POSTURES, type Euler, type PoseBone } from "@t3tools/tessaya-shared/bodyMotion";
import {
  dot,
  fk,
  preparePose,
  qFromEuler,
  REFERENCE_RIG,
  v3,
} from "@t3tools/tessaya-shared/bodyRig";
import { palmsIn } from "@t3tools/tessaya-shared/bodySkills";
import { PROPS, VESSELS } from "@t3tools/tessaya-shared/expressionMap";
import { describe, expect, it } from "vite-plus/test";

import { HAT_IDS } from "./hats.ts";
import { gripOf, heldFor, HELD_IDS, holdPose } from "./heldProps.ts";

const stand = POSTURES.stand.bones as Partial<Record<PoseBone, Euler>>;
const bones = (p: Partial<Record<string, Euler>>) =>
  Object.fromEntries(Object.entries(p).filter(([b]) => !/Fingers$/.test(b)));

describe("props her hands hold", () => {
  it.each(HELD_IDS)(
    "%s: the hand closes on it in front of her, thumb up, inside her joint ranges",
    (id) => {
      const grip = gripOf(id)!;
      for (const side of ["right", "left"] as const) {
        const pose = holdPose(side, grip, stand);
        const all = { ...stand, ...bones(pose) };
        const hand = palmsIn(all)[side];
        const chest = fk(
          REFERENCE_RIG,
          Object.fromEntries(Object.entries(all).map(([b, e]) => [b, qFromEuler(e as Euler)])),
        ).pos["upperChest"]!;
        const want = v3.add(chest, [
          side === "right" ? grip.at[2] : -grip.at[2],
          grip.at[1],
          grip.at[0],
        ]);
        expect(Math.hypot(...v3.sub(hand.palm, want))).toBeLessThan(0.04);
        // the thumb (the prop's up) points up, so a cup stays level
        const thumb =
          side === "right"
            ? v3.cross(hand.fingers, hand.normal)
            : v3.cross(hand.normal, hand.fingers);
        expect(dot(thumb, [0, 1, 0])).toBeGreaterThan(0.7);
        expect(pose[`${side}Fingers`]![0]).toBeGreaterThan(0.6);
        const worst = Math.max(
          0,
          ...preparePose(REFERENCE_RIG, all as Record<string, Euler>).issues.map((i) => i.by),
        );
        expect(worst).toBeLessThan(0.1);
      }
      expect(heldFor(id)?.children.length).toBeGreaterThan(0);
    },
  );

  it("with her hats, are what her body's manifest says it draws", () => {
    expect([...HAT_IDS, ...HELD_IDS].toSorted()).toEqual(
      [...(VESSELS.body.props ?? [])].toSorted(),
    );
    for (const id of HELD_IDS) expect(PROPS).toContain(id);
    expect(heldFor("rocket")).toBeNull();
  });
});
