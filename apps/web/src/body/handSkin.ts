/**
 * Her hands' real skin, as drawn: each hand's skinned vertices (the palm alone, and the palm with the fingers) and
 * their triangles under a bounding volume tree (three-mesh-bvh), refitted only on frames that ask. What a contact is
 * measured on, so "the hands touched" is the skin touching, not points guessed from the bones.
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

interface Patch {
  /** Each vertex as (mesh, index into that mesh). */
  readonly meshes: ReadonlyArray<THREE.SkinnedMesh>;
  readonly of: Uint16Array;
  readonly index: Uint32Array;
  readonly pos: Float32Array;
  readonly geometry: THREE.BufferGeometry;
  readonly bvh: MeshBVH;
  /** Per triangle, +1 or -1: its winding turned so its normal points out of the hand (models wind either way). */
  readonly out: Int8Array;
  /** Per triangle, 1 when it lies on the patch's open edge (where it joins the next part): nothing is inside there. */
  readonly rim: Uint8Array;
}
export interface HandSkin {
  readonly palm: Patch;
  readonly whole: Patch;
  /** Skin per vertex (m²), from the palm's own triangles: how much a vertex in contact stands for. */
  readonly vertexArea: number;
}

const v = new THREE.Vector3();
const patchOf = (
  meshes: ReadonlyArray<THREE.SkinnedMesh>,
  keep: (mesh: THREE.SkinnedMesh, bone: THREE.Bone) => boolean,
): Patch | null => {
  const of: number[] = [];
  const index: number[] = [];
  const tris: number[] = [];
  for (const [m, mesh] of meshes.entries()) {
    const si = mesh.geometry.getAttribute("skinIndex");
    const sw = mesh.geometry.getAttribute("skinWeight");
    if (!si || !sw) continue;
    const local = new Map<number, number>();
    for (let i = 0; i < si.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      const bone = mesh.skeleton.bones[si.getComponent(i, best)];
      if (bone === undefined || !keep(mesh, bone)) continue;
      local.set(i, of.length);
      of.push(m);
      index.push(i);
    }
    const idx = mesh.geometry.getIndex();
    const n = idx ? idx.count : si.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = local.get(idx ? idx.getX(t) : t);
      const b = local.get(idx ? idx.getX(t + 1) : t + 1);
      const c = local.get(idx ? idx.getX(t + 2) : t + 2);
      if (a !== undefined && b !== undefined && c !== undefined) tris.push(a, b, c);
    }
  }
  if (tris.length === 0) return null;
  const pos = new Float32Array(of.length * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(tris);
  const p = { meshes, of: Uint16Array.from(of), index: Uint32Array.from(index), pos, geometry };
  update(p);
  // the tree reorders the triangles: build it first, then read them in its order
  const bvh = new MeshBVH(geometry);
  const idx = geometry.getIndex()!;
  // out is the way the mesh's own normals point (at rest, as loaded): models wind their triangles either way
  const out = new Int8Array(idx.count / 3);
  const t = new THREE.Triangle();
  const n = new THREE.Vector3();
  const vn = new THREE.Vector3();
  const sum = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (let f = 0; f < out.length; f++) {
    t.setFromAttributeAndIndices(
      geometry.getAttribute("position"),
      idx.getX(f * 3),
      idx.getX(f * 3 + 1),
      idx.getX(f * 3 + 2),
    );
    t.getNormal(n);
    sum.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const vi = idx.getX(f * 3 + k);
      const mesh = meshes[p.of[vi]!]!;
      const normal = mesh.geometry.getAttribute("normal");
      if (!normal) continue;
      sum.add(
        vn
          .fromBufferAttribute(normal, p.index[vi]!)
          .applyMatrix3(nm.getNormalMatrix(mesh.matrixWorld)),
      );
    }
    out[f] = sum.lengthSq() === 0 || n.dot(sum) >= 0 ? 1 : -1;
  }
  // the open edge: edges only one triangle uses, by position (a mesh splits vertices along its UV seams)
  const key = (vi: number) =>
    `${Math.round(pos[vi * 3]! * 1e4)},${Math.round(pos[vi * 3 + 1]! * 1e4)},${Math.round(pos[vi * 3 + 2]! * 1e4)}`;
  const edges = new Map<string, number>();
  const edgeOf = (a: number, b: number) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (let f = 0; f < out.length; f++)
    for (let k = 0; k < 3; k++) {
      const e = edgeOf(idx.getX(f * 3 + k), idx.getX(f * 3 + ((k + 1) % 3)));
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  const rim = new Uint8Array(out.length);
  for (let f = 0; f < out.length; f++)
    for (let k = 0; k < 3; k++)
      if (edges.get(edgeOf(idx.getX(f * 3 + k), idx.getX(f * 3 + ((k + 1) % 3)))) === 1) rim[f] = 1;
  return { ...p, bvh, out, rim };
};
const update = (p: Omit<Patch, "bvh" | "out" | "rim">) => {
  for (let i = 0; i < p.index.length; i++) {
    const mesh = p.meshes[p.of[i]!]!;
    mesh.getVertexPosition(p.index[i]!, v).applyMatrix4(mesh.matrixWorld);
    p.pos[i * 3] = v.x;
    p.pos[i * 3 + 1] = v.y;
    p.pos[i * 3 + 2] = v.z;
  }
  p.geometry.getAttribute("position").needsUpdate = true;
};

