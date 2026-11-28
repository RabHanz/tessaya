/**
 * Her shapeshift between her cartoon and her body (the passed v4 morph, Library film-shapeshift-morph-live), drawn in
 * the body's own scene: the drawing melts to plain, the skin hugs her crown-first, then slides off top-down while her
 * colours come through. The clock is @t3tools/tessaya-shared/formMorph; this file only draws it. It renders nothing of
 * its own between changes: the host asks for frames while `active`.
 */
import {
  morphAt,
  morphSeconds,
  swapAt,
  swapSeconds,
  type MorphDir,
  type MorphLook,
} from "@t3tools/tessaya-shared/formMorph";
import * as THREE from "three";

import { makeCartoonHands, type CartoonHands, type CartoonHandSpec } from "./cartoonHands";

/** A cartoon skin's data (film-work build_cartoon.py): `<id>.bin` and its art beside it. */
export interface CartoonSpec {
  readonly id: string;
  readonly count: number;
  readonly ring: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly plain: readonly [number, number, number];
  /** Parts standing apart from the body (hands, ears, threads): `<id>-parts.bin` and `-parts.jpg`. */
  readonly parts?: { readonly count: number; readonly index: number };
  /** Her floating hands' places and colours (cartoonHands.ts); their drawn solids in `parts` then give way to them. */
  readonly hands?: ReadonlyArray<CartoonHandSpec>;
}

/** The cartoon's hands: floating beside her as the 2D rig's floating hands, or none. */
export type CartoonHandsMode = "floating" | "none";

const GRID_A = 96;
const GRID_R = 48;

// the water look: translucent water with highlights and a running ripple. Over a transparent window (the desk) there is
// nothing behind to refract, so it is drawn see-through instead
const WATER_GLSL = `uniform float uWtr, uWT;
vec3 wRipple(vec3 p, float t) { return vec3(cos(p.y * 23.0 - t * 5.0 + p.x * 7.0) * 0.5, sin(p.x * 17.0 + p.z * 13.0 + t * 3.1) * 0.3, cos(p.y * 19.0 - t * 4.3 + p.z * 9.0) * 0.5); }
vec4 waterOf(vec3 W, vec3 N, vec3 tint, float tintAmt) {
  vec3 V = normalize(cameraPosition - W); N = normalize(N + 0.2 * wRipple(W, uWT)); if (dot(N, V) < 0.0) N = -N;
  vec3 col = mix(vec3(0.74, 0.84, 0.93), tint, tintAmt);
  float fr = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0); col = mix(col, vec3(0.93, 0.95, 1.0), 0.12 + 0.6 * fr);
  vec3 H = normalize(normalize(vec3(2.0, 3.0, 3.0)) + V), H2 = normalize(normalize(vec3(-3.0, 1.6, 2.0)) + V);
  float spec = 1.6 * pow(max(dot(N, H), 0.0), 140.0) + 0.12 * pow(max(dot(N, H), 0.0), 24.0) + 0.6 * pow(max(dot(N, H2), 0.0), 90.0);
  return vec4(col + vec3(1.0, 0.97, 0.92) * spec, clamp(0.5 + 0.45 * fr + spec, 0.0, 1.0)); }`;
const DITHER = "fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)";

type U = Record<string, THREE.IUniform>;
const waterU = (): U => ({ uWtr: { value: 0 }, uWT: { value: 0 } });

export interface CartoonSkin {
  readonly mesh: THREE.Mesh;
  readonly U: U;
  readonly loc: Float32Array;
  readonly th: Float32Array;
  readonly hh: Float32Array;
  readonly g0: Int32Array;
  readonly gw: Float32Array;
  readonly n: number;
  readonly plain: THREE.Color;
  readonly parts: {
    readonly mesh: THREE.Mesh;
    readonly rest: Float32Array;
    readonly anc: Float32Array;
  } | null;
  readonly face: {
    readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    readonly vs: Int32Array;
  } | null;
  readonly hands: CartoonHands | null;
}

