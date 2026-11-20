/**
 * Limb IK on the model's own drawn bones, run after the pose (and its springs) lands: a two-bone reach that puts a hand
 * or foot exactly on a world point, and two palms brought surface to surface. Poses are authored on a reference body;
 * this is what makes contact land on this one. Scratch objects only: nothing is allocated per frame.
 */
import * as THREE from "three";

export interface Limb {
  readonly upper: THREE.Object3D;
  readonly lower: THREE.Object3D;
  readonly end: THREE.Object3D;
}
/** The palm's skin centre and the way it faces, in the hand bone's own frame (measured once, on the model's skin). */
export interface Palm {
  readonly at: THREE.Vector3;
  readonly normal: THREE.Vector3;
}
export interface Arm extends Limb {
  readonly palm: Palm;
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const t = new THREE.Vector3();
const ac = new THREE.Vector3();
const ab = new THREE.Vector3();
const ba = new THREE.Vector3();
const bc = new THREE.Vector3();
const at = new THREE.Vector3();
const axis0 = new THREE.Vector3();
const q = new THREE.Quaternion();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const qr = new THREE.Quaternion();
const qp = new THREE.Quaternion();
const clampDot = (x: number) => Math.max(-1, Math.min(1, x));

/**
 * Turns `limb` so its end reaches `target` (world), the elbow or knee bending in the plane it bends in now (D. Holden's
 * two-joint IK). Out of reach, the limb points straight at it. Then, when `endWorld` is given, the end is turned to
 * that world rotation. World matrices along the limb are current afterwards.
 */
export const reach = (limb: Limb, target: THREE.Vector3, endWorld?: THREE.Quaternion) => {
  limb.upper.parent?.updateWorldMatrix(true, false);
  limb.upper.updateMatrixWorld(true);
  limb.upper.getWorldPosition(a);
  limb.lower.getWorldPosition(b);
  limb.end.getWorldPosition(c);
  const lab = b.distanceTo(a);
  const lcb = c.distanceTo(b);
  const lat = Math.max(
    Math.abs(lab - lcb) + 1e-4,
    Math.min(lab + lcb - 1e-4, target.distanceTo(a)),
  );
  ac.subVectors(c, a).normalize();
  ab.subVectors(b, a).normalize();
  ba.subVectors(a, b).normalize();
  bc.subVectors(c, b).normalize();
  at.subVectors(target, a).normalize();
  const acAb0 = Math.acos(clampDot(ac.dot(ab)));
  const baBc0 = Math.acos(clampDot(ba.dot(bc)));
  const acAb1 = Math.acos(clampDot((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat)));
  const baBc1 = Math.acos(clampDot((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));
  // the bend's own plane; a straight limb has none, so it bends the way the end already sits from the middle joint
  axis0.crossVectors(ac, ab);
  if (axis0.lengthSq() < 1e-10) axis0.crossVectors(ac, bc);
  if (axis0.lengthSq() < 1e-10) axis0.set(1, 0, 0).cross(ac);
  axis0.normalize();
  limb.upper.getWorldQuaternion(qa).invert();
  limb.lower.getWorldQuaternion(qb).invert();
  // first the bend, so the end is as far from the root as the target is (each turn in its bone's own frame) ...
  limb.upper.quaternion.multiply(
    q.setFromAxisAngle(t.copy(axis0).applyQuaternion(qa), acAb1 - acAb0),
  );
  limb.lower.quaternion.multiply(
    q.setFromAxisAngle(t.copy(axis0).applyQuaternion(qb), baBc1 - baBc0),
  );
  limb.upper.updateMatrixWorld(true);
  // ... then the whole limb swung about its root onto the target
  limb.end.getWorldPosition(c);
  ac.subVectors(c, a).normalize();
  q.setFromUnitVectors(ac, at);
  limb.upper.parent!.getWorldQuaternion(qr);
  limb.upper.quaternion.premultiply(qp.copy(qr).invert().multiply(q).multiply(qr));
  if (endWorld !== undefined) {
    limb.upper.updateMatrixWorld(true);
    limb.end.parent!.getWorldQuaternion(q);
    limb.end.quaternion.copy(q.invert().multiply(endWorld));
  }
  limb.upper.updateMatrixWorld(true);
};

/** Where a palm's skin centre is in the world, and the way it faces. */
export const palmWorld = (arm: Arm, at: THREE.Vector3, normal: THREE.Vector3) => {
  at.copy(arm.palm.at).applyMatrix4(arm.end.matrixWorld);
  arm.end.getWorldQuaternion(q);
  normal.copy(arm.palm.normal).applyQuaternion(q).normalize();
};

const pl = new THREE.Vector3();
const pr = new THREE.Vector3();
const nl = new THREE.Vector3();
const nr = new THREE.Vector3();
const mid = new THREE.Vector3();
const across = new THREE.Vector3();
const sep = new THREE.Vector3();
const goal = new THREE.Vector3();
const off = new THREE.Vector3();
const hq = new THREE.Quaternion();
const turn = new THREE.Quaternion();

const meetOne = (
  arm: Arm,
  palm: THREE.Vector3,
  normal: THREE.Vector3,
  face: THREE.Vector3,
  to: THREE.Vector3,
  w: number,
) => {
  // the hand turns its palm to face the other, the least turn there is, and keeps its wrist-to-palm offset as it turns
  arm.end.getWorldQuaternion(hq);
  turn.setFromUnitVectors(normal, face);
  turn.slerp(qr.identity(), 1 - w);
  hq.premultiply(turn);
  arm.end.getWorldPosition(c);
  off.subVectors(palm, c).applyQuaternion(turn);
  goal.lerpVectors(palm, to, w).sub(off);
  reach(arm, goal, hq);
};

/**
 * Brings both palms together until their skin is `gap` apart (m), facing each other across the line between them,
 * by `weight` (0 leaves the pose as it is). `keep` (0..1) keeps that much of their offset along the palms, so a rub's
 * slide survives while a clap's palms land centre on centre. Returns the palm centres' distance after.
 */
export const meetPalms = (
  left: Arm,
  right: Arm,
  gap: number,
  weight: number,
  keep: number,
  /** Where they meet (world); else halfway between where they are. */
  centre?: THREE.Vector3,
): number => {
  const w = Math.max(0, Math.min(1, weight));
  palmWorld(left, pl, nl);
  palmWorld(right, pr, nr);
  if (w > 0) {
    // the line they meet across: the way the palms face each other, or failing that the line between them
    across.subVectors(nl, nr);
    if (across.lengthSq() < 1e-6) across.subVectors(pr, pl);
    across.normalize();
    if (centre === undefined) mid.addVectors(pl, pr).multiplyScalar(0.5);
    else mid.copy(centre);
    sep.subVectors(pr, pl);
    const along = sep.dot(across);
    // what is left of their offset in the palms' plane, kept by `keep`, split between them
    sep.addScaledVector(across, -along).multiplyScalar(0.5 * Math.max(0, Math.min(1, keep)));
    t.copy(mid)
      .addScaledVector(across, -gap / 2)
      .sub(sep);
    meetOne(left, pl, nl, across, t, w);
    t.copy(mid)
      .addScaledVector(across, gap / 2)
      .add(sep);
    meetOne(right, pr, nr, across.negate(), t, w);
    palmWorld(left, pl, nl);
    palmWorld(right, pr, nr);
  }
  return pl.distanceTo(pr);
};

/**
 * The palm, measured on the model at rest (T-pose, palms down): its skin centre is under the middle of the hand,
 * halfway from the wrist to the knuckles, on the lowest skin there. `skin` is the hand's own vertices (world, at rest);
 * without them the palm is taken as a hand's usual thickness under that line.
 */
export const palmOf = (
  hand: THREE.Object3D,
  knuckles: THREE.Vector3 | null,
  skin: ReadonlyArray<readonly [number, number, number]>,
  height: number,
): Palm => {
  hand.updateWorldMatrix(true, false);
  const wrist = hand.getWorldPosition(new THREE.Vector3());
  const centre = knuckles === null ? wrist.clone() : wrist.clone().lerp(knuckles, 0.5);
  const r = Math.max(0.012, 0.3 * (knuckles?.distanceTo(wrist) ?? 0.08 * (height / 1.6)));
  let low = Infinity;
  for (const p of skin)
    if (Math.hypot(p[0] - centre.x, p[2] - centre.z) < r && p[1] < centre.y + 0.01 && p[1] < low)
      low = p[1];
  const at = centre.clone();
  at.y = Number.isFinite(low) && centre.y - low < 0.05 ? low : centre.y - 0.018 * (height / 1.6);
  const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
  return {
    at: hand.worldToLocal(at),
    normal: new THREE.Vector3(0, -1, 0).applyQuaternion(inv).normalize(),
  };
};

const wq = new THREE.Quaternion();
const wa = new THREE.Vector3();
/** Turns a bone by `angle` about a world axis (unit), whatever its parents' turn. */
export const turnWorld = (node: THREE.Object3D, axis: THREE.Vector3, angle: number) => {
  node.parent?.updateWorldMatrix(true, false);
  if (node.parent === null) wq.identity();
  else node.parent.getWorldQuaternion(wq).invert();
  wa.copy(axis).applyQuaternion(wq);
  node.quaternion.premultiply(wq.setFromAxisAngle(wa, angle));
  node.updateMatrixWorld(true);
};
