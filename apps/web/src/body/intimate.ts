/**
 * The intimate expression set on any VRM (M-047): half-lidded, shut, rolled and teary eyes, mouth shapes, blush, sweat
 * and skin sheen, plus breathing, trembling and an arch. Built from what every model has (presets, lookAt, humanoid
 * bones) and small overlays on the head, so a model needs no extra morphs; one that carries a custom expression with a
 * state's name uses its own instead. Anime models (MToon) get drawn marks, others soft realistic ones.
 */
import type { VRM } from "@pixiv/three-vrm";
import type { IntimateState, Motion, States, Weights } from "@t3tools/tessaya-shared/bodyCues";
import * as THREE from "three";

export type Style = "anime" | "realistic";

export const styleOf = (vrm: VRM): Style => {
  let anime = false;
  vrm.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const x of Array.isArray(m) ? m : m ? [m] : [])
      if ((x as { isMToonMaterial?: boolean }).isMToonMaterial) anime = true;
  });
  return anime ? "anime" : "realistic";
};

/** Preset weights a state adds when the model has no custom expression of its own; `breath` is 0..1 of the exhale. */
export const stateWeights = (
  s: States,
  style: Style,
  breath: number,
  own: (name: IntimateState) => boolean,
): Weights => {
  const w = (n: IntimateState) => (own(n) ? 0 : (s[n] ?? 0));
  const k = style === "anime" ? 1 : 0.8;
  return {
    blink: Math.min(
      1,
      w("eyesHalf") * 0.5 * (style === "anime" ? 1.1 : 0.9) + w("eyesShut") + w("eyesRoll") * 0.25,
    ),
    // the panting mouth opens on each exhale
    aa: w("mouthPant") * (0.2 + 0.35 * breath) * k,
    oh: w("mouthO") * 0.8 * k,
    ou: w("mouthO") * 0.2,
    ih: w("mouthBite") * 0.35,
    ee: w("mouthBite") * 0.15,
    sad: w("eyesTeary") * 0.15,
  };
};

/**
 * With the 52 ARKit units ("perfect sync", common on Booth and VRoid models) each state is sculpted from real face
 * shapes: troubled brows, squinted lids, an open panting jaw with flared nostrils, a bitten lower lip, the tongue.
 * Names are matched case-insensitively, since VRM 0.x models spell them `JawOpen`.
 */
export const perfectSyncWeights = (s: States, breath: number): Record<string, number> => {
  const out: Record<string, number> = {};
  const add = (unit: string, w: number) => {
    if (w <= 0) return;
    for (const n of unit.endsWith("_")
      ? [`${unit.slice(0, -1)}Left`, `${unit.slice(0, -1)}Right`]
      : [unit])
      out[n] = Math.min(1, (out[n] ?? 0) + w);
  };
  const g = (n: IntimateState) => s[n] ?? 0;
  add("eyeBlink_", g("eyesHalf") * 0.5 + g("eyesShut") + g("eyesRoll") * 0.1);
  add("eyeSquint_", g("eyesHalf") * 0.3 + g("eyesShut") * 0.6 + g("eyesTeary") * 0.2);
  add("cheekSquint_", g("eyesShut") * 0.35 + g("mouthBite") * 0.2);
  add("browInnerUp", g("browsUp") * 0.9 + g("eyesTeary") * 0.5 + g("eyesHalf") * 0.15);
  // the inner brow lifts while the outer end drops: the troubled look of pleasure, not surprise
  add("browDown_", g("browsUp") * 0.25 + g("eyesShut") * 0.2);
  add("jawOpen", g("mouthPant") * (0.12 + 0.3 * breath) + g("mouthO") * 0.4 + g("tongue") * 0.35);
  add("mouthLowerDown_", g("mouthPant") * 0.25 + g("mouthO") * 0.2 + g("tongue") * 0.3);
  add("mouthUpperUp_", g("mouthPant") * 0.1 + g("mouthBite") * 0.15);
  add("mouthStretch_", g("mouthPant") * 0.1);
  add("mouthFunnel", g("mouthO") * 0.6);
  add("mouthRollLower", g("mouthBite") * 0.7);
  add("mouthSmile_", g("mouthBite") * 0.25);
  add("mouthFrown_", g("eyesTeary") * 0.2);
  add("tongueOut", g("tongue"));
  // nostrils flare on each breath in while she pants
  add("noseSneer_", g("mouthPant") * 0.2 * (1 - breath));
  return out;
};

