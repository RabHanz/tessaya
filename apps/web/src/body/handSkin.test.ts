import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { bodySkinOf, deepestIn, handSkinsOf, skinBetween } from "./handSkin.ts";

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

describe("a hand against the rest of her", () => {
  /** A 10 cm "head" box at the origin and a 2 cm "hand" box whose near face is `gap` from the head's right side. */
  const scene = (gap: number) => {
    const root = new THREE.Group();
    const head = new THREE.Bone();
    head.name = "head";
    const hand = new THREE.Bone();
    hand.name = "rightHand";
    root.add(head, hand);
    const box = (size: number, x: number, bone: number) => {
      const g = new THREE.BoxGeometry(size, size, size, 3, 3, 3).toNonIndexed();
      g.translate(x, 0, 0);
      const n = g.getAttribute("position").count;
      g.setAttribute(
        "skinIndex",
        new THREE.Uint16BufferAttribute(
          new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? bone : 0)),
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
      g.setIndex(Array.from({ length: n }, (_, i) => i));
      const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
      m.bind(new THREE.Skeleton([head, hand]));
      root.add(m);
    };
    box(0.1, 0, 0);
    box(0.02, 0.05 + gap + 0.01, 1);
    root.updateMatrixWorld(true);
    const parts = bodySkinOf(root, (b) =>
      b.name === "head" ? "head" : b.name === "rightHand" ? "hand" : null,
    );
    return { head: parts.get("head")!, hand: parts.get("hand")! };
  };

  it.each([0.01, -0.005, -0.015])(
    "reads how deep a hand is in her (%s m from her surface)",
    (gap) => {
      const { head, hand } = scene(gap);
      const out = new THREE.Vector3();
      const depth = deepestIn(hand, head, out);
      expect(depth).toBeCloseTo(Math.max(0, -gap), 3);
      // and the way out is out of her, toward the hand
      if (depth > 0) expect(out.x).toBeGreaterThan(0.9);
    },
  );
});
