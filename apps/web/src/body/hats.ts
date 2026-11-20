/**
 * Hats her full body wears with no asset file (`builtin:<id>` in a prop cue), built to her own head: each is fitted to
 * the head bone from the shape of her hair and face (fitHead), so it sits down into the hair on any model, and dressed
 * in a copy of her own clothes' MToon material, so it is lit and outlined like the rest of her.
 */
import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";

import { ball, lookOf, part, sheet, type Look, type V3 } from "./propKit.ts";

/** Her head as a hat sees it, in the head bone's frame (metres, y up, z toward her face). */
export interface HeadFit {
  /** The middle of her head and its half-width and half-depth above the brow. */
  readonly cx: number;
  readonly cz: number;
  readonly rx: number;
  readonly rz: number;
  /** The top of her hair, and her brow line. */
  readonly top: number;
  readonly brow: number;
  /**
   * How far out her hair reaches at a height, in units of the (rx, rz) ellipse, toward angle u (turns, 0 at her
   * front) or all round; 0 above her.
   */
  readonly reach: (y: number, u?: number) => number;
  /** The highest point of her hair near (x, z): where something set on top of her head comes to rest. */
  readonly crownAt: (x: number, z: number) => number;
}

const quantile = (xs: ReadonlyArray<number>, q: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] ?? 0;
};

/**
 * Fits a head to points on her hair and face (x, y, z triples, head-bone frame). The brow is her eye line raised a
 * sixth of the way to the top, or, with no eyes, 11 cm under the top.
 */
export const fitHead = (points: ArrayLike<number>, eyeY?: number): HeadFit => {
  const all: Array<readonly [number, number, number]> = [];
  for (let i = 0; i + 2 < points.length; i += 3)
    all.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  // a stray strand standing up is not the top of her head
  const top = quantile(
    all.map((p) => p[1]),
    0.998,
  );
  const brow = eyeY === undefined ? top - 0.11 : eyeY + (top - eyeY) * 0.15;
  const cap = all.filter((p) => p[1] >= brow);
  const span = (k: 0 | 2) => [
    quantile(
      cap.map((p) => p[k]),
      0.02,
    ),
    quantile(
      cap.map((p) => p[k]),
      0.98,
    ),
  ];
  const [x0, x1] = span(0);
  const [z0, z1] = span(2);
  const cx = (x0! + x1!) / 2;
  const cz = (z0! + z1!) / 2;
  const rx = Math.max(0.02, (x1! - x0!) / 2);
  const rz = Math.max(0.02, (z1! - z0!) / 2);
  // how far out her hair reaches in each band of height, in eight sectors round her head, bar a stray strand: so a
  // hat fits close at her forehead even where her hair is full behind
  const BANDS = 16;
  const SECTORS = 8;
  const step = (top - brow) / BANDS;
  const cells = Array.from({ length: BANDS }, (_, b) => {
    const band = cap.filter((p) => p[1] >= brow + b * step && p[1] < brow + (b + 1) * step);
    const sector = (p: readonly [number, number, number]) =>
      Math.floor(((((Math.atan2(p[0] - cx, p[2] - cz) / (Math.PI * 2)) % 1) + 1) % 1) * SECTORS) %
      SECTORS;
    const rho = (ps: typeof band) => ps.map((p) => Math.hypot((p[0] - cx) / rx, (p[2] - cz) / rz));
    const all = band.length === 0 ? 0 : quantile(rho(band), 0.985);
    return Array.from({ length: SECTORS }, (_, k) => {
      const here = band.filter((p) => sector(p) === k);
      return here.length < 4 ? all : quantile(rho(here), 0.985);
    });
  });
  const at = (b: number, u: number | undefined) => {
    const row = cells[b]!;
    if (u === undefined) return Math.max(...row);
    const f = (((u * SECTORS - 0.5) % SECTORS) + SECTORS) % SECTORS;
    const k = Math.floor(f);
    return row[k]! + (row[(k + 1) % SECTORS]! - row[k]!) * (f - k);
  };
  const reach = (y: number, u?: number) => {
    if (y > top) return 0;
    const f = Math.max(0, (y - brow) / step - 0.5);
    const b = Math.min(BANDS - 1, Math.floor(f));
    const t = Math.min(1, f - b);
    return at(b, u) + (at(Math.min(BANDS - 1, b + 1), u) - at(b, u)) * t;
  };
  const crownAt = (x: number, z: number) => {
    const near = cap
      .filter((p) => Math.hypot(p[0] - x, p[2] - z) < 0.2 * (rx + rz))
      .map((p) => p[1]);
    return near.length === 0 ? top : quantile(near, 0.99);
  };
  return { cx, cz, rx, rz, top, brow, reach, crownAt };
};

