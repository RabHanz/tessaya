import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { handSkinsOf, skinBetween } from "./handSkin.ts";

/**
 * Two "hands" facing each other across x: each a 2 cm thick box (palm part) with a finger box beyond it, skinned to
 * its own hand and finger bones. `gap` is the distance between their facing sides (negative: overlapping).
 */
const hands = (gap: number) => {
  const root = new THREE.Group();
  const bones: THREE.Bone[] = [];
  const part = (x: number, bone: THREE.Bone, y: number) => {
    const g = new THREE.BoxGeometry(0.02, 0.08, 0.08, 2, 4, 4).toNonIndexed();
    const n = g.getAttribute("position").count;
    g.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute(
        new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? bones.indexOf(bone) : 0)),
        4,
      ),
    );
    g.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute(
        new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)),
        4,
      ),
    );
    g.translate(x, y, 0);
    return g;
  };
  const mk = (name: string) => {
    const b = new THREE.Bone();
    b.name = name;
    bones.push(b);
    root.add(b);
    return b;
  };
  const lh = mk("leftHand");
  const lf = mk("leftIndex");
  const rh = mk("rightHand");
  const rf = mk("rightIndex");
  const x = 0.01 + gap / 2;
  const geo = [part(-x, lh, 0), part(-x, lf, 0.09), part(x, rh, 0), part(x, rf, 0.09)];
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [];
  const si: number[] = [];
  const sw: number[] = [];
  for (const g of geo) {
    pos.push(...g.getAttribute("position").array);
    si.push(...g.getAttribute("skinIndex").array);
    sw.push(...g.getAttribute("skinWeight").array);
  }
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  merged.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  merged.setIndex(Array.from({ length: pos.length / 3 }, (_, i) => i));
  const mesh = new THREE.SkinnedMesh(merged, new THREE.MeshBasicMaterial());
  mesh.bind(new THREE.Skeleton(bones));
  root.add(mesh);
  root.updateMatrixWorld(true);
  const side = (b: THREE.Object3D) =>
    (b.name.startsWith("left") ? "left" : "right") as "left" | "right";
  return handSkinsOf(root, side, (b) => b.name.endsWith("Hand"))!;
};

describe("hand skin", () => {
  it.each([0.01, 0.002, 0, -0.004])("reads the palms' real gap (%s m)", (gap) => {
    const h = hands(gap);
    expect(skinBetween(h.left, h.right).gap).toBeCloseTo(gap, 4);
  });

  it("counts the skin in contact only when the palms touch", () => {
    expect(skinBetween(hands(0.01).left, hands(0.01).right).area).toBe(0);
    const h = hands(0.0002);
    expect(skinBetween(h.left, h.right).area).toBeGreaterThan(0);
  });
});