/** Loads a cartoon skin from `base` (`<id>.bin`, `-front.jpg`, `-side.jpg`, and `-face.json`/`.png` when it has them). */
export async function loadCartoonSkin(
  base: string,
  spec: CartoonSpec,
  hands: CartoonHandsMode = "floating",
): Promise<CartoonSkin> {
  const buf = await (await fetch(`${base}/${spec.id}.bin`)).arrayBuffer();
  const n = spec.count;
  const q = new Uint16Array(buf, 0, n * 3);
  const quv = new Uint16Array(buf, n * 6, n * 2);
  const qfr = new Uint8Array(buf, n * 10, n);
  const loc = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const fr = new Float32Array(n);
  const th = new Float32Array(n);
  const hh = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++)
      loc[i * 3 + k] = spec.min[k]! + (q[i * 3 + k]! / 65535) * (spec.max[k]! - spec.min[k]!);
    uv[i * 2] = quv[i * 2]! / 65535;
    uv[i * 2 + 1] = quv[i * 2 + 1]! / 65535;
    fr[i] = qfr[i]! / 255;
    th[i] = Math.atan2(loc[i * 3 + 2]!, loc[i * 3]!);
    hh[i] = loc[i * 3 + 1]! / spec.max[1];
  }
  const N = spec.ring;
  const idx: number[] = [];
  for (let r = 0; r < n / N - 1; r++)
    for (let k = 0; k < N; k++) {
      const a = r * N + k;
      const b = r * N + ((k + 1) % N);
      idx.push(a, b, b + N, a, b + N, a + N);
    }
  // each skin point's place on the hug grid (bilinear, the angle wraps)
  const g0 = new Int32Array(n * 4);
  const gw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const fa = ((th[i]! + Math.PI) / (2 * Math.PI)) * GRID_A - 0.5;
    const fy = Math.min(GRID_R - 1.001, Math.max(0, hh[i]! * (GRID_R - 1)));
    const a0 = Math.floor(fa);
    const x = fa - a0;
    const r0 = Math.floor(fy);
    const y = fy - r0;
    const A0 = ((a0 % GRID_A) + GRID_A) % GRID_A;
    const A1 = (A0 + 1) % GRID_A;
    g0.set(
      [r0 * GRID_A + A0, r0 * GRID_A + A1, (r0 + 1) * GRID_A + A0, (r0 + 1) * GRID_A + A1],
      i * 4,
    );
    gw.set([(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(loc.slice(), 3).setUsage(THREE.DynamicDrawUsage),
  );
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("fr", new THREE.BufferAttribute(fr, 1));
  geo.setIndex(idx);
  const tl = new THREE.TextureLoader();
  const tex = (url: string) =>
    tl.loadAsync(url).then((t) => {
      t.colorSpace = THREE.NoColorSpace;
      return t;
    });
  const [tf, ts] = await Promise.all([
    tex(`${base}/${spec.id}-front.jpg`),
    tex(`${base}/${spec.id}-side.jpg`),
  ]);
  const plain = new THREE.Color(spec.plain[0] / 255, spec.plain[1] / 255, spec.plain[2] / 255);
  const U: U = {
    uFront: { value: tf },
    uSide: { value: ts },
    uPlain: { value: plain },
    uPlainAmt: { value: 0 },
    uLevel: { value: 10 },
    ...waterU(),
  };
  // the art as drawn, shaded by how each face meets the key (floor 0.8); water is see-through, so it blends
  const mat = (U: U) =>
    new THREE.ShaderMaterial({
      uniforms: U,
      side: THREE.DoubleSide,
      vertexShader: `attribute float fr; varying vec2 vUv; varying float vFr; varying vec3 vW; varying vec3 vN;
      void main(){ vUv = uv; vFr = fr; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D uFront, uSide; uniform vec3 uPlain; uniform float uPlainAmt, uLevel; varying vec2 vUv; varying float vFr; varying vec3 vW; varying vec3 vN;
      ${WATER_GLSL}
      void main(){
        float a = 1.0 - smoothstep(uLevel - 0.1, uLevel + 0.1, vW.y);
        if (a < 0.999 && a <= ${DITHER}) discard;
        vec3 art = mix(texture2D(uSide, vUv).rgb, texture2D(uFront, vUv).rgb, vFr);
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); if (!gl_FrontFacing) n = -n;
        float sh = mix(0.8, 1.0, clamp((dot(n, normalize(vec3(0.45, 0.75, 0.5))) + 0.6) / 1.05, 0.0, 1.0));
        if (uWtr > 0.5) { vec3 nn = length(vN) > 0.5 ? normalize(vN) : n; vec4 w = waterOf(vW, nn, uPlain, 0.06);
          gl_FragColor = mix(vec4(art * sh, 1.0), w, uPlainAmt); return; }
        gl_FragColor = vec4(mix(art, uPlain, uPlainAmt) * sh, 1.0); }`,
    });
  const mesh = new THREE.Mesh(geo, mat(U));
  mesh.frustumCulled = false;
  mesh.visible = false;
  // the parts melt back into the body at their anchors while the drawing goes plain, and grow out again as it returns
  let parts: CartoonSkin["parts"] = null;
  if (spec.parts) {
    const pb = await (await fetch(`${base}/${spec.id}-parts.bin`)).arrayBuffer();
    const m = spec.parts.count;
    const rest = new Float32Array(pb, 0, m * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute(
      "position",
      new THREE.BufferAttribute(rest.slice(), 3).setUsage(THREE.DynamicDrawUsage),
    );
    pg.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(pb, m * 12, m * 2), 2));
    pg.setAttribute("fr", new THREE.BufferAttribute(new Float32Array(m).fill(1), 1));
    const all = new Uint32Array(pb, m * 32, spec.parts.index);
    // a byte per vertex after the index marks the drawn hands, which give way to the modelled ones
    const isHand =
      spec.hands && pb.byteLength >= m * 33 + spec.parts.index * 4
        ? new Uint8Array(pb, m * 32 + spec.parts.index * 4, m)
        : null;
    const keep: number[] = [];
    for (let f = 0; f < all.length; f += 3)
      if (isHand === null || !isHand[all[f]!]) keep.push(all[f]!, all[f + 1]!, all[f + 2]!);
    pg.setIndex(keep);
    const tp = await tex(`${base}/${spec.id}-parts.jpg`);
    const pm = new THREE.Mesh(pg, mat({ ...U, uFront: { value: tp }, uSide: { value: tp } }));
    pm.frustumCulled = false;
    pm.visible = false;
    parts = { mesh: pm, rest, anc: new Float32Array(pb, m * 20, m * 3) };
  }
  return {
    mesh,
    U,
    parts,
    loc,
    th,
    hh,
    g0,
    gw,
    n,
    plain,
    face: await loadFace(base, spec.id, idx, uv, fr, tf),
    hands:
      spec.hands && hands === "floating" ? makeCartoonHands(spec.hands, loc, n, spec.max[1]) : null,
  };
}

