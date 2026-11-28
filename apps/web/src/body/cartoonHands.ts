/**
 * A cartoon's floating hands in 3D, in the 2D rig's style (rig.js: a mitten with three fingers and a thumb, outlined, in
 * the character's own colours), from the morph-live source (cartoonHands.js). Where each sits, its size and colours come
 * from the form's data (build_cartoon.py measures the drawing); a hand moves out until it clears the cartoon's surface.
 */
import * as THREE from "three";

export interface CartoonHandSpec {
  /** -1 her right (the drawing's left), 1 her left. */
  readonly side: number;
  readonly shoulder: readonly [number, number, number];
  readonly hand: readonly [number, number, number];
  readonly r: number;
  readonly fill: readonly [number, number, number];
  readonly dark: readonly [number, number, number];
}

// the 2D rig's relaxed hand: [index, middle, ring, thumb] curl in radians per joint
const RELAX = [0.55, 0.65, 0.75, 0.35] as const;

/** How far a point sits outside the body's surface (negative: inside), from its rest mesh (cartoon-local). */
function bodyProfile(loc: Float32Array, n: number, height: number, RY = 40, RA = 48) {
  const cx = new Float32Array(RY);
  const cz = new Float32Array(RY);
  const cnt = new Float32Array(RY);
  const r = new Float32Array(RY * RA);
  const row = (y: number) => Math.min(RY - 1, Math.max(0, Math.floor((y / height) * RY)));
  const ang = (dx: number, dz: number) =>
    Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * RA) % RA;
  for (let i = 0; i < n; i++) {
    const k = row(loc[i * 3 + 1]!);
    cx[k]! += loc[i * 3]!;
    cz[k]! += loc[i * 3 + 2]!;
    cnt[k]!++;
  }
  for (let k = 0; k < RY; k++)
    if (cnt[k]) {
      cx[k]! /= cnt[k]!;
      cz[k]! /= cnt[k]!;
    }
  for (let i = 0; i < n; i++) {
    const k = row(loc[i * 3 + 1]!);
    const dx = loc[i * 3]! - cx[k]!;
    const dz = loc[i * 3 + 2]! - cz[k]!;
    const a = k * RA + ang(dx, dz);
    r[a] = Math.max(r[a]!, Math.hypot(dx, dz));
  }
  return (p: THREE.Vector3) => {
    if (p.y < 0 || p.y > height) return 1;
    const k = row(p.y);
    const dx = p.x - cx[k]!;
    const dz = p.z - cz[k]!;
    const a = ang(dx, dz);
    // the neighbouring rows and angles too: a ledge (a flange) starts between two rows
    let rr = 0;
    for (const kk of [k - 1, k, k + 1])
      if (kk >= 0 && kk < RY)
        for (const aa of [a - 1, a, a + 1]) rr = Math.max(rr, r[kk * RA + ((aa + RA) % RA)]!);
    return Math.hypot(dx, dz) - rr;
  };
}

const rgb = (c: readonly [number, number, number]) =>
  new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);

/** One hand: wrist at the origin, fingers down, curled toward the body; a flat fill and a dark inverted-hull outline. */
function makeHand(R: number, fill: THREE.Color, dark: THREE.Color, side: number) {
  const geos: THREE.BufferGeometry[] = [];
  const mats = [
    new THREE.MeshLambertMaterial({ color: fill, emissive: fill.clone().multiplyScalar(0.35) }),
    new THREE.MeshBasicMaterial({ color: dark, side: THREE.BackSide }),
  ];
  const solid = (geo: THREE.BufferGeometry, parent: THREE.Object3D) => {
    geos.push(geo);
    const m = new THREE.Mesh(geo, mats[0]);
    const o = new THREE.Mesh(geo, mats[1]);
    o.scale.setScalar(1.1);
    m.add(o);
    parent.add(m);
    return m;
  };
  const capsule = (r: number, l: number) =>
    new THREE.CapsuleGeometry(r, l, 4, 10).translate(0, -l / 2 - r * 0.3, 0);
  const wrist = new THREE.Group();
  const palm = solid(new THREE.SphereGeometry(1, 16, 12), wrist);
  palm.scale.set(0.5 * R, 0.62 * R, 0.62 * R);
  palm.position.y = -0.55 * R;
  // index (front), middle, ring
  [0.32, 0, -0.32].forEach((z, f) => {
    const b0 = new THREE.Group();
    b0.position.set(0, -1.0 * R, z * R);
    b0.rotation.z = -side * RELAX[f]!;
    wrist.add(b0);
    solid(capsule(0.2 * R, 0.28 * R), b0);
    const b1 = new THREE.Group();
    b1.position.y = -0.5 * R;
    b1.rotation.z = -side * RELAX[f]! * 1.1;
    b0.add(b1);
    solid(capsule(0.19 * R, 0.24 * R), b1);
  });
  const t0 = new THREE.Group();
  t0.position.set(0, -0.45 * R, 0.5 * R);
  t0.rotation.x = 0.9;
  wrist.add(t0);
  solid(capsule(0.2 * R, 0.22 * R), t0);
  const t1 = new THREE.Group();
  t1.position.y = -0.42 * R;
  t1.rotation.z = -side * RELAX[3];
  t0.add(t1);
  solid(capsule(0.19 * R, 0.18 * R), t1);
  return {
    wrist,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

export interface CartoonHands {
  readonly root: THREE.Group;
  /** On the cartoon's frame `e` (world), grown `k` of the way out from her shoulders (0: melted into the body). */
  readonly place: (e: THREE.Matrix4, k: number) => void;
  readonly dispose: () => void;
}

/** Her floating hands beside the cartoon, at their 2D places, clear of its surface. */
export function makeCartoonHands(
  specs: ReadonlyArray<CartoonHandSpec>,
  loc: Float32Array,
  n: number,
  height: number,
): CartoonHands {
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.visible = false;
  const outside = bodyProfile(loc, n, height);
  const hands = specs.map((h) => {
    const R = h.r * 1.45;
    const base = new THREE.Group();
    base.matrixAutoUpdate = false;
    root.add(base);
    const hand = makeHand(R, rgb(h.fill), rgb(h.dark), h.side);
    // a floating hand's fingers hang below its centre: out to the side until it clears with a wider berth
    const at = new THREE.Vector3(...h.hand).add(new THREE.Vector3(h.side * 0.35 * R, 0.4 * R, 0));
    for (let i = 0; i < 40 && outside(at) - R * 1.8 < 0; i++) at.x += h.side * 0.006;
    hand.wrist.position.copy(at);
    base.add(hand.wrist);
    return { S: new THREE.Vector3(...h.shoulder), base, hand };
  });
  const T = new THREE.Matrix4();
  const Sc = new THREE.Matrix4();
  return {
    root,
    place: (e, k) => {
      root.visible = k > 0.01;
      if (!root.visible) return;
      root.matrix.copy(e);
      for (const H of hands) {
        H.base.matrix
          .makeTranslation(H.S.x, H.S.y, H.S.z)
          .multiply(Sc.makeScale(k, k, k))
          .multiply(T.makeTranslation(-H.S.x, -H.S.y, -H.S.z));
      }
      root.updateMatrixWorld(true);
    },
    dispose: () => {
      root.removeFromParent();
      for (const H of hands) H.hand.dispose();
    },
  };
}