/** Where a point at angle u (turns, 0 at her front) and ellipse radius r sits, `out` metres further out, at height y. */
const ring = (f: HeadFit, u: number, r: number, out: number, y: number): V3 => {
  const s = Math.sin(u * Math.PI * 2);
  const c = Math.cos(u * Math.PI * 2);
  return [f.cx + s * (r * f.rx + out), y, f.cz + c * (r * f.rz + out)];
};

/**
 * The line a hat's band sits on, `at` of the way from her brow to her top at the front and `drop` of that height lower
 * at the back: a hat rides over the forehead and down the back of the skull, never level.
 */
const seatLine =
  (f: HeadFit, at: number, drop: number) =>
  (u: number): number =>
    f.brow + (f.top - f.brow) * (at - (drop * (1 - Math.cos(u * Math.PI * 2))) / 2);

/** Her hair's reach as a hat presses on it: the strands hanging out past her skull stay outside, under its edge. */
export const PRESS = 1.06;
const hug = (f: HeadFit, y: number, u: number) => Math.min(f.reach(y, u), PRESS);

/**
 * How wide a hat sitting at `y0` must be at height `y` (ellipse units), `clear` of her hair: as wide as her hair
 * anywhere above, so nothing comes through its crown, and pressing only the loose strands in its lowest band.
 */
const need = (f: HeadFit, u: number, y0: number, y: number, clear: number) => {
  const band = y0 + 0.15 * (f.top - y0);
  const from = Math.max(y, band);
  let r = y < band ? hug(f, y, u) : 0;
  // above it the hat holds her hair, pressing it a little, and the thick of it on top a little more
  for (let k = 0; k <= 12; k++) {
    const at = from + ((f.top - from) * k) / 12;
    r = Math.max(r, (0.97 - (0.08 * (at - y0)) / (f.top - y0)) * f.reach(at, u));
  }
  return r * clear;
};

/**
 * A crown of cloth or shell over her head, from its seat line to at least `lift` above her top: one smooth dome, made
 * taller until it holds all her hair (`need`), never creased where her hair's outline would show through it. `shape`
 * adds a hat's own detail (ribs, ridges).
 */
const dome = (
  f: HeadFit,
  seat: (u: number) => number,
  lift: number,
  clear: number,
  shape: (u: number, v: number) => number = () => 0,
  nu = 64,
  tone: (u: number, v: number) => number = (_, v) => 0.7 + 0.3 * Math.min(1, v * 2.5),
) => {
  const base = Array.from({ length: nu }, (_, i) =>
    need(f, i / nu, seat(i / nu), seat(i / nu), clear),
  );
  const holds = (h: number) =>
    base.every((r0, i) => {
      const y0 = seat(i / nu);
      for (let k = 1; k <= 10; k++) {
        const y = y0 + ((f.top - y0) * k) / 10;
        const t = (y - y0) / (f.top + h - y0);
        if (r0 * (1 - t * t) ** FULL < need(f, i / nu, y0, y, clear)) return false;
      }
      return true;
    });
  let h = lift;
  while (h < lift + 0.18 * (f.top - f.brow) && !holds(h)) h += 0.004;
  return sheet(
    nu,
    28,
    (u, v) => {
      const y0 = seat(u);
      const a = v * (Math.PI / 2);
      const r = v >= 1 ? 0 : base[Math.round(u * nu) % nu]! * Math.cos(a) ** (2 * FULL);
      // detail only ever stands out from the shell, never into her hair
      return ring(
        f,
        u,
        r,
        Math.max(0, shape(u, v)) * (f.rx + f.rz),
        y0 + (f.top + h - y0) * Math.sin(a),
      );
    },
    false,
    undefined,
    tone,
  );
};

/** How full a crown is: a hat holds a broad head of hair by its shape, not by rising tall over it. */
const FULL = 0.2;

