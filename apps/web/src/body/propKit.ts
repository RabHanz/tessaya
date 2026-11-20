/**
 * What her body's own props (hats.ts, heldProps.ts) are made of: surfaces swept from a function, and her own MToon
 * material in a prop's colours, so a prop is lit and outlined like the rest of her.
 */
import type { MToonMaterial, VRM } from "@pixiv/three-vrm";
import * as THREE from "three";

export type V3 = readonly [number, number, number];

/** The bones her own props go on. */
export type PropBone = "head" | "leftHand" | "rightHand";

/**
 * Each prop bone's turn at rest in her model, inverted. Read when the model loads, before she moves: a prop rides her
 * raw bone (the one her skin follows), since her normalized rig is mirrored around the update on some models.
 */
export const restTurns = (vrm: VRM): ReadonlyMap<PropBone, THREE.Quaternion> => {
  vrm.scene.updateMatrixWorld(true);
  const model = vrm.scene.getWorldQuaternion(new THREE.Quaternion()).invert();
  return new Map(
    (["head", "leftHand", "rightHand"] as const).flatMap((b) => {
      const n = vrm.humanoid.getRawBoneNode(b);
      return n === null
        ? []
        : [
            [
              b,
              model.clone().multiply(n.getWorldQuaternion(new THREE.Quaternion())).invert(),
            ] as const,
          ];
    }),
  );
};

/** A frame riding her own bone, in her model's axes as they were at rest: what a prop is built in. */
export const frameOn = (
  vrm: VRM,
  bone: PropBone,
  turns: ReadonlyMap<PropBone, THREE.Quaternion>,
) => {
  const raw = vrm.humanoid.getRawBoneNode(bone);
  const turn = turns.get(bone);
  if (raw === null || turn === undefined) return null;
  const frame = new THREE.Group();
  frame.name = `prop-frame:${bone}`;
  frame.quaternion.copy(turn);
  raw.add(frame);
  return frame;
};

/**
 * A surface swept around her head: `nu` steps round (u, closed), `nv` rows along (v), closed in v too for a solid
 * band. `paint` picks which of two materials each quad takes, `tone` how much light each point gets.
 */
export const sheet = (
  nu: number,
  nv: number,
  at: (u: number, v: number) => V3,
  closedV = false,
  paint?: (u: number, v: number) => 0 | 1,
  tone?: (u: number, v: number) => number,
) => {
  const pos = new Float32Array(nu * nv * 3);
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++)
      pos.set(at(i / nu, closedV ? j / nv : j / (nv - 1)), (j * nu + i) * 3);
  const tris: [number[], number[]] = [[], []];
  for (let j = 0; j < (closedV ? nv : nv - 1); j++)
    for (let i = 0; i < nu; i++) {
      const a = j * nu + i;
      const b = j * nu + ((i + 1) % nu);
      const c = ((j + 1) % nv) * nu + i;
      const d = ((j + 1) % nv) * nu + ((i + 1) % nu);
      tris[paint?.((i + 0.5) / nu, (j + 0.5) / nv) ?? 0].push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  // light the cloth takes where it is tucked or folded (her own textures paint this; a plain colour needs it given)
  if (tone !== undefined) {
    const col = new Float32Array(nu * nv * 3);
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++)
        col.fill(
          tone(i / nu, closedV ? j / nv : j / (nv - 1)),
          (j * nu + i) * 3,
          (j * nu + i) * 3 + 3,
        );
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }
  g.setIndex([...tris[0], ...tris[1]]);
  g.addGroup(0, tris[0].length, 0);
  if (tris[1].length > 0) g.addGroup(tris[0].length, tris[1].length, 1);
  g.computeVertexNormals();
  return g;
};