/** The drawn face as its own patch of skin vertices, so it rides the forming skin and fades whole, unsmeared. */
async function loadFace(
  base: string,
  id: string,
  idx: ReadonlyArray<number>,
  uv: Float32Array,
  fr: Float32Array,
  front: THREE.Texture,
): Promise<CartoonSkin["face"]> {
  const res = await fetch(`${base}/${id}-face.json`).catch(() => null);
  if (!res?.ok) return null;
  const box = (await res.json()) as { u0: number; u1: number; v0: number; v1: number };
  const mask = await new THREE.TextureLoader().loadAsync(`${base}/${id}-face.png`);
  const inb = (i: number) =>
    fr[i]! > 0.5 &&
    uv[i * 2]! > box.u0 &&
    uv[i * 2]! < box.u1 &&
    uv[i * 2 + 1]! > box.v0 &&
    uv[i * 2 + 1]! < box.v1;
  const map = new Map<number, number>();
  const fi: number[] = [];
  for (let f = 0; f < idx.length; f += 3)
    if (inb(idx[f]!) && inb(idx[f + 1]!) && inb(idx[f + 2]!))
      for (let k = 0; k < 3; k++) {
        const i = idx[f + k]!;
        if (!map.has(i)) map.set(i, map.size);
        fi.push(map.get(i)!);
      }
  const vs = Int32Array.from(map.keys());
  const fuv = new Float32Array(vs.length * 2);
  vs.forEach((i, j) => fuv.set(uv.subarray(i * 2, i * 2 + 2), j * 2));
  const fg = new THREE.BufferGeometry();
  fg.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(vs.length * 3), 3).setUsage(THREE.DynamicDrawUsage),
  );
  fg.setAttribute("uv", new THREE.BufferAttribute(fuv, 2));
  fg.setIndex(fi);
  const mesh = new THREE.Mesh(
    fg,
    new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      uniforms: { uFront: { value: front }, uMask: { value: mask }, uFade: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D uFront, uMask; uniform float uFade; varying vec2 vUv;
        void main(){ if (texture2D(uMask, vUv).r < 0.5) discard; gl_FragColor = vec4(texture2D(uFront, vUv).rgb, uFade); }`,
    }),
  );
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, vs };
}

/** Her body's side of the change: each material learns to hide below the wipe and take the cartoon's plain colour. */
interface BodyForm {
  readonly U: U;
  readonly meshes: ReadonlyArray<THREE.Mesh>;
  readonly cell: Int32Array;
  readonly pos: Float32Array;
  readonly co: Float32Array;
  readonly cs: Float32Array;
  readonly tmp: Float32Array;
}

function patchMaterial(m: THREE.Material, U: U) {
  if (m.userData.formMorph) return;
  m.userData.formMorph = true;
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float morphLead; varying float vMLead; varying vec3 vMW;",
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvMLead = morphLead; vMW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform float uPP, uLevel, uLegs, uFloor, uH; uniform vec3 uLow, uHigh; varying float vMLead; varying vec3 vMW;\n${WATER_GLSL}`,
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        { float y = vMW.y;
          float vis = max(smoothstep(uLevel - 0.22, uLevel - 0.02, y), 1.0 - smoothstep(uLegs - 0.03, uLegs + 0.03, y));
          if (vis < 0.999 && vis <= ${DITHER}) discard;
          float c = 1.0 - smoothstep(0.0, 0.55, uPP - vMLead * 0.45);
          vec3 n = normalize(cross(dFdx(vMW), dFdy(vMW)));
          float s = mix(0.8, 1.0, clamp((dot(n, normalize(vec3(0.45, 0.75, 0.5))) + 0.6) / 1.05, 0.0, 1.0));
          vec4 cov = uWtr > 0.5 ? waterOf(vMW, n, gl_FragColor.rgb, 0.22) : vec4(mix(uLow, uHigh, smoothstep(0.2, 0.95, (y - uFloor) / uH)) * s, 1.0);
          gl_FragColor = mix(gl_FragColor, cov, c); }`,
      );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|formMorph`;
  m.needsUpdate = true;
}

const _v = new THREE.Vector3();

// a body's materials are patched once with one set of uniforms: every later change on it shares them
const prepared = new WeakMap<THREE.Object3D, BodyForm>();

/** Readies a loaded body (VRM scene or any skinned glTF) for the change: once per model, the skin's plain colour each time. */
export function prepareBody(root: THREE.Object3D, plain: THREE.Color): BodyForm {
  const known = prepared.get(root);
  if (known) {
    (known.U.uLow!.value as THREE.Color).copy(plain).multiplyScalar(0.9);
    (known.U.uHigh!.value as THREE.Color).copy(plain).lerp(new THREE.Color(1, 1, 1), 0.35);
    return known;
  }
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.attributes.position)
      meshes.push(o as THREE.Mesh);
  });
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3().setFromObject(root);
  const floor = box.min.y;
  const height = box.max.y - box.min.y || 1;
  const U: U = {
    uPP: { value: 1 },
    uLevel: { value: -10 },
    uLegs: { value: -10 },
    uFloor: { value: floor },
    uH: { value: height },
    uLow: { value: plain.clone().multiplyScalar(0.9) },
    uHigh: { value: plain.clone().lerp(new THREE.Color(1, 1, 1), 0.35) },
    ...waterU(),
  };
  // the hug grid: per height row and angle round her, her outermost vertex at rest (v4 cast a ray in from outside)
  const pts: Array<[number, number, number, number, number]> = [];
  meshes.forEach((me, mi) => {
    for (let i = 0; i < me.geometry.attributes.position!.count; i++) {
      me.getVertexPosition(i, _v).applyMatrix4(me.matrixWorld).applyMatrix4(inv);
      pts.push([mi, i, _v.x, _v.y, _v.z]);
    }
  });
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) [y0, y1] = [Math.min(y0, p[3]), Math.max(y1, p[3])];
  const share = (y: number) => Math.min(1, Math.max(0, (y - y0) / (y1 - y0 || 1)));
  meshes.forEach((me, mi) => {
    const lead = new Float32Array(me.geometry.attributes.position!.count);
    for (const p of pts) if (p[0] === mi) lead[p[1]] = 0.75 * (1 - share(p[3])); // crown first, the hem and legs last
    me.geometry.setAttribute("morphLead", new THREE.BufferAttribute(lead, 1));
    for (const m of Array.isArray(me.material) ? me.material : [me.material]) patchMaterial(m, U);
  });
  const rowOf = (y: number) => Math.round(share(y) * (GRID_R - 1));
  const bb = Array.from({ length: GRID_R }, () => [Infinity, -Infinity, Infinity, -Infinity]);
  for (const p of pts) {
    const b = bb[rowOf(p[3])]!;
    b[0] = Math.min(b[0]!, p[2]);
    b[1] = Math.max(b[1]!, p[2]);
    b[2] = Math.min(b[2]!, p[4]);
    b[3] = Math.max(b[3]!, p[4]);
  }
  const cell = new Int32Array(GRID_A * GRID_R * 2).fill(-1);
  const best = new Float32Array(GRID_A * GRID_R).fill(-1);
  for (const p of pts) {
    const r = rowOf(p[3]);
    const b = bb[r]!;
    const x = p[2] - (b[0]! + b[1]!) / 2;
    const z = p[4] - (b[2]! + b[3]!) / 2;
    const a = Math.floor(((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * GRID_A) % GRID_A;
    const c = r * GRID_A + a;
    const d = Math.hypot(x, z);
    if (d > best[c]!) {
      best[c] = d;
      cell[c * 2] = p[0];
      cell[c * 2 + 1] = p[1];
    }
  }
  // an empty cell takes the nearest filled one round its row, else in the nearest row
  for (let c = 0; c < GRID_A * GRID_R; c++) {
    if (cell[c * 2]! >= 0) continue;
    const r = Math.floor(c / GRID_A);
    const a = c % GRID_A;
    let got = -1;
    for (let d = 1; d <= GRID_A / 2 && got < 0; d++)
      for (const s of [a + d, a - d]) {
        const o = r * GRID_A + (((s % GRID_A) + GRID_A) % GRID_A);
        if (got < 0 && best[o]! >= 0) got = o;
      }
    for (let d = 1; d < GRID_R && got < 0; d++)
      for (const rr of [r - d, r + d])
        if (got < 0 && rr >= 0 && rr < GRID_R && best[rr * GRID_A + a]! >= 0) got = rr * GRID_A + a;
    if (got >= 0) {
      cell[c * 2] = cell[got * 2]!;
      cell[c * 2 + 1] = cell[got * 2 + 1]!;
    }
  }
  const form: BodyForm = {
    U,
    meshes,
    cell,
    pos: new Float32Array(GRID_A * GRID_R * 3),
    co: new Float32Array(GRID_R * NC),
    cs: new Float32Array(GRID_R * NC),
    tmp: new Float32Array(GRID_A * GRID_R * 3),
  };
  prepared.set(root, form);
  return form;
}

const LP_K = 4;
const ROW_W = 5;
const K1 = LP_K + 1;
const NC = 4 * K1 + 2;
const COS = new Float32Array(K1 * GRID_A);
const SIN = new Float32Array(K1 * GRID_A);
for (let h = 0; h <= LP_K; h++)
  for (let a = 0; a < GRID_A; a++) {
    const th = ((a + 0.5) / GRID_A) * 2 * Math.PI;
    COS[h * GRID_A + a] = Math.cos(h * th);
    SIN[h * GRID_A + a] = Math.sin(h * th);
  }

/**
 * The grid on her as she is posed now, a little out from each row's centre. Each row's radius and height are low-passed
 * round the row (harmonics 0..LP_K) and across rows, so the skin hugs her envelope, not every strand and fold (which made
 * frames lumpy mid-change); what reaches out past a row's mean (an arm held out) counts half.
 */
function trackGrid(B: BodyForm) {
  const { cell, pos, meshes, co, cs, tmp } = B;
  for (let c = 0; c < GRID_A * GRID_R; c++) {
    const me = meshes[cell[c * 2]!];
    if (!me) continue;
    me.getVertexPosition(cell[c * 2 + 1]!, _v).applyMatrix4(me.matrixWorld);
    pos[c * 3] = _v.x;
    pos[c * 3 + 1] = _v.y;
    pos[c * 3 + 2] = _v.z;
  }
  const centre = (r: number) => {
    let x = 0;
    let z = 0;
    for (let a = 0; a < GRID_A; a++) {
      x += pos[(r * GRID_A + a) * 3]! / GRID_A;
      z += pos[(r * GRID_A + a) * 3 + 2]! / GRID_A;
    }
    return [x, z] as const;
  };
  for (let r = 0; r < GRID_R; r++) {
    const [x, z] = centre(r);
    for (let a = 0; a < GRID_A; a++) {
      const c = (r * GRID_A + a) * 3;
      const dx = pos[c]! - x;
      const dz = pos[c + 2]! - z;
      const d = Math.hypot(dx, dz) || 1;
      pos[c] = pos[c]! + (dx / d) * 0.008;
      pos[c + 2] = pos[c + 2]! + (dz / d) * 0.008;
    }
  }
  co.fill(0);
  for (let r = 0; r < GRID_R; r++) {
    const o = r * NC;
    const [x, z] = centre(r);
    co[o + 4 * K1] = x;
    co[o + 4 * K1 + 1] = z;
    let dm = 0;
    for (let a = 0; a < GRID_A; a++) {
      const c = (r * GRID_A + a) * 3;
      dm += Math.hypot(pos[c]! - x, pos[c + 2]! - z) / GRID_A;
    }
    for (let a = 0; a < GRID_A; a++) {
      const c = (r * GRID_A + a) * 3;
      const d0 = Math.hypot(pos[c]! - x, pos[c + 2]! - z);
      const d = d0 > dm ? dm + (d0 - dm) * 0.45 : d0;
      const y = pos[c + 1]!;
      for (let h = 0; h <= LP_K; h++) {
        const cc = COS[h * GRID_A + a]!;
        const si = SIN[h * GRID_A + a]!;
        co[o + h] = co[o + h]! + d * cc;
        co[o + K1 + h] = co[o + K1 + h]! + d * si;
        co[o + 2 * K1 + h] = co[o + 2 * K1 + h]! + y * cc;
        co[o + 3 * K1 + h] = co[o + 3 * K1 + h]! + y * si;
      }
    }
  }
  // across rows (a hand or elbow made a shelf where its rows begin); heights stay their own row's, so the crown keeps its height
  for (let r = 0; r < GRID_R; r++)
    for (let j = 0; j < NC; j++) {
      if (j >= 2 * K1 && j < 4 * K1) {
        cs[r * NC + j] = co[r * NC + j]!;
        continue;
      }
      let v = 0;
      let w = 0;
      for (let dr = -ROW_W; dr <= ROW_W; dr++) {
        const rr = Math.min(GRID_R - 1, Math.max(0, r + dr));
        const k = ROW_W + 1 - Math.abs(dr);
        v += co[rr * NC + j]! * k;
        w += k;
      }
      cs[r * NC + j] = v / w;
    }
  for (let r = 0; r < GRID_R; r++) {
    const o = r * NC;
    const x = cs[o + 4 * K1]!;
    const z = cs[o + 4 * K1 + 1]!;
    for (let a = 0; a < GRID_A; a++) {
      let d = cs[o]! / GRID_A;
      let y = cs[o + 2 * K1]! / GRID_A;
      for (let h = 1; h <= LP_K; h++) {
        const cc = COS[h * GRID_A + a]!;
        const si = SIN[h * GRID_A + a]!;
        d += (2 / GRID_A) * (cs[o + h]! * cc + cs[o + K1 + h]! * si);
        y += (2 / GRID_A) * (cs[o + 2 * K1 + h]! * cc + cs[o + 3 * K1 + h]! * si);
      }
      const c = (r * GRID_A + a) * 3;
      const th = ((a + 0.5) / GRID_A) * 2 * Math.PI - Math.PI;
      pos[c] = x + Math.cos(th) * d;
      pos[c + 1] = y;
      pos[c + 2] = z + Math.sin(th) * d;
    }
  }
  // two soft passes make the skin one clean mass where neighbouring cells landed on different layers (a strand, a sleeve)
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < GRID_R; r++)
      for (let a = 0; a < GRID_A; a++) {
        let x = 0;
        let y = 0;
        let z = 0;
        let w = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= GRID_R) continue;
          for (let da = -1; da <= 1; da++) {
            const k = dr === 0 && da === 0 ? 4 : 1;
            const c = (rr * GRID_A + ((a + da + GRID_A) % GRID_A)) * 3;
            x += pos[c]! * k;
            y += pos[c + 1]! * k;
            z += pos[c + 2]! * k;
            w += k;
          }
        }
        const c = (r * GRID_A + a) * 3;
        tmp[c] = x / w;
        tmp[c + 1] = y / w;
        tmp[c + 2] = z / w;
      }
    pos.set(tmp);
  }
}