const paint = (draw: (g: CanvasRenderingContext2D) => void) => {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

const TEXTURES: Record<Style, Record<"blush" | "tear" | "sweat", () => THREE.CanvasTexture>> = {
  anime: {
    blush: () =>
      paint((g) => {
        const r = g.createRadialGradient(64, 64, 4, 64, 64, 60);
        r.addColorStop(0, "rgba(255,110,140,0.85)");
        r.addColorStop(1, "rgba(255,110,140,0)");
        g.fillStyle = r;
        g.fillRect(0, 0, 128, 128);
        // the drawn hatch lines of an anime blush
        g.strokeStyle = "rgba(220,60,100,0.9)";
        g.lineWidth = 5;
        for (const x of [36, 58, 80]) {
          g.beginPath();
          g.moveTo(x + 10, 46);
          g.lineTo(x, 82);
          g.stroke();
        }
      }),
    tear: () =>
      paint((g) => {
        g.fillStyle = "rgba(170,220,255,0.9)";
        g.beginPath();
        g.moveTo(64, 8);
        g.bezierCurveTo(96, 60, 92, 120, 64, 120);
        g.bezierCurveTo(36, 120, 32, 60, 64, 8);
        g.fill();
        g.fillStyle = "rgba(255,255,255,0.95)";
        g.beginPath();
        g.ellipse(56, 84, 7, 14, 0.2, 0, Math.PI * 2);
        g.fill();
      }),
    sweat: () =>
      paint((g) => {
        g.fillStyle = "rgba(150,210,255,0.95)";
        g.strokeStyle = "rgba(60,130,200,0.9)";
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(64, 10);
        g.bezierCurveTo(104, 70, 96, 118, 64, 118);
        g.bezierCurveTo(32, 118, 24, 70, 64, 10);
        g.fill();
        g.stroke();
      }),
  },
  realistic: {
    blush: () =>
      paint((g) => {
        const r = g.createRadialGradient(64, 64, 2, 64, 64, 62);
        r.addColorStop(0, "rgba(225,95,105,0.55)");
        r.addColorStop(1, "rgba(225,95,105,0)");
        g.fillStyle = r;
        g.fillRect(0, 0, 128, 128);
      }),
    tear: () =>
      paint((g) => {
        // a wet track with a bright edge and a bead gathering at its end, readable at phone size
        const l = g.createLinearGradient(0, 0, 0, 128);
        l.addColorStop(0, "rgba(225,238,255,0.95)");
        l.addColorStop(0.85, "rgba(225,238,255,0.55)");
        l.addColorStop(1, "rgba(225,238,255,0)");
        g.strokeStyle = l;
        g.lineWidth = 9;
        g.beginPath();
        g.moveTo(62, 0);
        g.bezierCurveTo(70, 40, 56, 80, 64, 112);
        g.stroke();
        g.strokeStyle = "rgba(255,255,255,0.9)";
        g.lineWidth = 2.5;
        g.stroke();
        g.fillStyle = "rgba(240,248,255,0.95)";
        g.beginPath();
        g.ellipse(64, 112, 6, 8, 0, 0, Math.PI * 2);
        g.fill();
      }),
    sweat: () =>
      paint((g) => {
        g.fillStyle = "rgba(255,255,255,0.8)";
        for (const [x, y, r] of [
          [30, 40, 5],
          [70, 28, 4],
          [96, 60, 5],
          [52, 82, 3],
        ] as const) {
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
        }
      }),
  },
};

/**
 * Overlays on the head for blush, tears and sweat, placed from the eye bones (or the head when a model has none), and a
 * skin sheen through each material's rim or roughness. Drawn only above a faint weight.
 */
export const makeOverlays = (vrm: VRM, style: Style) => {
  const head = vrm.humanoid.getRawBoneNode("head");
  const made: Array<THREE.Mesh> = [];
  const textures = TEXTURES[style];
  const groups: Partial<Record<"blush" | "tear" | "sweat", Array<THREE.Mesh>>> = {};
  if (head) {
    vrm.scene.updateMatrixWorld(true);
    const toHead = head.matrixWorld.clone().invert();
    const eyeAt = (side: "left" | "right") => {
      const eye = vrm.humanoid.getRawBoneNode(side === "left" ? "leftEye" : "rightEye");
      const p = eye
        ? eye.getWorldPosition(new THREE.Vector3())
        : head
            .getWorldPosition(new THREE.Vector3())
            .add(new THREE.Vector3(side === "left" ? 0.032 : -0.032, 0.06, 0.07));
      return p.applyMatrix4(toHead);
    };
    // head-local scale from the gap between the eyes, so overlays fit any model size
    const gap = Math.max(0.03, eyeAt("left").distanceTo(eyeAt("right")));
    const place = (
      kind: "blush" | "tear" | "sweat",
      size: [number, number],
      offset: (side: 1 | -1) => [number, number, number],
      sides: ReadonlyArray<1 | -1>,
    ) => {
      const map = textures[kind]();
      for (const side of sides) {
        const mat = new THREE.MeshBasicMaterial({
          map,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0] * gap, size[1] * gap), mat);
        const at = eyeAt(side === 1 ? "left" : "right");
        const [x, y, z] = offset(side);
        mesh.position.set(at.x + x * gap, at.y + y * gap, at.z + z * gap);
        mesh.renderOrder = 10;
        mesh.visible = false;
        head.add(mesh);
        made.push(mesh);
        (groups[kind] ??= []).push(mesh);
      }
    };
    place("blush", [0.9, 0.55], (s) => [0.12 * s, -0.55, 0.12], [1, -1]);
    place("tear", [0.18, 0.5], (s) => [0.05 * s, -0.42, 0.2], [1, -1]);
    place(
      "sweat",
      style === "anime" ? [0.3, 0.42] : [0.8, 0.5],
      (s) => (style === "anime" ? [0.62 * s, 0.35, 0.05] : [0, 0.85, 0.05]),
      [1],
    );
  }

  const skins: Array<{ m: THREE.Material & Record<string, unknown>; base: number | null }> = [];
  vrm.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const x of Array.isArray(m) ? m : m ? [m] : []) {
      const mat = x as THREE.Material & Record<string, unknown>;
      if (made.some((mesh) => mesh.material === mat)) continue;
      if (mat["parametricRimColorFactor"] instanceof THREE.Color)
        skins.push({ m: mat, base: null });
      else if (typeof mat["roughness"] === "number")
        skins.push({ m: mat, base: mat["roughness"] as number });
    }
  });
  let sheenWas = 0;

  return {
    set: (s: States) => {
      const show = (kind: "blush" | "tear" | "sweat", w: number) => {
        for (const mesh of groups[kind] ?? []) {
          (mesh.material as THREE.MeshBasicMaterial).opacity = w;
          mesh.visible = w > 0.02;
        }
      };
      show("blush", s.blush ?? 0);
      show("tear", s.eyesTeary ?? 0);
      show("sweat", s.sweat ?? 0);
      const sheen = s.sheen ?? 0;
      if (Math.abs(sheen - sheenWas) > 0.02) {
        sheenWas = sheen;
        for (const { m, base } of skins) {
          if (base === null) {
            (m["parametricRimColorFactor"] as THREE.Color).setScalar(0.35 * sheen);
            if (typeof m["parametricRimFresnelPowerFactor"] === "number")
              m["parametricRimFresnelPowerFactor"] = 5 - 2 * sheen;
          } else m["roughness"] = base * (1 - 0.6 * sheen);
        }
      }
    },
    dispose: () => {
      for (const mesh of made) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
    },
  };
};

