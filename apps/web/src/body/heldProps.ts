/**
 * Things her full body holds with no asset file (`builtin:<id>` in a prop cue): each is built in its grip's frame, set
 * into her hand at the palm, and comes with the arm and finger pose that holds it (bodySkills oneHandAt), so the hand
 * closes round the handle and the prop sits upright in front of her on any model.
 */
import type { VRM } from "@pixiv/three-vrm";
import type { Euler, PoseBone } from "@t3tools/tessaya-shared/bodyMotion";
import { oneHandAt, type HandKey } from "@t3tools/tessaya-shared/bodySkills";
import * as THREE from "three";

import { ball, lookOf, part, sheet, type Look, type V3 } from "./propKit.ts";

/**
 * How a prop is held: the palm's centre [ahead, up, her left] m from her upper chest, where the fingers point and the
 * palm faces (her trunk's frame, for the right hand; the left mirrors it), and how far the hand closes.
 */
export interface Grip {
  readonly at: V3;
  readonly fingers: V3;
  readonly normal: V3;
  readonly curl: number;
  /** How far the thumb folds over the handle; with the curl when absent. */
  readonly thumb?: number;
}

/** A prop in its grip's frame: y along the thumb, z out of the palm, origin where the hand closes round it. */
type Make = (look: Look) => THREE.Object3D[];

/** A tube along points (a handle, a hook), `r` thick. */
const tube = (pts: ReadonlyArray<V3>, r: number, closed = false) =>
  new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(
      pts.map((p) => new THREE.Vector3(...p)),
      closed,
    ),
    32,
    r,
    10,
    closed,
  );

/** A solid of revolution about y through (r, y) points, bottom to top, closed at both ends. */
const lathe = (
  profile: ReadonlyArray<readonly [number, number]>,
  at: V3 = [0, 0, 0],
  paint?: (v: number) => 0 | 1,
) =>
  sheet(
    40,
    profile.length,
    (u, v) => {
      const [r, y] = profile[Math.round(v * (profile.length - 1))]!;
      return [
        at[0] + r * Math.sin(u * Math.PI * 2),
        at[1] + y,
        at[2] + r * Math.cos(u * Math.PI * 2),
      ];
    },
    false,
    paint === undefined ? undefined : (_, v) => paint(v),
  );

// a mug or cup: its handle loop is what the fingers close through, its body out past the palm
const cup = (
  look: Look,
  o: {
    r0: number;
    r1: number;
    h: number;
    drink: string;
    body: string;
    band: string;
    band0: number;
    band1: number;
  },
) => {
  const out = 0.034 + o.r1;
  const wall = 0.004;
  const profile: Array<readonly [number, number]> = [
    [0, -o.h / 2],
    [o.r0 - 0.004, -o.h / 2],
    [o.r0, -o.h / 2 + 0.004],
    [o.r1, o.h / 2 - 0.002],
    [o.r1 - wall / 2, o.h / 2 + 0.001],
    [o.r1 - wall, o.h / 2 - 0.002],
    [o.r0 - wall, -o.h / 2 + wall * 2],
    [0, -o.h / 2 + wall * 2],
  ];
  const body = lathe(profile, [0, 0, out], (v) => {
    const k = v * (profile.length - 1);
    return k >= o.band0 && k < o.band1 ? 1 : 0;
  });
  const drink = sheet(
    40,
    2,
    (u, v) => {
      const r = v * (o.r0 + (o.r1 - o.r0) * 0.8 - wall);
      return [r * Math.sin(u * Math.PI * 2), o.h * 0.3, out + r * Math.cos(u * Math.PI * 2)];
    },
    false,
  );
  // the loop: from the wall near the rim, out through the fist and back to the wall lower down
  const handle = tube(
    [
      [0, o.h * 0.32, out - o.r1 + 0.004],
      [0, o.h * 0.3, 0.012],
      [0, 0, -0.004],
      [0, -o.h * 0.3, 0.012],
      [0, -o.h * 0.32, out - (o.r0 + o.r1) / 2 + 0.004],
    ],
    0.0055,
  );
  return [part(look, body, o.body, o.band), part(look, drink, o.drink), part(look, handle, o.body)];
};