/** A fold of cloth (a cuff) round her head, `tall` metres up from its seat line and `thick` deep, over her hair. */
const band = (
  f: HeadFit,
  seat: (u: number) => number,
  tall: number,
  clear: number,
  thick: number,
  rib: (u: number) => number = () => 0,
) => {
  // a rounded section: up the outside, over the top, down the inside
  const section: ReadonlyArray<readonly [number, number]> = Array.from({ length: 12 }, (_, k) => {
    const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
    return [(Math.cos(a) * 0.5 + 0.5) * thick, (Math.sin(a) * 0.5 + 0.5) * tall];
  });
  return sheet(
    96,
    section.length,
    (u, v) => {
      const [out, up] = section[Math.round(v * section.length) % section.length]!;
      const y0 = seat(u);
      const r = need(f, u, y0, y0, clear);
      return ring(f, u, r, out - thick * 0.4 + rib(u) * thick, y0 + up);
    },
    true,
    undefined,
    // shadowed underneath and in each rib's groove
    (u, v) => (0.75 + 0.25 * Math.sin(v * Math.PI)) * (1 - 0.12 * Math.max(0, -rib(u) * 4)),
  );
};

const bump = (d: number, w: number) => Math.exp(-((d / w) ** 2));
/** The shortest way round from u to a, in turns. */
const off = (u: number, a: number) => ((((u - a) % 1) + 1.5) % 1) - 0.5;

type Hat = (f: HeadFit, look: Look) => THREE.Object3D[];