/** The parts on the loaf's frame, scaled `k` of the way out from their anchors (0: melted in, hidden). */
function placeParts(P: NonNullable<CartoonSkin["parts"]>, e: ArrayLike<number> | null, k: number) {
  P.mesh.visible = e !== null && k > 0.01;
  if (!P.mesh.visible || e === null) return;
  const attr = P.mesh.geometry.attributes.position as THREE.BufferAttribute;
  const pp = attr.array as Float32Array;
  const { rest: R, anc: A } = P;
  for (let i = 0; i < pp.length; i += 3) {
    const a = A[i]! + (R[i]! - A[i]!) * k;
    const b = A[i + 1]! + (R[i + 1]! - A[i + 1]!) * k;
    const c = A[i + 2]! + (R[i + 2]! - A[i + 2]!) * k;
    pp[i] = e[0]! * a + e[4]! * b + e[8]! * c + e[12]!;
    pp[i + 1] = e[1]! * a + e[5]! * b + e[9]! * c + e[13]!;
    pp[i + 2] = e[2]! * a + e[6]! * b + e[10]! * c + e[14]!;
  }
  attr.needsUpdate = true;
}

export interface FormMorph {
  /** Starts a change: "in" from the cartoon (placed by `loaf`, world) into her body, "out" back; `instant` lands it. */
  readonly start: (dir: MorphDir, look: MorphLook, loaf: THREE.Matrix4, instant?: boolean) => void;
  /** Draws the change `now` (ms); false once it has finished (then the host stops asking for frames). */
  readonly frame: (now: number) => boolean;
  readonly active: () => boolean;
  readonly dispose: () => void;
}

