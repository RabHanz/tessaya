import { PROPS } from "@t3tools/tessaya-shared/expressionMap";
import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

import { fitHead, HAT_IDS, hatFor, PRESS } from "./hats.ts";

// a head of hair: an egg 16 cm wide and 19 cm deep, a little forward of the bone, top at 21 cm; eyes at 8 cm
const head = () => {
  const pts: number[] = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 60; j++) {
      const b = (i / 39) * Math.PI;
      const a = (j / 60) * Math.PI * 2;
      pts.push(
        0.08 * Math.sin(b) * Math.sin(a),
        0.11 - 0.1 * Math.cos(b),
        0.01 + 0.095 * Math.sin(b) * Math.cos(a),
      );
    }
  return fitHead(pts, 0.08);
};

const vertices = (o: THREE.Object3D) => {
  const out: THREE.Vector3[] = [];
  o.updateMatrixWorld(true);
  o.traverse((m) => {
    const g = (m as THREE.Mesh).geometry;
    const p = g?.getAttribute("position");
    for (let i = 0; i < (p?.count ?? 0); i++)
      out.push(new THREE.Vector3().fromBufferAttribute(p!, i).applyMatrix4(m.matrixWorld));
  });
  return out;
};

describe("hats made to her head", () => {
  it("read the head's size and middle off her hair", () => {
    const f = head();
    expect(f.top).toBeCloseTo(0.21, 2);
    expect(f.cx).toBeCloseTo(0, 2);
    expect(f.cz).toBeCloseTo(0.01, 2);
    expect(f.rx).toBeCloseTo(0.08, 2);
    expect(f.rz).toBeCloseTo(0.095, 2);
    // the hair reaches its full width low on the skull and none past the top
    expect(f.reach(f.brow + 0.005)).toBeGreaterThan(f.reach(f.top - 0.01));
    expect(f.reach(f.top + 0.01)).toBe(0);
  });

  it("let no hair through a crown, pressing it only as a hat does (most on top), and come down onto her head", () => {
    const f = head();
    for (const id of ["hardhat", "beanie", "nightcap"]) {
      const crown = vertices(hatFor(id, f)!.children[0]!);
      for (const v of crown.filter((p) => p.y > f.brow && p.y < f.top)) {
        expect(Math.hypot((v.x - f.cx) / f.rx, (v.z - f.cz) / f.rz)).toBeGreaterThanOrEqual(
          0.88 * Math.min(f.reach(v.y), PRESS) - 1e-6,
        );
      }
      expect(Math.min(...crown.map((v) => v.y))).toBeLessThan(f.top - 0.4 * (f.top - f.brow));
      expect(Math.max(...crown.map((v) => v.y))).toBeGreaterThan(f.top);
    }
    // a party hat rests on the top of her head and a crown sits down into her hair
    const party = vertices(hatFor("partyhat", f)!);
    expect(Math.min(...party.map((v) => v.y))).toBeGreaterThan(f.top - 0.03);
    const crown = vertices(hatFor("crown", f)!);
    expect(Math.min(...crown.map((v) => v.y))).toBeLessThan(f.top);
  });

  it("are vocabulary props", () => {
    for (const id of HAT_IDS) expect(PROPS).toContain(id);
    expect(hatFor("rocket", head())).toBeNull();
  });
});