const HATS: Readonly<Record<string, Hat>> = {
  // a cap-style safety helmet: a tall shell with three raised ridges, a peak at the front and a narrow brim round
  hardhat: (f, look) => {
    const s = f.top - f.brow;
    const seat = seatLine(f, 0.34, 0.3);
    const yellow = "#F2B630";
    const shell = dome(f, seat, 0.12 * s, 1.05, (u, v) =>
      v < 0.15
        ? 0
        : 0.03 * bump(off(u, 0), 0.025) * (1 - v * 0.6) +
          0.018 * (bump(off(u, 0.5), 0.025) + bump(off(u, 0.1), 0.012) + bump(off(u, -0.1), 0.012)),
    );
    // the brim: 1.5 cm round the sides, 6 cm at the peak, dipping a little toward the front
    const brim = sheet(
      96,
      4,
      (u, v) => {
        const front = Math.max(0, Math.cos(u * Math.PI * 2)) ** 2.5;
        const w = 0.012 + 0.05 * front;
        const section: ReadonlyArray<readonly [number, number]> = [
          [0, -0.008],
          [w, -0.004 * front - 0.006],
          [w, -0.004 * front],
          [0, 0],
        ];
        const [out, dy] = section[Math.round(v * 4) % 4]!;
        return ring(f, u, need(f, u, seat(u), seat(u), 1.05), out - 0.002, seat(u) + dy);
      },
      true,
      undefined,
      (_, v) => (v < 0.4 ? 0.62 : 1),
    );
    return [part(look, shell, yellow), part(look, brim, yellow)];
  },
  // a knitted beanie pulled down to the brow, ribbed, with a turned-up cuff and a pompom
  beanie: (f, look) => {
    const s = f.top - f.brow;
    const seat = seatLine(f, 0.24, 0.45);
    const ribs = (u: number) => 0.004 * Math.cos(u * Math.PI * 2 * 56);
    const body = dome(
      f,
      seat,
      0.14 * s,
      1.02,
      (u) => ribs(u) * 0.5,
      112,
      (u, v) => (0.7 + 0.3 * Math.min(1, v * 2.5)) * (0.9 + 0.1 * Math.cos(u * Math.PI * 2 * 56)),
    );
    const cuff = band(
      f,
      (u) => seat(u) - 0.003,
      0.3 * s,
      1.02,
      0.009,
      (u) => 0.2 * Math.cos(u * Math.PI * 2 * 56),
    );
    body.computeBoundingBox();
    const pom = ball(
      [f.cx, body.boundingBox!.max.y + 0.05 * (f.rx + f.rz), f.cz],
      0.085 * (f.rx + f.rz),
    );
    return [part(look, body, "#2A8C96"), part(look, cuff, "#23767F"), part(look, pom, "#F3EBDD")];
  },
  // a long soft nightcap: a fitted crown whose tip flops over to one side and hangs, a fur cuff and a pompom
  nightcap: (f, look) => {
    const s = f.top - f.brow;
    const seat = seatLine(f, 0.26, 0.4);
    const R = (f.rx + f.rz) / 2;
    const folds = (u: number, v: number) => 0.006 * Math.sin(u * Math.PI * 2 * 5 + v * 4) * v;
    const crown = dome(f, seat, 0.06 * s, 1.03, folds);
    crown.computeBoundingBox();
    const top = crown.boundingBox!.max.y;
    const tip = new THREE.CatmullRomCurve3(
      (
        [
          [0, top - 0.35 * s, -0.05],
          [0.05, top + 0.35 * s, -0.15],
          [0.55, top + 0.55 * s, -0.3],
          [1.15, top + 0.05 * s, -0.35],
          [1.35, top - 0.6 * s, -0.25],
        ] as const
      ).map(([x, y, z]) => new THREE.Vector3(f.cx + x * R, y, f.cz + z * R)),
    );
    const tail = new THREE.TubeGeometry(tip, 40, 1, 20, false);
    // taper the tube from most of her head's width at the crown to a point where the pompom hangs
    const p = tail.getAttribute("position");
    const v = new THREE.Vector3();
    for (let i = 0; i <= 40; i++) {
      const at = tip.getPointAt(i / 40);
      const k = R * (0.62 * (1 - i / 40) ** 1.2 + 0.08);
      for (let j = 0; j <= 20; j++) {
        const n = i * 21 + j;
        v.fromBufferAttribute(p, n).sub(at).multiplyScalar(k).add(at);
        p.setXYZ(n, v.x, v.y, v.z);
      }
    }
    tail.computeVertexNormals();
    const cuff = band(
      f,
      (u) => seat(u) - 0.005,
      0.26 * s,
      1.03,
      0.014,
      (u) => 0.18 * Math.sin(u * Math.PI * 2 * 23),
    );
    const end = tip.getPointAt(1);
    const pom = ball([end.x, end.y - 0.12 * R, end.z], 0.2 * R, 0.16);
    return [
      part(look, crown, "#3D4F9A"),
      part(look, tail, "#3D4F9A"),
      part(look, cuff, "#F4EFE6"),
      part(look, pom, "#F4EFE6"),
    ];
  },
  // a striped paper party cone set at a tilt on the top of her head, with a pompom on its tip
  partyhat: (f, look) => {
    const R = (f.rx + f.rz) / 2;
    const base = 0.44 * R;
    const tall = 2.1 * R;
    const cone = sheet(
      96,
      32,
      (u, v) => {
        const r = base * (1 - v) + 0.01 * R;
        return [Math.sin(u * Math.PI * 2) * r, v * tall, Math.cos(u * Math.PI * 2) * r];
      },
      false,
      (u, v) => (((Math.floor(u * 8 + v * 3) % 2) + 2) % 2 === 0 ? 0 : 1),
    );
    const trim = sheet(
      48,
      8,
      (u, v) => {
        const a = v * Math.PI * 2;
        const r = base + 0.035 * R * (1 + Math.cos(a));
        return [
          Math.sin(u * Math.PI * 2) * r,
          0.035 * R * Math.sin(a),
          Math.cos(u * Math.PI * 2) * r,
        ];
      },
      true,
    );
    const pom = ball([0, tall + 0.12 * R, 0], 0.17 * R, 0.25);
    const hat = new THREE.Group();
    hat.add(
      part(look, cone, "#D64550", "#F7F2E7"),
      part(look, trim, "#E8A75A"),
      part(look, pom, "#E8A75A"),
    );
    // to her left and a little forward, tipped out, its rim settled a little into her hair
    const x = f.cx + 0.3 * R;
    const z = f.cz + 0.12 * R;
    hat.position.set(x, f.crownAt(x, z) - 0.3 * base, z);
    hat.rotation.set(0.12, 0, -0.32);
    return [hat];
  },
  // a gold crown of five points, ball-tipped, with a gem under each, on the crown of her head
  crown: (f, look) => {
    const s = f.top - f.brow;
    const R = (f.rx + f.rz) / 2;
    const seat = f.brow + 0.6 * s;
    const h = 0.3 * R;
    const peak = 0.34 * R;
    // the hair it sits in hides the band's lower edge
    const r = (u: number) => hug(f, seat, u) * 0.97;
    const points = (u: number) =>
      Math.max(0, 1 - Math.abs(off(u, Math.round(u * 5) / 5)) * 5 * 2.2);
    const flare = (y: number) => 0.12 * R * ((y - seat) / (h + peak));
    const section: ReadonlyArray<readonly [number, number]> = [
      [0.004, 0],
      [0.004, 1],
      [0, 1],
      [0, 0],
    ];
    const bandGeo = sheet(
      160,
      4,
      (u, v) => {
        const [out, up] = section[Math.round(v * 4) % 4]!;
        const y = seat + up * (h + peak * points(u) ** 1.4);
        return ring(f, u, r(u), out + flare(y), y);
      },
      true,
    );
    const gold = "#E8B04A";
    const parts = [part(look, bandGeo, gold)];
    for (let k = 0; k < 5; k++) {
      const top = ring(
        f,
        k / 5,
        r(k / 5),
        0.002 + flare(seat + h + peak),
        seat + h + peak + 0.03 * R,
      );
      parts.push(part(look, ball(top, 0.045 * R, 0), gold));
      const gem = ring(f, k / 5, r(k / 5), 0.006 + flare(seat + h * 0.45), seat + h * 0.45);
      parts.push(part(look, ball(gem, 0.06 * R, 0), k % 2 === 0 ? "#C8323C" : "#2A8C96"));
    }
    return parts;
  },
};