/** One change player for a body in a scene: the cartoon skin and her body share one clock. */
export function createFormMorph(
  scene: THREE.Object3D,
  skin: CartoonSkin,
  body: BodyForm,
  bodyRoot: THREE.Object3D,
): FormMorph {
  scene.add(skin.mesh);
  if (skin.face) scene.add(skin.face.mesh);
  if (skin.parts) scene.add(skin.parts.mesh);
  if (skin.hands) scene.add(skin.hands.root);
  let run: { dir: MorphDir; look: MorphLook; t0: number | null; loaf: THREE.Matrix4 } | null = null;
  const pos = skin.mesh.geometry.attributes.position as THREE.BufferAttribute;
  const p0 = [0, 0, 0];
  const settle = (dir: MorphDir) => {
    // at rest: her body whole and coloured ("in"), or the cartoon as drawn ("out")
    body.U.uLevel!.value = -10;
    body.U.uLegs!.value = -10;
    body.U.uPP!.value = 1;
    body.U.uWtr!.value = 0;
    skin.U.uLevel!.value = 10;
    skin.U.uPlainAmt!.value = 0;
    skin.U.uWtr!.value = 0;
    bodyRoot.visible = dir === "in";
    skin.mesh.visible = dir === "out";
    // the cartoon at rest stands as drawn, wherever the last drawn frame of the change left its skin (a change landed
    // at once, or a slow frame that jumped past its end)
    if (dir === "out" && run) {
      const e = run.loaf.elements;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < skin.n * 3; i += 3) {
        const a = skin.loc[i]!;
        const b = skin.loc[i + 1]!;
        const c = skin.loc[i + 2]!;
        arr[i] = e[0]! * a + e[4]! * b + e[8]! * c + e[12]!;
        arr[i + 1] = e[1]! * a + e[5]! * b + e[9]! * c + e[13]!;
        arr[i + 2] = e[2]! * a + e[6]! * b + e[10]! * c + e[14]!;
      }
      pos.needsUpdate = true;
    }
    if (skin.face) skin.face.mesh.visible = false;
    if (skin.parts) placeParts(skin.parts, run?.loaf.elements ?? null, dir === "out" ? 1 : 0);
    if (skin.hands && run) skin.hands.place(run.loaf, dir === "out" ? 1 : 0);
  };
  return {
    start: (dir, look, loaf, instant = false) => {
      run = { dir, look, t0: instant ? -Infinity : null, loaf: loaf.clone() };
    },
    active: () => run !== null,
    frame: (now) => {
      if (run === null) return false;
      run.t0 ??= now;
      const t = (now - run.t0) / 1000;
      const { dir, look } = run;
      const f = morphAt(dir, Math.min(t, morphSeconds(dir)), look);
      if (f.done) {
        settle(dir);
        run = null;
        return false;
      }
      const wet = look === "water";
      const e = run.loaf.elements;
      bodyRoot.visible = true;
      bodyRoot.updateMatrixWorld(true);
      trackGrid(body);
      const G = body.pos;
      const arr = pos.array as Float32Array;
      let top = -1e9;
      let bot = 1e9;
      let hugAny = 0;
      for (let i = 0; i < skin.n; i++) {
        const a = skin.loc[i * 3]!;
        const b = skin.loc[i * 3 + 1]!;
        const c = skin.loc[i * 3 + 2]!;
        p0[0] = e[0]! * a + e[4]! * b + e[8]! * c + e[12]!;
        p0[1] = e[1]! * a + e[5]! * b + e[9]! * c + e[13]!;
        p0[2] = e[2]! * a + e[6]! * b + e[10]! * c + e[14]!;
        const w = f.hug(skin.hh[i]!);
        if (w > 0.001) {
          let x = 0;
          let y = 0;
          let z = 0;
          for (let k = 0; k < 4; k++) {
            const g = skin.g0[i * 4 + k]! * 3;
            const gw = skin.gw[i * 4 + k]!;
            x += G[g]! * gw;
            y += G[g + 1]! * gw;
            z += G[g + 2]! * gw;
          }
          p0[0] += (x - p0[0]!) * w;
          p0[1] += (y - p0[1]!) * w;
          p0[2] += (z - p0[2]!) * w;
          hugAny = Math.max(hugAny, w);
        }
        if (wet) {
          // waves run down the water while it is in flight, a gentle ripple once it hugs her; calm at the floor
          const th = skin.th[i]!;
          const amp =
            (4 * w * (1 - w) + 0.3 * f.plain) *
            Math.min(1, Math.max(0, (p0[1]! - body.U.uFloor!.value) / 0.12));
          const d =
            amp *
            (0.028 * Math.sin(15 * p0[1]! - 9 * t + 3 * th) +
              0.012 * Math.sin(33 * p0[1]! + 5 * th - 14 * t));
          const cx = Math.cos(th);
          const cz = Math.sin(th);
          p0[0] += (e[0]! * cx + e[8]! * cz) * d;
          p0[2] += (e[2]! * cx + e[10]! * cz) * d;
        }
        arr[i * 3] = p0[0]!;
        arr[i * 3 + 1] = p0[1]!;
        arr[i * 3 + 2] = p0[2]!;
        top = Math.max(top, p0[1]!);
        bot = Math.min(bot, p0[1]!);
      }
      pos.needsUpdate = true;
      if (wet) skin.mesh.geometry.computeVertexNormals();
      const lvl = top + 0.12 - (top - bot + 0.3) * f.wipe; // her surface resolves from the crown down
      skin.U.uPlainAmt!.value = f.plain;
      skin.U.uLevel!.value = lvl;
      skin.U.uWtr!.value = wet ? 1 : 0;
      skin.U.uWT!.value = t;
      skin.mesh.visible = f.wipe < 0.999;
      // the skin material blends only in water (see-through); the original look stays opaque and cheap
      (skin.mesh.material as THREE.ShaderMaterial).transparent = wet;
      body.U.uLevel!.value = f.wipe > 1e-3 ? lvl : 10;
      body.U.uLegs!.value = hugAny > 0.001 ? bot - 0.005 : -10;
      body.U.uPP!.value = f.pp;
      body.U.uWtr!.value = wet ? 1 : 0;
      body.U.uWT!.value = t;
      if (f.wipe <= 1e-3 && hugAny <= 0.001) bodyRoot.visible = false;
      if (skin.parts) placeParts(skin.parts, e, 1 - f.plain);
      // the hands melt into her shoulders as the drawing goes plain, and grow back out of them
      skin.hands?.place(run.loaf, 1 - f.plain);
      const fc = skin.face;
      if (fc) {
        // the drawn face rides the forming skin and fades as the drawing goes plain (a face travelling up into hers
        // read as tiny eyes riding a pole: Director 28 Nov)
        const fp = fc.mesh.geometry.attributes.position as THREE.BufferAttribute;
        const fa = fp.array as Float32Array;
        const lift = wet ? 0.03 : 0.006;
        const fx = e[8]!;
        const fy = e[9]!;
        const fz = e[10]!;
        const fl = Math.hypot(fx, fy, fz) || 1;
        fc.vs.forEach((v, j) => {
          fa[j * 3] = arr[v * 3]! + (fx / fl) * lift;
          fa[j * 3 + 1] = arr[v * 3 + 1]! + (fy / fl) * lift;
          fa[j * 3 + 2] = arr[v * 3 + 2]! + (fz / fl) * lift;
        });
        fp.needsUpdate = true;
        fc.mesh.material.uniforms.uFade!.value = f.face;
        fc.mesh.visible = f.face > 0.001;
      }
      return true;
    },
    dispose: () => {
      skin.mesh.removeFromParent();
      skin.face?.mesh.removeFromParent();
      skin.parts?.mesh.removeFromParent();
      skin.mesh.geometry.dispose();
      (skin.mesh.material as THREE.Material).dispose();
      skin.face?.mesh.geometry.dispose();
      skin.face?.mesh.material.dispose();
      skin.hands?.dispose();
    },
  };
}