/** Small layered sines: a tremble that never repeats visibly within a breath. */
const shake = (t: number, seed: number) =>
  (Math.sin(t * 58.4 + seed) +
    Math.sin(t * 86.1 + seed * 2.3) * 0.6 +
    Math.sin(t * 107.5 + seed * 3.1) * 0.4) /
  2;

/** Adds breathing, trembling and the arch onto the rest pose (radians on normalized bones); returns the exhale 0..1. */
export const applyMotion = (
  bone: (
    name: "hips" | "spine" | "chest" | "neck" | "head" | "leftShoulder" | "rightShoulder",
  ) => THREE.Object3D | null | undefined,
  m: Motion,
  seconds: number,
): number => {
  const phase = Math.sin(2 * Math.PI * m.breathHz * seconds);
  const chest = bone("chest");
  const spine = bone("spine");
  const head = bone("head");
  if (chest) chest.rotation.x += -0.035 * m.breath * phase - 0.12 * m.arch;
  if (spine) spine.rotation.x += -0.015 * m.breath * phase - 0.18 * m.arch;
  if (head) head.rotation.x += -0.16 * m.arch;
  const lift = 0.04 * m.breath * Math.max(0, phase);
  const ls = bone("leftShoulder");
  const rs = bone("rightShoulder");
  if (ls) ls.rotation.z += lift;
  if (rs) rs.rotation.z -= lift;
  if (m.tremble > 0) {
    const a = 0.012 * m.tremble;
    const hips = bone("hips");
    if (hips) hips.rotation.z += a * shake(seconds, 1);
    if (spine) spine.rotation.z += a * shake(seconds, 2);
    if (head) head.rotation.x += a * 0.8 * shake(seconds, 3);
  }
  return (1 - phase) / 2;
};
