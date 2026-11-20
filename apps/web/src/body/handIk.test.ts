import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { meetPalms, palmWorld, reach, type Arm } from "./handIk.ts";

/** A body's two arms off a chest, longer than the reference body's, with the arms hanging forward and apart. */
const body = () => {
  const chest = new THREE.Object3D();
  chest.position.set(0, 1.3, 0);
  chest.rotation.y = 0.4;
  const arm = (s: 1 | -1): Arm => {
    const upper = new THREE.Object3D();
    const lower = new THREE.Object3D();
    const end = new THREE.Object3D();
    chest.add(upper);
    upper.add(lower);
    lower.add(end);
    upper.position.set(0.19 * s, 0.05, 0);
    lower.position.set(0.29 * s, 0, 0);
    end.position.set(0.26 * s, 0, 0);
    // hanging down and a little forward, the elbow bent
    upper.rotation.set(0.3, 0, -1.2 * s);
    lower.rotation.set(0, -0.9 * s, 0);
    return {
      upper,
      lower,
      end,
      palm: { at: new THREE.Vector3(0.08 * s, -0.02, 0), normal: new THREE.Vector3(0, -1, 0) },
    };
  };
  const left = arm(1);
  const right = arm(-1);
  chest.updateMatrixWorld(true);
  return { left, right };
};
const palm = (a: Arm) => {
  const at = new THREE.Vector3();
  const n = new THREE.Vector3();
  palmWorld(a, at, n);
  return { at, n };
};

describe("hand IK", () => {
  it("reaches a point with the hand and holds the hand's world turn", () => {
    const { left } = body();
    const target = new THREE.Vector3(0.1, 1.15, 0.3);
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1, -0.4));
    reach(left, target, turn);
    expect(left.end.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-4);
    expect(left.end.getWorldQuaternion(new THREE.Quaternion()).angleTo(turn)).toBeLessThan(1e-4);
  });

  it("brings palms authored apart onto each other: centre on centre at the gap, facing", () => {
    const { left, right } = body();
    expect(palm(left).at.distanceTo(palm(right).at)).toBeGreaterThan(0.15);
    const d = meetPalms(left, right, 0.004, 1, 0);
    expect(d).toBeCloseTo(0.004, 3);
    expect(-palm(left).n.dot(palm(right).n)).toBeGreaterThan(0.999);
  });

  it("leaves the pose alone at weight 0, and moves part way between", () => {
    const { left, right } = body();
    const before = palm(left).at.distanceTo(palm(right).at);
    expect(meetPalms(left, right, 0.004, 0, 0)).toBeCloseTo(before, 6);
    const half = meetPalms(left, right, 0.004, 0.5, 0);
    expect(half).toBeLessThan(before);
    expect(half).toBeGreaterThan(0.01);
  });
});
