/**
 * A bird's wings, rigged from the model's own mesh (morph-live wingRig.js): its authored flap (morph targets, one
 * wingbeat) for the stroke, and two joints per wing found from its span (shoulder at the body's edge, wrist part-way
 * out) that fold the wings down along the body. Positions are blended on the CPU (a low-poly bird has a few hundred
 * vertices), so the change's hug grid reads them.
 */
import * as THREE from "three";

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

export interface WingRig {
  /** `phase` 0..1 through one beat; `glide` 0..1 toward the held glide frame; `fold` 0 spread .. 1 perched. */
  readonly pose: (phase: number, glide: number, fold: number) => void;
}

export function makeWingRig(mesh: THREE.Mesh): WingRig {
  const g = mesh.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const base = Float32Array.from(pos.array as Float32Array);
  const T = (g.morphAttributes["position"] ?? []) as THREE.BufferAttribute[];
  const rel = g.morphTargetsRelative;
  const n = pos.count;
  const K = Math.max(1, T.length);
  const out = pos.array as Float32Array;
  // the rig writes positions itself
  mesh.morphTargetInfluences?.fill(0);
  mesh.morphTargetInfluences = undefined as unknown as number[];
  g.morphAttributes = {};
  const frame = (k: number, i: number, c: number) =>
    T.length === 0
      ? base[i * 3 + c]!
      : rel
        ? base[i * 3 + c]! + (T[k]!.array as Float32Array)[i * 3 + c]!
        : (T[k]!.array as Float32Array)[i * 3 + c]!;
  // the body's half width (where most of the mass is) and the span, from the first frame
  let span = 0;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    span = Math.max(span, Math.abs(frame(0, i, 0)));
    xs.push(Math.abs(frame(0, i, 0)));
  }
  xs.sort((a, b) => a - b);
  const body = xs[Math.floor(n * 0.35)]! * 1.15;
  const sh = Math.max(body, 0.14 * span);
  const wr = sh + 0.45 * (span - sh);
  // the glide frame: the beat's frame with the widest wings
  let glideK = 0;
  let best = -1e9;
  for (let k = 0; k < K; k++) {
    let w = 0;
    let flat = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.abs(frame(k, i, 0));
      if (x > wr) {
        w = Math.max(w, x);
        flat += Math.abs(frame(k, i, 1));
        m++;
      }
    }
    const s = w - 0.4 * (m ? flat / m : 0);
    if (s > best) {
      best = s;
      glideK = k;
    }
  }
  let ymid = 0;
  for (let i = 0; i < n; i++) if (Math.abs(frame(0, i, 0)) < sh) ymid += frame(0, i, 1) / n;
  const p = new THREE.Vector3();
  const pose = (phase: number, glide: number, fold: number) => {
    const f = (((phase % 1) + 1) % 1) * K;
    const k0 = Math.floor(f) % K;
    const k1 = (k0 + 1) % K;
    const u = f - Math.floor(f);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = frame(k0, i, c) * (1 - u) + frame(k1, i, c) * u;
        p.setComponent(c, v + (frame(glideK, i, c) - v) * glide);
      }
      const ax = Math.abs(p.x);
      const side = Math.sign(p.x) || 1;
      if (fold > 0 && ax > sh * 0.85) {
        // shoulder: the wing swings down along the body's side; wrist: its hand folds back along it
        const ws = smooth((ax - sh * 0.85) / (sh * 0.3));
        const a1 = fold * 1.45 * ws;
        const x0 = side * sh;
        const dx = p.x - x0;
        const dy = p.y - ymid;
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        const rx = dx * c1 + side * dy * s1;
        const ry = -side * dx * s1 + dy * c1;
        const d = Math.hypot(rx, ry);
        const k = 1 - 0.5 * fold * ws;
        p.x = x0 + rx * k * (1 - 0.55 * fold * ws);
        p.y = ymid + ry * k;
        p.z -= fold * ws * 0.35 * d;
      }
      out[i * 3] = p.x;
      out[i * 3 + 1] = p.y;
      out[i * 3 + 2] = p.z;
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  };
  pose(0, 1, 1);
  return { pose };
}