/** Each hand's skin on a model: `hand(bone)` says which side a bone is (its hand or fingers), `palm(bone)` its palm. */
export const handSkinsOf = (
  root: THREE.Object3D,
  side: (bone: THREE.Object3D) => "left" | "right" | null,
  palm: (bone: THREE.Object3D) => boolean,
): { readonly left: HandSkin; readonly right: HandSkin } | null => {
  const meshes: THREE.SkinnedMesh[] = [];
  root.updateMatrixWorld(true);
  // her skin is the mesh her fingers move: a sleeve's cuff is weighted to the hand too, but never to a finger
  const fingered = (m: THREE.SkinnedMesh) => {
    const si = m.geometry.getAttribute("skinIndex");
    const sw = m.geometry.getAttribute("skinWeight");
    if (!si || !sw) return false;
    for (let i = 0; i < si.count; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      const bone = m.skeleton.bones[si.getComponent(i, best)];
      if (bone !== undefined && side(bone) !== null && !palm(bone)) return true;
    }
    return false;
  };
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && fingered(o as THREE.SkinnedMesh))
      meshes.push(o as THREE.SkinnedMesh);
  });
  const one = (s: "left" | "right"): HandSkin | null => {
    const p = patchOf(meshes, (_, b) => side(b) === s && palm(b));
    const w = patchOf(meshes, (_, b) => side(b) === s);
    if (p === null || w === null) return null;
    let area = 0;
    const idx = p.geometry.getIndex()!;
    const tri = new THREE.Triangle();
    for (let t = 0; t < idx.count; t += 3) {
      tri.setFromAttributeAndIndices(
        p.geometry.getAttribute("position"),
        idx.getX(t),
        idx.getX(t + 1),
        idx.getX(t + 2),
      );
      area += tri.getArea();
    }
    return { palm: p, whole: w, vertexArea: area / Math.max(1, p.index.length) };
  };
  const left = one("left");
  const right = one("right");
  return left && right ? { left, right } : null;
};

const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const INSIDE_MAX = 0.08;
/** A hand is about this thick: nothing is deeper inside one than that. */
const HAND_THICK = 0.025;
const tri = new THREE.Triangle();
const n = new THREE.Vector3();
const d = new THREE.Vector3();
const deepN = new THREE.Vector3();
/**
 * How close one hand's skin comes to the other's: the least signed distance from `a`'s vertices to `b`'s surface
 * (negative: that deep inside it), and how many of `a`'s vertices are within `touching` of it (m).
 */
const signed = (a: Patch, b: Patch, touching: number, deepest = INSIDE_MAX) => {
  let least = Infinity;
  let at = -1;
  let near = 0;
  const idx = b.geometry.getIndex()!;
  const pos = b.geometry.getAttribute("position");
  for (let i = 0; i < a.index.length; i++) {
    v.fromArray(a.pos, i * 3);
    if (b.bvh.closestPointToPoint(v, hit) === null) continue;
    const f = hit.faceIndex * 3;
    tri.setFromAttributeAndIndices(pos, idx.getX(f), idx.getX(f + 1), idx.getX(f + 2));
    tri.getNormal(n).multiplyScalar(b.out[hit.faceIndex]!);
    // a point nearest the patch's open edge (where it joins the next part) is outside it, whichever way that face
    // turns; and nothing of one part is deeper than 8 cm inside another
    const s =
      hit.distance < deepest && b.rim[hit.faceIndex] === 0 && d.subVectors(v, hit.point).dot(n) < 0
        ? -hit.distance
        : hit.distance;
    if (s < least) {
      least = s;
      at = i;
      deepN.copy(n);
    }
    if (s < touching) near++;
  }
  return { least, near, at };
};