/** A soft ball (a pompom), lumpy so it reads as yarn, not a sphere. */
export const ball = (c: V3, r: number, lumps = 0.12) =>
  sheet(24, 14, (u, v) => {
    const a = u * Math.PI * 2;
    const b = v * Math.PI;
    const k = r * (1 + lumps * Math.sin(a * 7) * Math.sin(b * 6));
    return [
      c[0] + k * Math.sin(b) * Math.sin(a),
      c[1] - k * Math.cos(b),
      c[2] + k * Math.sin(b) * Math.cos(a),
    ];
  });
/** Her own look: her clothes' MToon material (and its outline), or a plain toon one for a model without MToon. */
export interface Look {
  readonly surface: MToonMaterial | null;
  readonly outline: MToonMaterial | null;
}

export const lookOf = (vrm: VRM): Look => {
  const found: Array<{ surface: MToonMaterial; outline: MToonMaterial | null }> = [];
  vrm.scene.traverse((o) => {
    const mats = (o as THREE.Mesh).isMesh ? [(o as THREE.Mesh).material].flat() : [];
    const surface = mats.find(
      (m): m is MToonMaterial =>
        (m as MToonMaterial).isMToonMaterial === true && !(m as MToonMaterial).isOutline,
    );
    if (surface)
      found.push({
        surface,
        outline:
          (mats.find((m) => (m as MToonMaterial).isOutline === true) as MToonMaterial) ?? null,
      });
  });
  const pick =
    found.find((m) => /cloth/i.test(m.surface.name)) ??
    found.find((m) => !/face|eye|skin|hair|mouth|brow/i.test(m.surface.name)) ??
    found[0];
  return { surface: pick?.surface ?? null, outline: pick?.outline ?? null };
};

/** Her material in a hat's colour: her lighting, toon ramp and outline, none of her textures (nothing shared). */
const dress = (look: Look, hex: string): THREE.Material[] => {
  const color = new THREE.Color(hex);
  if (look.surface === null) return [new THREE.MeshToonMaterial({ color })];
  const own = (m: MToonMaterial) => {
    const c = m.clone();
    c.map = c.shadeMultiplyTexture = c.normalMap = c.emissiveMap = null;
    c.shadingShiftTexture = c.rimMultiplyTexture = c.matcapTexture = null;
    c.outlineWidthMultiplyTexture = c.uvAnimationMaskTexture = null;
    c.color.copy(color);
    // her clothes paint their shading into the texture; a plain colour shades on its own ramp, a cooler deeper tone
    c.shadeColorFactor.copy(color).multiply(new THREE.Color(0.58, 0.52, 0.7));
    c.shadingShiftFactor = 0.1;
    c.shadingToonyFactor = Math.max(c.shadingToonyFactor, 0.8);
    c.matcapFactor.setRGB(0, 0, 0);
    c.emissive.setRGB(0, 0, 0);
    c.outlineColorFactor.copy(color).multiplyScalar(0.35);
    c.needsUpdate = true;
    return c;
  };
  const surface = own(look.surface);
  // the cloth is seen from inside too (under a brim, inside a crown); the outline stays a back-face shell
  surface.side = THREE.DoubleSide;
  return look.outline === null ? [surface] : [surface, own(look.outline)];
};

/** One part of a prop: its shape in one or two colours, each outlined like her. */
export const part = (look: Look, g: THREE.BufferGeometry, hex: string, hex2?: string) => {
  const one = dress(look, hex);
  const two = hex2 === undefined ? [] : dress(look, hex2);
  const surfaces = [one[0]!, ...(two[0] ? [two[0]] : [])];
  const outline = one[1];
  const count = g.getIndex()?.count ?? g.getAttribute("position").count;
  if (g.groups.length === 0) g.addGroup(0, count, 0);
  if (g.getAttribute("color") !== undefined)
    for (const m of surfaces) {
      m.vertexColors = true;
      if ((m as MToonMaterial).isMToonMaterial) (m as MToonMaterial).ignoreVertexColor = false;
    }
  if (outline !== undefined) g.addGroup(0, count, surfaces.length);
  for (const m of two.slice(1)) m.dispose();
  return new THREE.Mesh(g, outline === undefined ? surfaces : [...surfaces, outline]);
};