const HELD: Readonly<Record<string, { readonly grip: Grip; readonly make: Make }>> = {
  // a morning mug of coffee, held by its handle at her middle
  coffee: {
    grip: {
      at: [0.28, -0.06, -0.1],
      fingers: [1, 0, 0.35],
      normal: [0, 0, 1],
      curl: 0.82,
      thumb: 1,
    },
    make: (look) =>
      cup(look, {
        r0: 0.038,
        r1: 0.04,
        h: 0.095,
        drink: "#4A2E1E",
        body: "#F3EBDD",
        band: "#2A8C96",
        band0: 2,
        band1: 3,
      }),
  },
  // an evening cup of tea: a flared cup with a gold rim, held a little closer and lighter
  tea: {
    grip: {
      at: [0.27, -0.03, -0.08],
      fingers: [1, 0.1, 0.45],
      normal: [0, 0, 1],
      curl: 0.88,
      thumb: 1,
    },
    make: (look) =>
      cup(look, {
        r0: 0.026,
        r1: 0.045,
        h: 0.06,
        drink: "#B5651D",
        body: "#FBF8F2",
        band: "#E8B04A",
        band0: 3,
        band1: 6,
      }),
  },
  // an umbrella over her head: a J handle in her fist, the shaft up past her head, eight panels
  umbrella: {
    grip: { at: [0.24, -0.08, -0.14], fingers: [1, 0, 0.2], normal: [0, 0, 1], curl: 0.85 },
    make: (look) => {
      const top = 0.8;
      const R = 0.5;
      const shaft = lathe(
        [
          [0, -0.07],
          [0.008, -0.07],
          [0.008, top],
          [0, top],
        ],
        [0, 0, 0],
      );
      const hook = tube(
        [
          [0, -0.06, 0],
          [0, -0.12, 0],
          [0, -0.155, 0.025],
          [0, -0.14, 0.055],
          [0, -0.11, 0.06],
        ],
        0.011,
      );
      // the cloth droops between the ribs and falls away to the edge
      const canopy = sheet(
        128,
        14,
        (u, v) => {
          const between = Math.abs(Math.sin(u * Math.PI * 8));
          const r = R * Math.sin((v * Math.PI) / 2) * (1 - 0.06 * between * v);
          const y = top - 0.24 * v ** 1.6 + 0.02 * between * v;
          return [r * Math.sin(u * Math.PI * 2), y, r * Math.cos(u * Math.PI * 2)];
        },
        false,
        (u) => (Math.floor(u * 8) % 2 === 0 ? 0 : 1),
        (_, v) => 0.8 + 0.2 * v,
      );
      const ends = Array.from({ length: 8 }, (_, k) => {
        const a = (k / 8) * Math.PI * 2;
        return part(
          look,
          ball([R * Math.sin(a), top - 0.24, R * Math.cos(a)], 0.008, 0),
          "#3B3B44",
        );
      });
      return [
        part(look, shaft, "#3B3B44"),
        part(look, hook, "#6B4226"),
        part(look, canopy, "#2A8C96", "#F7F2E7"),
        part(look, ball([0, top + 0.012, 0], 0.012, 0), "#3B3B44"),
        ...ends,
      ];
    },
  },
  // a reading magnifier held up at her side, clear of her face: a wooden handle, a brass ring and its glass
  magnifier: {
    grip: { at: [0.26, 0, -0.2], fingers: [1, 0.25, 0.15], normal: [0, 0, 1], curl: 0.8 },
    make: (look) => {
      const c = 0.07 + 0.045;
      const handle = lathe(
        [
          [0, -0.05],
          [0.009, -0.05],
          [0.012, -0.03],
          [0.011, 0.05],
          [0.008, 0.07],
          [0, 0.07],
        ],
        [0, 0, 0],
        (v) => (v > 0.7 ? 1 : 0),
      );
      const ring = tube(
        Array.from({ length: 24 }, (_, k): V3 => {
          const a = (k / 24) * Math.PI * 2;
          return [0, c + 0.045 * Math.cos(a), 0.045 * Math.sin(a)];
        }),
        0.006,
        true,
      );
      // the glass faces the way she looks, a little thicker in the middle
      const glass = sheet(40, 6, (u, v) => {
        const r = 0.042 * Math.sin(v * Math.PI);
        const a = u * Math.PI * 2;
        return [0.004 * Math.cos(v * Math.PI), c + r * Math.cos(a), r * Math.sin(a)];
      });
      return [
        part(look, handle, "#6B4226", "#C9A24A"),
        part(look, ring, "#C9A24A"),
        part(look, glass, "#CFE8F0"),
      ];
    },
  },
  // a spanner for when the agents are building: an open jaw above the fist
  wrench: {
    grip: { at: [0.28, -0.1, -0.14], fingers: [1, -0.2, 0.3], normal: [0, 0, 1], curl: 0.88 },
    make: (look) => {
      const s = new THREE.Shape();
      s.moveTo(-0.009, -0.07);
      s.lineTo(0.009, -0.07);
      s.lineTo(0.009, 0.08);
      s.lineTo(0.022, 0.095);
      s.lineTo(0.022, 0.125);
      s.lineTo(0.01, 0.135);
      s.lineTo(0.007, 0.112);
      s.lineTo(-0.007, 0.112);
      s.lineTo(-0.01, 0.135);
      s.lineTo(-0.022, 0.125);
      s.lineTo(-0.022, 0.095);
      s.lineTo(-0.009, 0.08);
      s.closePath();
      const g = new THREE.ExtrudeGeometry(s, {
        depth: 0.006,
        bevelEnabled: true,
        bevelSize: 0.002,
        bevelThickness: 0.002,
        bevelSegments: 2,
      });
      g.clearGroups();
      g.translate(0, 0, -0.003);
      g.rotateY(Math.PI / 2);
      g.computeVertexNormals();
      return [part(look, g, "#9AA3AD")];
    },
  },
};