/**
 * Where the two hands' skin is now (after their bones moved): the palms' gap (least signed distance either way, m;
 * negative is overlap), how deep any part of either hand (fingers too) is inside the other, and the skin in contact
 * (m², palm vertices within 1 mm of the other palm).
 */
export const skinBetween = (left: HandSkin, right: HandSkin) => {
  for (const s of [left, right]) {
    update(s.palm);
    s.palm.bvh.refit();
  }
  for (const s of [left, right]) {
    update(s.whole);
    s.whole.bvh.refit();
  }
  // each palm against the other whole hand: a palm alone is open where the fingers join, and a point near that rim
  // can read as inside it from the wrong side
  const lr = signed(left.palm, right.whole, 0.001, HAND_THICK);
  const rl = signed(right.palm, left.whole, 0.001, HAND_THICK);
  return {
    gap: Math.min(lr.least, rl.least),
    area: ((lr.near + rl.near) / 2) * ((left.vertexArea + right.vertexArea) / 2),
  };
};
/** The deepest any part of either hand (palm or fingers) is inside the other (m, 0 when none): a slower, full read. */
export const skinOverlap = (left: HandSkin, right: HandSkin) => {
  for (const s of [left, right]) {
    update(s.whole);
    s.whole.bvh.refit();
  }
  const a = signed(left.whole, right.whole, 0, HAND_THICK);
  const b = signed(right.whole, left.whole, 0, HAND_THICK);
  const [deep, from] = a.least <= b.least ? [a, left.whole] : [b, right.whole];
  return { depth: Math.max(0, -deep.least), part: deep.least < 0 ? partOf(from, deep.at) : null };
};
/** The bone that moves a patch's vertex most: which part of a hand a reading came from. */
const partOf = (p: Patch, i: number) => {
  const mesh = p.meshes[p.of[i]!]!;
  const si = mesh.geometry.getAttribute("skinIndex");
  const sw = mesh.geometry.getAttribute("skinWeight");
  let best = 0;
  for (let k = 1; k < 4; k++)
    if (sw.getComponent(p.index[i]!, k) > sw.getComponent(p.index[i]!, best)) best = k;
  return mesh.skeleton.bones[si.getComponent(p.index[i]!, best)] ?? null;
};

/** Every part of her drawn skin by group (`groupOf` names a vertex's bone's group; null leaves it out, e.g. hair). */
export const bodySkinOf = (
  root: THREE.Object3D,
  groupOf: (bone: THREE.Object3D, mesh: THREE.SkinnedMesh) => string | null,
): ReadonlyMap<string, Patch> => {
  const meshes: THREE.SkinnedMesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  const names = new Set<string>();
  for (const m of meshes)
    for (const b of m.skeleton.bones) {
      const g = groupOf(b, m);
      if (g !== null) names.add(g);
    }
  const out = new Map<string, Patch>();
  for (const g of names) {
    const p = patchOf(meshes, (m, b) => groupOf(b, m) === g);
    if (p !== null) out.set(g, p);
  }
  return out;
};
export type SkinPatch = Patch;
/** A patch read again where its bones are now. */
export const refresh = (p: Patch) => {
  update(p);
  p.bvh.refit();
};
/**
 * How deep `a`'s skin (its vertices, as last refreshed) is inside `b`'s (m, 0 when not), and the way out: `b`'s
 * outward normal where it is deepest (world, into `normal`).
 */
export const deepestIn = (
  a: Patch,
  b: Patch,
  normal: THREE.Vector3,
  /** No part is deeper inside than it is thick: a reading past this is a thin sheet (cloth) seen from behind. */
  thickness = INSIDE_MAX,
  /** Set to the bone of `a` whose skin is deepest in (null when none is inside). */
  part?: { bone: THREE.Object3D | null },
): number => {
  const r = signed(a, b, 0, thickness);
  if (part !== undefined) part.bone = r.least < 0 ? partOf(a, r.at) : null;
  if (r.least >= 0) return 0;
  normal.copy(deepN).normalize();
  return -r.least;
};
/** A hand's whole skin (palm and fingers), for checks against the rest of her. */
export const handPatch = (h: HandSkin) => h.whole;