export interface FormSwap {
  /** Starts a change from the first form to the second ("to": "second"), or back ("to": "first"). */
  readonly start: (to: "first" | "second", look: MorphLook) => void;
  /** Draws the change `now` (ms); false once it has finished. */
  readonly frame: (now: number) => boolean;
  readonly active: () => boolean;
  readonly dispose: () => void;
}

/**
 * One form to another through her plain skin (M2M: her body and an animal): the skin closes over the form she leaves,
 * reshapes into the one she takes, and lets its colours through. The skin is the cartoon's, kept plain; no face, parts
 * or hands ride it.
 */
export function createFormSwap(
  scene: THREE.Object3D,
  skin: CartoonSkin,
  first: { readonly form: BodyForm; readonly root: THREE.Object3D },
  second: { readonly form: BodyForm; readonly root: THREE.Object3D },
): FormSwap {
  scene.add(skin.mesh);
  const pos = skin.mesh.geometry.attributes.position as THREE.BufferAttribute;
  let run: { from: typeof first; to: typeof first; look: MorphLook; t0: number | null } | null =
    null;
  const rest = (b: BodyForm) => {
    b.U.uLevel!.value = -10;
    b.U.uLegs!.value = -10;
    b.U.uPP!.value = 1;
    b.U.uWtr!.value = 0;
  };
  return {
    start: (to, look) => {
      const [from, into] = to === "second" ? [first, second] : [second, first];
      run = { from, to: into, look, t0: null };
    },
    active: () => run !== null,
    frame: (now) => {
      if (run === null) return false;
      run.t0 ??= now;
      const t = (now - run.t0) / 1000;
      const { from, to, look } = run;
      const covering = t < swapSeconds("cover");
      const half = covering ? "cover" : "reveal";
      const f = swapAt(
        half,
        covering ? t : Math.min(t - swapSeconds("cover"), swapSeconds("reveal")),
        look,
      );
      if (!covering && f.done) {
        rest(to.form);
        to.root.visible = true;
        from.root.visible = false;
        skin.mesh.visible = false;
        run = null;
        return false;
      }
      const wet = look === "water";
      // cover: the skin holds the form she leaves; reveal: it moves from that form onto the one she takes
      const M = covering ? from : to;
      M.root.visible = true;
      M.root.updateMatrixWorld(true);
      if (!covering) from.root.updateMatrixWorld(true);
      trackGrid(from.form);
      if (!covering) trackGrid(to.form);
      if (!covering) from.root.visible = false;
      const A = from.form.pos;
      const B = to.form.pos;
      const arr = pos.array as Float32Array;
      let top = -1e9;
      let bot = 1e9;
      for (let i = 0; i < skin.n; i++) {
        let x = 0;
        let y = 0;
        let z = 0;
        let bx = 0;
        let by = 0;
        let bz = 0;
        const w = f.hug(skin.hh[i]!);
        for (let k = 0; k < 4; k++) {
          const g = skin.g0[i * 4 + k]! * 3;
          const gw = skin.gw[i * 4 + k]!;
          x += A[g]! * gw;
          y += A[g + 1]! * gw;
          z += A[g + 2]! * gw;
          if (w > 0.001) {
            bx += B[g]! * gw;
            by += B[g + 1]! * gw;
            bz += B[g + 2]! * gw;
          }
        }
        if (w > 0.001) {
          x += (bx - x) * w;
          y += (by - y) * w;
          z += (bz - z) * w;
        }
        if (wet) {
          const th = skin.th[i]!;
          const d = (4 * w * (1 - w) + 0.3) * 0.02 * Math.sin(15 * y - 9 * t + 3 * th);
          x += Math.cos(th) * d;
          z += Math.sin(th) * d;
        }
        arr[i * 3] = x;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = z;
        top = Math.max(top, y);
        bot = Math.min(bot, y);
      }
      pos.needsUpdate = true;
      if (wet) skin.mesh.geometry.computeVertexNormals();
      const lvl = top + 0.12 - (top - bot + 0.3) * f.wipe;
      skin.U.uPlainAmt!.value = 1;
      skin.U.uLevel!.value = lvl;
      skin.U.uWtr!.value = wet ? 1 : 0;
      skin.U.uWT!.value = t;
      skin.mesh.visible = f.wipe < 0.999;
      (skin.mesh.material as THREE.ShaderMaterial).transparent = wet;
      M.form.U.uLevel!.value = f.wipe > 1e-3 ? lvl : 10;
      M.form.U.uLegs!.value = -10;
      M.form.U.uPP!.value = f.pp;
      M.form.U.uWtr!.value = wet ? 1 : 0;
      M.form.U.uWT!.value = t;
      if (f.wipe <= 1e-3) M.root.visible = !covering;
      return true;
    },
    dispose: () => {
      skin.mesh.removeFromParent();
      skin.mesh.geometry.dispose();
      (skin.mesh.material as THREE.ShaderMaterial).dispose();
    },
  };
}