/** The props her hands hold, by the prop vocabulary's ids. */
export const HELD_IDS: ReadonlyArray<string> = Object.keys(HELD);

/** A held prop's grip, for the right hand; null for an id it doesn't hold. */
export const gripOf = (id: string): Grip | null => HELD[id]?.grip ?? null;

/** The arm, wrist and fingers that hold a prop in this hand, over a base posture (VRM 1.0 axes, like every pose). */
export const holdPose = (
  side: "left" | "right",
  grip: Grip,
  base: Partial<Record<PoseBone, Euler>>,
): Partial<Record<PoseBone | HandKey, Euler>> => {
  const m = (v: V3): V3 => (side === "right" ? v : [v[0], v[1], -v[2]]);
  return oneHandAt(
    side,
    {
      at: m(grip.at),
      fingers: m(grip.fingers),
      normal: m(grip.normal),
      curl: grip.curl,
      ...(grip.thumb === undefined ? {} : { thumb: grip.thumb }),
    },
    base,
  );
};

/** A held prop built for this look (none: a plain toon one), in its grip's frame; null for an id it doesn't hold. */
export const heldFor = (id: string, vrm?: VRM) => {
  const h = HELD[id];
  if (h === undefined) return null;
  const g = new THREE.Group();
  g.name = `held:${id}`;
  g.add(...h.make(vrm === undefined ? { surface: null, outline: null } : lookOf(vrm)));
  return g;
};

/**
 * A held prop set into her hand, built for its frame (propKit frameOn on that hand): the grip sits a palm's length out
 * from the wrist and a little into the palm, sized to her hand. Null for an id it doesn't hold.
 */
export const holdIn = (vrm: VRM, id: string, side: "left" | "right") => {
  const prop = heldFor(id, vrm);
  if (prop === null) return null;
  // her palm's length: wrist to the knuckles of the middle finger, or a 1.6 m body's when the model has no fingers
  const hand = vrm.humanoid.getRawBoneNode(`${side}Hand`);
  const knuckle = vrm.humanoid.getRawBoneNode(`${side}MiddleProximal`);
  vrm.scene.updateMatrixWorld(true);
  const palm =
    hand === null || knuckle === null
      ? 0.08
      : hand
          .getWorldPosition(new THREE.Vector3())
          .distanceTo(knuckle.getWorldPosition(new THREE.Vector3())) /
        vrm.scene.getWorldScale(new THREE.Vector3()).x;
  // a VRM 0 model's axes are turned round (as its head's are, hats.ts)
  const holder = new THREE.Group();
  holder.rotation.y = vrm.meta.metaVersion === "0" ? Math.PI : 0;
  // the grip's frame in the hand's (VRM 1.0, T-pose): fingers along -x (right) or +x, palm down, thumb forward
  prop.rotation.x = Math.PI / 2;
  prop.position.set(side === "right" ? -palm * 0.95 : palm * 0.95, -palm * 0.3, 0);
  prop.scale.setScalar(Math.max(0.7, Math.min(1.4, palm / 0.08)));
  holder.add(prop);
  return holder;
};