/** The hats, by the prop vocabulary's ids. */
export const HAT_IDS: ReadonlyArray<string> = Object.keys(HATS);

/** A hat built for this head and look, in the head bone's frame; null for an id that isn't a hat. */
export const hatFor = (id: string, f: HeadFit, vrm?: VRM) => {
  const make = HATS[id];
  if (make === undefined) return null;
  const g = new THREE.Group();
  g.name = `hat:${id}`;
  g.add(...make(f, vrm === undefined ? { surface: null, outline: null } : lookOf(vrm)));
  return g;
};

/**
 * Her head read off the model as it stands: every vertex her head bone or the hair under it moves most, in the frame
 * a hat is built in (propKit frameOn, turned to face her front). Read when a hat goes on, not per frame.
 */
const headOf = (vrm: VRM, frame: THREE.Object3D, turn: 1 | -1): HeadFit | null => {
  const raw = vrm.humanoid.getRawBoneNode("head");
  if (raw === null) return null;
  const under = new Set<THREE.Object3D>();
  raw.traverse((o) => under.add(o));
  vrm.scene.updateMatrixWorld(true);
  const toHead = frame.matrixWorld.clone().invert();
  const pts: number[] = [];
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const pos = m.geometry.getAttribute("position");
    const idx = m.geometry.getAttribute("skinIndex");
    const wt = m.geometry.getAttribute("skinWeight");
    if (!pos || !idx || !wt) return;
    const stride = Math.max(1, Math.floor(pos.count / 12_000));
    for (let i = 0; i < pos.count; i += stride) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (wt.getComponent(i, k) > wt.getComponent(i, best)) best = k;
      if (!under.has(m.skeleton.bones[idx.getComponent(i, best)]!)) continue;
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld).applyMatrix4(toHead);
      pts.push(v.x * turn, v.y, v.z * turn);
    }
  });
  if (pts.length < 60) return null;
  const eye = vrm.humanoid.getRawBoneNode("leftEye");
  return fitHead(pts, eye ? eye.getWorldPosition(v).applyMatrix4(toHead).y : undefined);
};

/**
 * A hat made for her head as it is now, built in `frame` (propKit frameOn on her head); null for an id that isn't a
 * hat or a model without a head.
 */
export const wearHat = (vrm: VRM, id: string, frame: THREE.Object3D) => {
  if (!Object.hasOwn(HATS, id)) return null;
  // a VRM 0 model faces -z in its own axes (three-vrm turns its scene round instead)
  const turn = vrm.meta.metaVersion === "0" ? -1 : 1;
  const fit = headOf(vrm, frame, turn);
  const hat = fit === null ? null : hatFor(id, fit, vrm);
  hat?.rotation.set(0, turn === -1 ? Math.PI : 0, 0);
  return hat;
};
