/**
 * The light 3D body (M-047): one VRM model on three.js, driven only by body cues (tessaya-shared bodyCues.ts). Built for
 * old devices: it draws only while something moves (speech, a gesture, a blend, a blink), capped per quality tier, and
 * nothing at all while hidden. At rest it is a still picture with a blink every few seconds.
 */
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import {
  GESTURES,
  actLevel,
  INTIMATE_FACES,
  INTIMATE_STATES,
  STILL,
  beastkin,
  faceWeights,
  limitMouth,
  mouthIntentOf,
  mouthWeights,
  parseCue,
  swingAt,
  type BodyBone,
  type BodyCue,
  type Motion,
  type States,
  type Weights,
} from "@t3tools/tessaya-shared/bodyCues";
import {
  HUMAN_SENSE,
  NO_SENSE,
  claimedRegion,
  feltOf,
  fire,
  mergeSense,
  reflexesOf,
  zonesPack,
  type SensePack,
} from "@t3tools/tessaya-shared/bodySense";
import {
  ACTS,
  BODY_JOINTS,
  POSE_BONES,
  isHang,
  POSTURES,
  TOUCH_FACE,
  clipAt,
  danceAt,
  outfitPiece,
  postureFor,
  readTouch,
  stepAt,
  touchZoneAt,
  traceStep,
  TRACE_LINGER_MS,
  HOLD_MS,
  type Euler,
  type OutfitPiece,
  type PoseBone,
  type PostureName,
  type Skeleton,
  type TouchKind,
  type Trace,
} from "@t3tools/tessaya-shared/bodyMotion";
import {
  QI,
  fitProxies,
  halfLifeOf,
  qToEuler,
  makeRig,
  manifestOf,
  REFERENCE_RIG,
  preparePose,
  settled,
  SOFT_DEPTH,
  softContacts,
  springStep,
  type BoneSpring,
  type Q,
  type Rig,
  type RigBone,
  type RigIssue,
  type RigManifest,
  type V3,
} from "@t3tools/tessaya-shared/bodyRig";
import type { BodyState } from "@t3tools/tessaya-shared/bodyControl";
import { INVOLUNTARY, performCues } from "@t3tools/tessaya-shared/bodyPlanner";
import { contactFeel } from "@t3tools/tessaya-shared/bodyContact";
import { FINGER_KEYS, fingerBones, PALM_CONTACT } from "@t3tools/tessaya-shared/bodySkills";
import { gaitAt, gaitOf, type Gait } from "@t3tools/tessaya-shared/bodyGait";
import type { BodyTarget } from "@t3tools/tessaya-shared/bodyLocomotion";
import type { StageMount, StageSpot } from "@t3tools/tessaya-shared/rooms";
import { meetPalms, palmOf, palmWorld, reach, turnWorld, type Arm, type Limb } from "./handIk.ts";
import { handSkinsOf, skinBetween, skinOverlap } from "./handSkin.ts";
import { softenOnContact } from "./softContact.ts";
import IDLE_URL from "./assets/idle-neutral.vrma?url";
import TURN_LEFT_URL from "./assets/turn-left.vrma?url";
import TURN_RIGHT_URL from "./assets/turn-right.vrma?url";
import WALK_URL from "./assets/walk-neutral.vrma?url";
import { bakeLoco, type LocoClip, type LocoFrame } from "./mocapLoco.ts";
import {
  grabKindOf,
  nearestRoot,
  pullOn,
  pullRoot,
  wrapAround,
  type GrabKind,
} from "@t3tools/tessaya-shared/bodyGrab";
import {
  agentHandAt,
  euroStep,
  handContact,
  handPresence,
  pointerHand,
  predict,
  yieldTo,
  type EuroState,
  type HandFrame,
  type HandMotion,
} from "@t3tools/tessaya-shared/bodyHand";
import { visemeAt, type VisemeSegment } from "@t3tools/tessaya-shared/visemes";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  applyMotion,
  makeOverlays,
  perfectSyncWeights,
  stateWeights,
  styleOf,
  type Style,
} from "./intimate";

/** Tiers from cheapest: pixel ratio, antialiasing and the frame ceiling while talking. */
const TIERS = [
  { ratio: 0.75, aa: false, fps: 20 },
  { ratio: 1, aa: false, fps: 30 },
  // a desktop-class device draws her moves at 60: at 30 a moving body judders on a 60 Hz screen; at rest nothing draws
  { ratio: 1.5, aa: true, fps: 60 },
] as const;
/** A frame slower than this on average (ms of our own work) steps the tier down. */
const SLOW_FRAME_MS = 14;
const BLEND_MS = 220;
const BLINK_MS = 160;
/** Spring bones (hair, cloth) settle for this long after the last move. */
const SETTLE_MS = 600;
const LEVEL_HOLD_MS = 400;
/** Breathing alone is slow: drawn at this ceiling unless something faster moves too. */
const BREATH_FPS = 12;
/**
 * Some models (VRM 0.x on three-vrm's normalized rig, even after rotateVRM0) turn X and Z the other way, so the same
 * pose would raise the arms. Which way a model turns is measured when it loads (mirroredOf); a mirrored one has its
 * normalized rotations mirrored around the update, so every pose here is written once, in VRM 1.0's axes.
 */
const flipVrm0 = (vrm: VRM) => {
  for (const b of Object.values(vrm.humanoid.normalizedHumanBones)) {
    const r = b?.node.rotation;
    if (r) r.set(-r.x, r.y, -r.z);
  }
};
/** Lower the left arm by a radian on the normalized rig: a hand that rises means this model turns Z the other way. */
/** Bone lines her surface is measured out from (surfaceNormal): trunk, head, limbs. */
const NORMAL_SEGMENTS: ReadonlyArray<readonly [VRMHumanBoneName, VRMHumanBoneName]> = [
  ["hips", "upperChest"],
  ["neck", "head"],
  ...(["left", "right"] as const).flatMap(
    (s) =>
      [
        [`${s}UpperArm`, `${s}LowerArm`],
        [`${s}LowerArm`, `${s}Hand`],
        [`${s}UpperLeg`, `${s}LowerLeg`],
        [`${s}LowerLeg`, `${s}Foot`],
      ] as const,
  ),
];
const CONTACT_BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftLowerArm",
  "rightLowerArm",
  "leftHand",
  "rightHand",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftFoot",
  "rightFoot",
] as const satisfies ReadonlyArray<VRMHumanBoneName>;

const mirroredOf = (vrm: VRM): boolean => {
  const arm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
  const hand =
    vrm.humanoid.getRawBoneNode("leftHand") ?? vrm.humanoid.getRawBoneNode("leftLowerArm");
  if (!arm || !hand) return vrm.meta.metaVersion === "0";
  const y = () => {
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    return hand.getWorldPosition(new THREE.Vector3()).y;
  };
  arm.quaternion.identity();
  const rest = y();
  arm.rotation.set(0, 0, -1);
  const lowered = y();
  arm.quaternion.identity();
  vrm.update(0);
  return lowered > rest;
};
/** A clip's palms at this gap or closer are meant to touch; her skin is then closed to SKIN_TOUCH_M. */
const SKIN_TOUCH_M = 0.0005;
/** No part of either hand more than this inside the other. */
const SKIN_PEN_M = 0.002;
/** Each hand's real skin (palm, and palm with fingers) on a model. */
const skinsOf = (vrm: VRM) => {
  const sides = new Map<THREE.Object3D, "left" | "right">();
  const palms = new Set<THREE.Object3D>();
  for (const [name, b] of Object.entries(vrm.humanoid.humanBones)) {
    const m = /^(left|right)(Hand|Thumb|Index|Middle|Ring|Little)/.exec(name);
    if (!b?.node || m === null) continue;
    sides.set(b.node, m[1] as "left" | "right");
    if (m[2] === "Hand") palms.add(b.node);
  }
  return handSkinsOf(
    vrm.scene,
    (bone) => sides.get(bone) ?? null,
    (bone) => palms.has(bone),
  );
};
/** Her head, chest and pelvis, each with the way it faces at rest in its own frame (for checks: probe().yaws). */
const facingsOf = (vrm: VRM) => {
  vrm.scene.updateMatrixWorld(true);
  const l = vrm.humanoid.getRawBoneNode("leftUpperLeg")?.getWorldPosition(new THREE.Vector3());
  const r = vrm.humanoid.getRawBoneNode("rightUpperLeg")?.getWorldPosition(new THREE.Vector3());
  if (!l || !r) return [];
  const ahead = l.sub(r).cross(new THREE.Vector3(0, 1, 0)).normalize();
  return (["head", "upperChest", "hips"] as const).flatMap((b) => {
    const node = vrm.humanoid.getRawBoneNode(b) ?? (b === "upperChest" ? vrm.humanoid.getRawBoneNode("chest") : null);
    if (!node) return [];
    const inv = node.getWorldQuaternion(new THREE.Quaternion()).invert();
    return [{ bone: b, node, ahead: ahead.clone().applyQuaternion(inv) }];
  });
};
/** Each leg's drawn bones, for planting a foot. */
const legsOf = (vrm: VRM) => {
  const one = (s: "left" | "right"): Limb | null => {
    const raw = (b: string) => vrm.humanoid.getRawBoneNode(b as VRMHumanBoneName);
    const [upper, lower, end] = [raw(`${s}UpperLeg`), raw(`${s}LowerLeg`), raw(`${s}Foot`)];
    return upper && lower && end ? { upper, lower, end } : null;
  };
  const left = one("left");
  const right = one("right");
  return left && right ? { left, right } : null;
};
/** Each arm's drawn bones, and its palm measured on the hand's own skin at rest. */
const armsOf = (vrm: VRM, skin: ReadonlyArray<{ bone: string; p: V3 }>, height: number) => {
  const one = (s: "left" | "right"): Arm | null => {
    const raw = (b: string) => vrm.humanoid.getRawBoneNode(b as VRMHumanBoneName);
    const [upper, lower, end] = [raw(`${s}UpperArm`), raw(`${s}LowerArm`), raw(`${s}Hand`)];
    if (!upper || !lower || !end) return null;
    const knuckles = ["Index", "Middle", "Ring", "Little"].flatMap((f) => {
      const n = raw(`${s}${f}Proximal`);
      return n ? [n.getWorldPosition(new THREE.Vector3())] : [];
    });
    const k =
      knuckles.length === 0
        ? null
        : knuckles.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(knuckles.length);
    const own = skin.filter((x) => x.bone === `${s}Hand`).map((x) => x.p);
    return { upper, lower, end, palm: palmOf(end, k, own, height) };
  };
  const left = one("left");
  const right = one("right");
  return left && right ? { left, right } : null;
};
/**
 * Up to ~30k of the model's skinned vertices at rest, each with the humanoid bone that moves it most: what the rig
 * fits her own thickness to (fitProxies). Read once when the model loads.
 */
const skinSamples = (vrm: VRM): Array<{ bone: string; p: V3 }> => {
  const human = new Map<THREE.Object3D, string>();
  for (const [name, b] of Object.entries(vrm.humanoid.humanBones))
    if (b?.node) human.set(b.node, name);
  const meshes: THREE.SkinnedMesh[] = [];
  vrm.scene.traverse((o) => {
    // hair sways away from the head on its own springs: it is not where a hand meets her
    const hair =
      /hair/i.test(o.name) ||
      [(o as THREE.Mesh).material].flat().some((m) => /hair/i.test(m?.name ?? ""));
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !hair) meshes.push(o as THREE.SkinnedMesh);
  });
  const total = meshes.reduce((n, m) => n + (m.geometry.getAttribute("position")?.count ?? 0), 0);
  const stride = Math.max(1, Math.ceil(total / 30_000));
  const out: Array<{ bone: string; p: V3 }> = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position");
    const idx = m.geometry.getAttribute("skinIndex");
    const wt = m.geometry.getAttribute("skinWeight");
    if (!pos || !idx || !wt) continue;
    m.updateMatrixWorld(true);
    for (let i = 0; i < pos.count; i += stride) {
      let best = -1;
      let bw = 0;
      for (let k = 0; k < 4; k++) {
        const w = wt.getComponent(i, k);
        if (w > bw) [bw, best] = [w, idx.getComponent(i, k)];
      }
      const name = best < 0 ? undefined : human.get(m.skeleton.bones[best]!);
      if (name === undefined) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push({ bone: name, p: [v.x, v.y, v.z] });
    }
  }
  return out;
};
/** The model's skeleton at rest for the rig: humanoid bones by VRM name, every other bone by its own (for the manifest). */
const rigOf = (vrm: VRM): Rig => {
  vrm.scene.updateMatrixWorld(true);
  const human = new Map<THREE.Object3D, string>();
  for (const [name, b] of Object.entries(vrm.humanoid.humanBones))
    if (b?.node) human.set(b.node, name);
  const bones: RigBone[] = [];
  const at = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone && !human.has(o)) return;
    let p = o.parent;
    while (p !== null && !(p as THREE.Bone).isBone && !human.has(p)) p = p.parent;
    const name = human.get(o) ?? o.name;
    const parent = p === null ? null : (human.get(p) ?? p.name);
    o.getWorldPosition(at);
    bones.push({ name, parent, rest: [at.x, at.y, at.z] });
  });
  return makeRig(bones);
};
/** Body expressions a model may carry, driven from her motion and states rather than set directly. */
const BODY_EXPRESSIONS = ["breath", "flush", "hairDamp"] as const;
/** How quickly the intimate states and motion follow their targets (per second, exponential). */
const FOLLOW = 3;
/** Every ARKit unit the intimate set can move, and the states it then sculpts instead of the presets' approximation. */
const SYNC_UNITS = Object.keys(
  perfectSyncWeights(Object.fromEntries(INTIMATE_STATES.map((n) => [n, 1])), 0.5),
);
const SCULPTED = new Set<string>([
  "eyesHalf",
  "eyesShut",
  "eyesTeary",
  "mouthPant",
  "mouthO",
  "mouthBite",
]);
/** The bone a held prop goes on for each place he can touch. */
const PROP_BONE: Readonly<Record<string, BodyBone>> = {
  head: "head",
  hair: "head",
  face: "head",
  neck: "neck",
  shoulder: "rightShoulder",
  arm: "rightUpperArm",
  hand: "rightHand",
  chest: "chest",
  belly: "spine",
  back: "spine",
  waist: "spine",
  hips: "hips",
  thigh: "hips",
  leg: "hips",
  foot: "hips",
};
/** After his last cue or touch she breathes and sways for this long, then holds still: nothing repaints at rest. */
const IDLE_MS = 20_000;
/** Walking toward or away from him, metres a second. */
const WALK_SPEED = 0.45;
const REFLEX_MS = 350;
/** The drawn hand turns to a new surface direction with this time constant (ms). */
const HAND_TURN_MS = 90;
const HAND_GLIDE_MS = 45;
/** A part gives to a hand over this time constant (ms), so a press eases in rather than snaps. */
const GIVE_TAU_MS = 80;
/** Each giving part and the bone its lever runs to (bodyHand GIVE), so a kept choice still finds its pair. */
const GIVE_CHILD: Readonly<Record<string, ReadonlyArray<string>>> = {
  neck: ["head"],
  spine: ["upperChest", "chest"],
  leftUpperArm: ["leftLowerArm"],
  rightUpperArm: ["rightLowerArm"],
  leftLowerArm: ["leftHand"],
  rightLowerArm: ["rightHand"],
  leftUpperLeg: ["leftLowerLeg"],
  rightUpperLeg: ["rightLowerLeg"],
};
/** A mouse resting over her this long (ms) lets the hand fade. */
const HOVER_IDLE_MS = 1500;
/** A tremble runs full this long (ms), then settles to a faint quiver; it re-arms after this long calm. */
const TREMOR_BURST_MS = 2500;
const TREMOR_REARM_MS = 1000;
/** A finger's three segments as shares of its length, and its thickness as a share of the hand's. */
const FINGER_SHARES = [0.45, 0.3, 0.25] as const;
const FINGER_THICK = 0.045;
/** Her give to a pull eases in over this (ms): quick as a person's, and never a jitter. */
const PULL_TAU_MS = 90;
/** A pull that hurts this long, she pulls free of (withdrawal is involuntary: no grab overrides it). */
const PULL_HURT_MS = 600;
/** A firm push on her trunk held this long (ms) moves her feet: a balance step. */
const PUSH_STEP_MS = 400;
/** How long her head and eyes follow a touch, and a little more than the 150 ms in which a person turns to one. */
const TOUCH_MS = 1600;
// how glad a mood is of a touch (-1..1): she leans into it when glad, away when not
const GLAD = new Set([
  "happy",
  "delighted",
  "laughing",
  "giggle",
  "excited",
  "proud",
  "relieved",
  "playful",
  "wink",
  "love",
  "amazed",
  "affectionate",
  "teasing",
]);
const WARY = new Set([
  "sad",
  "angry",
  "scared",
  "nervous",
  "guarded",
  "annoyed",
  "disgusted",
  "unimpressed",
  "skeptical",
  "bored",
  "embarrassed",
]);
const moodValence = (m: string) =>
  GLAD.has(m) ? 1 : WARY.has(m) ? -1 : m === "shy" || m === "curious" ? 0.4 : 0.2;
/** A hover's raycast at most this often while the mouse moves over her. */
const HOVER_RAY_MS = 80;

export interface BodyStats {
  readonly tier: number;
  readonly frames: number;
  readonly avgFrameMs: number;
  readonly visible: boolean;
  readonly model: string | null;
  readonly posture: PostureName;
}

const startTier = () => {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  if ((nav.deviceMemory ?? 4) <= 2 || cores <= 2) return 0;
  return cores <= 4 ? 1 : 2;
};

/**
 * One renderer, scene, camera and light rig that several bodies share (a mirror, the phone's crew): each body ticks its
 * own state on the stage's single frame, and the stage draws once.
 */
export interface Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly lights: ReturnType<typeof makeStage>["lights"];
  /** A body wants a frame within `afterMs`. */
  readonly wake: (afterMs: number, id: string) => void;
  /** Every body's joints (world), so the one camera frames all of them. */
  readonly points: () => ReadonlyArray<THREE.Vector3>;
  /** The body that moves the shared camera (the first one mounted). */
  readonly leads: (id: string) => boolean;
}

const makeStage = (canvas: HTMLCanvasElement, tier: number) => {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: TIERS[tier]!.aa,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
  camera.position.set(0, 1.35, 2.1);
  camera.lookAt(0, 1.3, 0);
  // stage lighting: a soft fill, a warm key and a cool rim that lifts her off the background
  const fill = new THREE.HemisphereLight(0xfff4ee, 0x2a2630, 1.1);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xfff0e6, 1.5);
  sun.position.set(0.8, 1.9, 2);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xcfe0ff, 1.3);
  rim.position.set(-1.2, 2.2, -1.6);
  scene.add(rim);
  return { renderer, scene, camera, lights: { fill, sun, rim } };
};

export function mountBody(
  canvas: HTMLCanvasElement,
  options: {
    readonly tier?: number;
    /** `bone` is where a held prop goes; `zone` is the part of her he touched, and `touch` what kind and how strong. */
    readonly onTouch?: (
      bone: BodyBone,
      zone: string,
      touch: {
        readonly kind: TouchKind | (string & {});
        readonly intensity: number;
        readonly speed: number;
        /** How much of his hand met her (cm²: a fingertip is ~1, a palm ~60) and how firmly (0..1). */
        readonly area?: number;
        readonly pressure?: number;
        /** Her own hand on herself (a clap, a hand on her arm), felt by her alone. */
        readonly self?: boolean;
        /** What her nerves made of it (bodySense.ts): how strongly it fired, 0..1, the fibres that led, and its speed. */
        readonly felt?: {
          readonly intensity: number;
          readonly kind: string;
          readonly cmPerS: number;
        };
      },
    ) => void;
    /** The outfit pieces this model can take off, once it loads (none when clothing is painted on). */
    readonly onOutfit?: (pieces: ReadonlyArray<OutfitPiece>) => void;
    /** "body" frames all of her (the phone's touch view); the default frames head and shoulders. */
    /** "half" is mid-thigh up, face in the upper third: a phone, where a whole small figure hides her face. */
    readonly framing?: "bust" | "body" | "half";
    /** Each time she comes to rest after moving: what her body is doing now (proprioception), for the layer to keep. */
    readonly onSettle?: (state: BodyState) => void;
    /**
     * Where a turn or walk target is from her: which way (yaw, 0 toward him, + to her left) and how far (metres). The
     * host knows her world (the desk, other bodies); without it, a point is read across this view.
     */
    readonly locate?: (to: BodyTarget) => { readonly yaw: number; readonly metres: number } | null;
    /** Her standing idle (VRMA), where the bundled one is not served (a harness). */
    readonly idleUrl?: string;
    /** Her walk and turns (VRMA), where the bundled ones are not served (a harness). */
    readonly gaitUrls?: { readonly walk: string; readonly left: string; readonly right: string };
    /** Each frame of a walk, how far she went and which way, so the host carries her (the desk moves her window). */
    readonly onWalk?: (step: {
      readonly metres: number;
      readonly heading: number;
      readonly done: boolean;
      /** Her height (m), so the host turns metres into its own units. */
      readonly height: number;
    }) => void;
    /** Where this body stands on a shared stage (metres across and toward him); the stage puts the camera on all. */
    readonly at?: { readonly x: number; readonly z: number };
  } = {},
  /** A stage this body shares with others (`mountBodies`); without one it has its own renderer and loop. */
  shared?: { readonly stage: Stage; readonly id: string },
) {
  let tier = options.tier ?? startTier();
  const { renderer, scene, camera, lights } = shared?.stage ?? makeStage(canvas, tier);
  const { fill, sun, rim } = lights;
  // her own place in the scene: every part of her hangs under it, so bodies on one stage stand apart
  const jointPool = BODY_JOINTS.map(() => new THREE.Vector3());
  const root = new THREE.Group();
  root.position.set(options.at?.x ?? 0, 0, options.at?.z ?? 0);
  scene.add(root);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  // her standing idle: real motion capture (assets/CREDITS.md) baked onto this model's own bones when it loads, so her
  // arms hang at her sides and her weight shifts as a person's does, under whatever her posture adds
  let idle: {
    readonly fps: number;
    readonly loop: true;
    readonly frames: ReadonlyArray<Partial<Record<PoseBone, Euler>>>;
  } | null = null;
  const bakeIdle = async (target: VRM, flip: boolean) => {
    const got = await loader.loadAsync(options.idleUrl ?? IDLE_URL).catch(() => null);
    const anim = (got?.userData["vrmAnimations"] as ReadonlyArray<unknown> | undefined)?.[0];
    if (anim === undefined || disposed || vrm !== target) return;
    const mixer = new THREE.AnimationMixer(target.scene);
    const clip = createVRMAnimationClip(
      anim as Parameters<typeof createVRMAnimationClip>[0],
      target,
    );
    mixer.clipAction(clip).play();
    const fps = 30;
    const frames: Array<Partial<Record<PoseBone, Euler>>> = [];
    for (let t = 0; t < clip.duration; t += 1 / fps) {
      mixer.setTime(t);
      const f: Partial<Record<PoseBone, Euler>> = {};
      for (const b of POSE_BONES) {
        const r = target.humanoid.getNormalizedBoneNode(b)?.rotation;
        // written in VRM 1.0's axes, as every pose here is (a mirrored model is flipped around its update)
        if (r) f[b] = [flip ? -r.x : r.x, r.y, flip ? -r.z : r.z] as unknown as Euler;
      }
      frames.push(f);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(target.scene);
    for (const b of POSE_BONES) target.humanoid.getNormalizedBoneNode(b)?.quaternion.identity();
    if (vrm === target && frames.length > 1) {
      idle = { fps, loop: true, frames };
      invalidate();
    }
  };
  // her walk and turns: motion capture too (assets/CREDITS.md), baked after the idle so loading stays one bake at a time
  let gaits: { readonly walk: LocoClip; readonly left: LocoClip; readonly right: LocoClip } | null =
    null;
  const bakeGaits = async (target: VRM, flip: boolean) => {
    const one = async (url: string, loop: boolean) => {
      const got = await loader.loadAsync(url).catch(() => null);
      const anim = (got?.userData["vrmAnimations"] as ReadonlyArray<unknown> | undefined)?.[0];
      if (anim === undefined || disposed || vrm !== target) return null;
      return restHips === null
        ? null
        : bakeLoco(target, anim as Parameters<typeof bakeLoco>[1], flip, loop, restHips);
    };
    const walk = await one(options.gaitUrls?.walk ?? WALK_URL, true);
    const left = await one(options.gaitUrls?.left ?? TURN_LEFT_URL, false);
    const right = await one(options.gaitUrls?.right ?? TURN_RIGHT_URL, false);
    if (vrm === target && walk && left && right) gaits = { walk, left, right };
  };

  let vrm: VRM | null = null;
  let model: string | null = null;
  let shown = false;
  let onScreen = true;
  let disposed = false;
  const props = new Map<
    string,
    {
      url: string;
      object: THREE.Object3D;
      mixer: THREE.AnimationMixer | null;
      on: boolean;
      rate: number;
    }
  >();
  const propsRunning = () => [...props.values()].some((p) => p.on && p.mixer !== null);

  // what is showing and where it is heading
  let face: Weights = {};
  let faceFrom: Weights = {};
  let faceTo: Weights = {};
  let faceAt = 0;
  let look: string | null = null;
  // direct control: where she was asked to look and until when, and the pace a direct pose was asked to arrive at
  let gazeHold: { yaw: number; pitch: number; until: number } | null = null;
  let pace = 1;
  // shape keys by name on this model, the ones held by direct control, and this frame's from his mappings
  let shapeKeys = new Map<string, Array<{ mesh: THREE.Mesh; i: number }>>();
  let morphHold: Record<string, number> = {};
  let shapes: Record<string, number> = {};
  let seqTimers: Array<ReturnType<typeof setTimeout>> = [];
  let settledSent = true;
  // his hand: the last frame from whatever drives it (pointer now; an agent, a tracker or a controller later),
  // filtered, and the see-through hand drawn there while it is present
  let handFrame: HandFrame | null = null;
  let handEuro: EuroState | null = null;
  // an agent's hand on her: where it landed on her surface, the way along her it strokes, and its motion
  let agentTouch: {
    start: number;
    part: string;
    motion: HandMotion;
    pressure: number;
    ms: number;
    hit: THREE.Vector3;
    normal: THREE.Vector3;
    along: THREE.Vector3;
    /** How far the hand sits off the point it landed on, so its fingers lie on a curved part instead of in it. */
    lift: number;
    /** The bone it landed on and that bone's world-to-local at landing: the hand moves with her when she moves. */
    bone: THREE.Object3D | null;
    unbone: THREE.Matrix4;
  } | null = null;
  const follow = new THREE.Matrix4();
  // a reflex arc (her sense packs) pulls her back, then she settles, over REFLEX_MS; a caress's arc leans her in
  let reflexAt = -Infinity;
  // the part giving to the hand, kept for the contact, and how far it has turned (eased)
  let giving: { bone: string; angle: number; at: number } | null = null;
  let tremorSince: number | null = null;
  let tremorCalm: number | null = null;
  let reflexGain = 0.6;
  let leanAt = -Infinity;
  // her skin: the sense packs (the general human map, plus any a layer sends), and her nerves' state while touched
  let packs: ReadonlyArray<SensePack> = [HUMAN_SENSE];
  let sense = mergeSense(packs, true);
  let nerves = NO_SENSE;
  let nerveRegion: string | null = null;
  let nerveFelt: { intensity: number; kind: string; cmPerS: number } | null = null;
  const fired = new Set<string>();
  // a hand holding her (bodyGrab.ts): what it holds, where (in its root bone's frame, so it rides her pose), the
  // spring-bone lock it closed on (hair, a ribbon, a skirt), the hand now, and her give, smoothed so it never jitters
  let grip: {
    kind: GrabKind;
    root: string;
    region: string;
    local: THREE.Vector3;
    lock: THREE.Object3D | null;
    lockChild: THREE.Object3D | null;
    hand: THREE.Vector3;
    from: THREE.Vector3;
    pull: THREE.Vector3;
    speed: number;
    at: number;
    turns: Map<string, { axis: THREE.Vector3; angle: number }>;
    force: number;
    stretch: number;
    hurtSince: number | null;
    free: boolean;
  } | null = null;
  let wrapTurns: ReadonlyArray<number> | null = null;
  let pushSince: number | null = null;
  /** How much she braces against a hand (0..1): on guard she holds her ground. */
  const braced = () => ((scenePose ?? affectPose) === "guarded" ? 0.7 : 0);
  let lapse: ReturnType<typeof setTimeout> | null = null;
  // a pointer resting on her is still there: it fades only once it leaves her (a tracker fades when it loses her)
  let handHeld = false;
  let drawnAt = 0;
  const drawnN = new THREE.Vector3(0, 0, -1);
  const drawnP = new THREE.Vector3();
  const drawnD = new THREE.Vector3(0, 1, 0);
  let handMesh: {
    group: THREE.Group;
    fingers: THREE.Object3D[][];
    material: THREE.MeshStandardMaterial;
  } | null = null;
  const handLength = () => 0.11 * (rig?.height ?? 1.6);
  /** Her hair is not her: a hand rests on her skin or clothes, under long hair. */
  const isHair = (o: THREE.Object3D) => {
    const m = (o as THREE.Mesh).material;
    return [o.name, ...(Array.isArray(m) ? m : m ? [m] : []).map((x) => x.name)].some((n) =>
      /hair/i.test(n),
    );
  };
  const makeHand = () => {
    const material = new THREE.MeshStandardMaterial({
      color: 0xf0c8b4,
      roughness: 0.7,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const group = new THREE.Group();
    const L = handLength();
    const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), material);
    palm.scale.set(L * 0.22, L * 0.25, L * 0.06);
    group.add(palm);
    // a hand's own proportions: palm ~0.45 L wide, fingers in three segments (0.45/0.3/0.25), tapering, a little spread,
    // the thumb set low on the palm's side and turned toward it
    const fingers: THREE.Object3D[][] = [];
    for (const [i, x] of [-0.16, -0.055, 0.05, 0.145, -0.24].entries()) {
      const thumb = i === 4;
      const len = L * (thumb ? 0.36 : [0.43, 0.47, 0.45, 0.37][i]!);
      let parent: THREE.Object3D = group;
      const joints: THREE.Object3D[] = [];
      for (const [k, share] of [0.45, 0.3, 0.25].entries()) {
        const joint = new THREE.Group();
        if (k === 0) {
          joint.position.set(L * x, thumb ? -L * 0.08 : L * 0.27, 0);
          joint.rotation.z = thumb ? 0.75 : -x * 0.5;
          if (thumb) joint.rotation.y = -0.6;
        } else joint.position.y = len * [0.45, 0.3][k - 1]!;
        const r = L * (thumb ? 0.05 : 0.042) * (1 - 0.12 * k);
        const bone = new THREE.Mesh(
          new THREE.CapsuleGeometry(r, Math.max(0.001, len * share - 2 * r), 4, 8),
          material,
        );
        bone.position.y = (len * share) / 2;
        joint.add(bone);
        parent.add(joint);
        joints.push(joint);
        parent = joint;
      }
      fingers.push(joints);
    }
    group.visible = false;
    scene.add(group);
    return { group, fingers, material };
  };
  /**
   * Which way her surface faces at a hit: out from the nearest bone line through it. A skinned mesh's facet normal is
   * its rest pose's, so on a bent arm it points anywhere; the radial direction is right for a limb or trunk.
   */
  const surfaceNormal = (hit: THREE.Intersection): THREE.Vector3 => {
    let best: { d: number; n: THREE.Vector3 } | null = null;
    for (const [a0, b0] of NORMAL_SEGMENTS) {
      const a = worldOf(a0);
      const b = worldOf(b0) ?? a;
      if (!a || !b) continue;
      const ab = b.clone().sub(a);
      const t =
        ab.lengthSq() < 1e-9
          ? 0
          : Math.max(0, Math.min(1, hit.point.clone().sub(a).dot(ab) / ab.lengthSq()));
      const out = hit.point.clone().sub(a.addScaledVector(ab, t));
      const d = out.length();
      if (d > 1e-4 && (best === null || d < best.d)) best = { d, n: out.divideScalar(d) };
    }
    return (
      best?.n ??
      hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ??
      new THREE.Vector3(0, 0, 1)
    );
  };
  /** A pointer over or on her: the hand there, palm toward her surface. */
  const handAt = (
    hit: THREE.Intersection,
    pressed: boolean,
    pressure: number,
    fingertip: boolean,
  ) => {
    const n = surfaceNormal(hit);
    const now = performance.now();
    handFrame = pointerHand({
      at: now,
      hit: [hit.point.x, hit.point.y, hit.point.z],
      normal: [n.x, n.y, n.z],
      pressure,
      pressed,
      fingertip,
    });
    handEuro = euroStep(handEuro, handFrame.palm, now);
    handHeld = true;
    lastMove = now;
    invalidate();
  };
  /** Draws the hand where it is now; false once it has faded (nothing more to draw). */
  const drawHand = (now: number): boolean => {
    const { shown, relax } = handPresence(
      handFrame === null || !handHeld ? handFrame : { ...handFrame, at: now },
      now,
    );
    if (shown <= 0.01 || handFrame === null || handEuro === null) {
      if (handMesh !== null) handMesh.group.visible = false;
      return false;
    }
    handMesh ??= makeHand();
    const f = handFrame;
    // her surface pushes back: a firm press sits closer, a brush hovers just off her
    const off = handLength() * (0.08 - 0.06 * f.pressure);
    // the input arrives in steps (a hover's raycast every HOVER_RAY_MS): the drawn hand glides between them
    const goal = predict(handEuro, 16);
    const kp = drawnAt === 0 ? 1 : 1 - Math.exp(-Math.max(0, now - drawnAt) / HAND_GLIDE_MS);
    drawnP.lerp(new THREE.Vector3(...goal), kp);
    const at = [drawnP.x, drawnP.y, drawnP.z] as const;
    // the hand turns smoothly to the surface (a raycast's facet normal jumps triangle to triangle)
    const k = drawnAt === 0 ? 1 : 1 - Math.exp(-Math.max(0, now - drawnAt) / HAND_TURN_MS);
    drawnAt = now;
    drawnN.lerp(new THREE.Vector3(...f.normal), k).normalize();
    drawnD.lerp(new THREE.Vector3(...f.direction), k);
    const n = drawnN.clone();
    const d = drawnD
      .clone()
      .sub(n.clone().multiplyScalar(drawnD.dot(n)))
      .normalize();
    const side = new THREE.Vector3().crossVectors(d, n);
    handMesh.group.matrix.makeBasis(side, d, n.clone().negate());
    handMesh.group.matrix.setPosition(at[0] - n.x * off, at[1] - n.y * off, at[2] - n.z * off);
    handMesh.group.matrixAutoUpdate = false;
    handMesh.group.matrixWorldNeedsUpdate = true;
    // relaxed fingers rest a little bent; the curl closes them joint by joint
    const curl = f.curl * (1 - relax);
    for (const [i, finger] of handMesh.fingers.entries())
      for (const [k, joint] of finger.entries()) {
        // holding, the fingers close round the part (wrapAround); otherwise they rest a little bent and close by the curl
        joint.rotation.x =
          wrapTurns !== null
            ? (wrapTurns[k] ?? 0) * (i === 4 ? 0.5 : 1)
            : (i === 4 ? 0.12 : 0.18) + ((i === 4 ? 0.6 : 1.3) * curl) / 3;
        joint.updateMatrix();
      }
    handMesh.material.opacity = 0.55 * shown;
    handMesh.group.visible = true;
    return true;
  };
  let override: {
    face: Weights;
    states?: States;
    motion?: Partial<Motion>;
    until: number;
  } | null = null;
  // the intimate set: where the private layer wants it, and where it is on the way there
  let statesTo: States = {};
  let states: States = {};
  let motionTo: Motion = STILL;
  let motion: Motion = STILL;
  let style: Style = "anime";
  let overlays: ReturnType<typeof makeOverlays> | null = null;
  let soft: ReturnType<typeof softenOnContact> | null = null;
  let own = new Set<string>();
  // ARKit unit (any case) -> the model's own expression name, when it carries perfect sync
  let sync: Map<string, string> | null = null;
  let bodyOwn = new Set<string>();
  let mirrored = false;
  let speech: { track: ReadonlyArray<VisemeSegment>; start: number; end: number } | null = null;
  let effects: Array<{ at: number; face?: string; gesture?: string; act?: keyof typeof ACTS }> = [];
  let level: { value: number; viseme?: VisemeSegment["viseme"]; at: number } | null = null;
  let gestures: Array<{ name: string; start: number }> = [];
  let blinkAt = 0;
  let lastMove = 0;
  // her involuntary systems held back by a voluntary hold, each until a time (a breath held, a blink kept back)
  let holds: Record<string, number> = {};
  const held = (id: string, now = performance.now()) => (holds[id] ?? 0) > now;
  // the last touch: where, and when; her head and eyes follow it for TOUCH_MS
  // a touch on her: where it landed, how firm (0..1), and where the toucher is (him, unless a hand came from elsewhere)
  let touch: { at: number; point: THREE.Vector3; strength: number; from?: THREE.Vector3 } | null =
    null;
  const scratch = new THREE.Vector3();
  // her breath's phase, carried frame to frame so its rate can change without a jump
  let breathCycles = 0;
  let breathAt = 0;
  // a small gaze shift that comes with each blink, so her eyes never sit dead still
  let glance = { yaw: 0, pitch: 0 };
  // her posture: the one her affect picks, a scene's held one, and the crossfade between them
  let affectPose: PostureName = "stand";
  let scenePose: PostureName | null = null;
  // the rig of the model on screen, every bone's spring toward its target, and what the last target needed fixing
  let rig: Rig | null = null;
  let manifest: RigManifest | null = null;
  /**
   * For checks: each palm's skin centre and facing (world), their distance, and the nearest her two hands' skin comes
   * (both mm), read off the drawn mesh.
   */
  const palmsOf = () => {
    if (vrm === null || arms === null) return null;
    vrm.scene.updateMatrixWorld(true);
    const side = (arm: Arm) => {
      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      palmWorld(arm, p, n);
      return { at: p.toArray(), normal: n.toArray() };
    };
    const left = side(arms.left);
    const right = side(arms.right);
    // her real skin: the palms' least signed distance, and the deepest either hand (fingers too) is in the other
    const skin = skins === null ? null : skinBetween(skins.left, skins.right);
    const deep = skins === null ? null : skinOverlap(skins.left, skins.right);
    const mm = (x: number) => Math.round(x * 10000) / 10;
    return {
      left,
      right,
      centresMm: mm(new THREE.Vector3(...left.at).distanceTo(new THREE.Vector3(...right.at))),
      facing: -new THREE.Vector3(...left.normal).dot(new THREE.Vector3(...right.normal)),
      skinGapMm: skin === null ? null : mm(skin.gap),
      overlapMm: deep === null ? null : mm(deep.depth),
      overlapPart: deep?.part?.name ?? null,
      contactCm2: skin === null ? null : Math.round(skin.area * 1e5) / 10,
    };
  };
  const meetP = new THREE.Vector3();
  const trunkL = new THREE.Vector3();
  const trunkU = new THREE.Vector3();
  const trunkF = new THREE.Vector3();
  const trunkA = new THREE.Vector3();
  /** Her trunk's frame now: left, up (chest to neck) and ahead, unit; false without the bones. */
  const trunkFrame = () => {
    const h = vrm?.humanoid;
    const la = h?.getRawBoneNode("leftUpperArm");
    const ra = h?.getRawBoneNode("rightUpperArm");
    const top = h?.getRawBoneNode("upperChest") ?? h?.getRawBoneNode("chest");
    const neck = h?.getRawBoneNode("neck");
    if (!la || !ra || !top || !neck) return false;
    la.getWorldPosition(trunkL).sub(ra.getWorldPosition(trunkA)).normalize();
    neck.getWorldPosition(trunkU).sub(top.getWorldPosition(trunkA)).normalize();
    trunkF.crossVectors(trunkL, trunkU).normalize();
    return true;
  };
  /** Where a clip's palms meet on her: her own midline, ahead of her upper chest, at her scale. */
  const meetAt = (): THREE.Vector3 | null => {
    if (meet === null || !trunkFrame()) return null;
    const top = vrm!.humanoid.getRawBoneNode("upperChest") ?? vrm!.humanoid.getRawBoneNode("chest");
    const k = (rig?.height ?? 1.6) / 1.6;
    return top!
      .getWorldPosition(meetP)
      .addScaledVector(trunkF, meet[0] * k)
      .addScaledVector(trunkU, meet[1] * k);
  };
  /**
   * Her body goes with closing hands: the shoulders draw forward and her chest and head dip a little as they meet,
   * over whatever her idle is doing (added to the drawn bones, before the arms reach).
   */
  const engage = (gap: number, weight: number) => {
    if (vrm === null || !trunkFrame()) return;
    const close = weight * Math.max(0, 1 - gap / 0.08);
    if (close <= 0) return;
    const h = vrm.humanoid;
    for (const [b, a] of [
      ["chest", 0.035],
      ["neck", 0.03],
      ["head", 0.045],
    ] as const) {
      const node = h.getRawBoneNode(b);
      // about her left: her front dips
      if (node) turnWorld(node, trunkL, a * close);
    }
    for (const side of ["left", "right"] as const) {
      const node = h.getRawBoneNode(`${side}Shoulder`);
      // about her up: each shoulder comes forward
      if (node) turnWorld(node, trunkU, (side === "left" ? -1 : 1) * 0.07 * close);
    }
  };
  /** Her hands' real skin, measured each frame two-hand contact is being made. */
  let skins: ReturnType<typeof skinsOf> = null;
  /** Each drawn bone's humanoid name: which finger a contact reading came from. */
  let humanOf = new Map<THREE.Object3D, string>();
  /** How far her skin's own gap differs from the palm points' (m): learned at each contact, used between them. */
  let skinBias = 0;
  /** The palms' skin now, the last gap a clip asked for and when, and her own touch on herself (for her nerves). */
  let skinNow: { gap: number; area: number } | null = null;
  let palmsWas: { gap: number; at: number } | null = null;
  let selfTouch: { impact: number; since: number; area: number; depth: number } | null = null;
  const tipW = new THREE.Vector3();
  const rootW = new THREE.Vector3();
  const awayW = new THREE.Vector3();
  const axisW = new THREE.Vector3();
  const palmP = new THREE.Vector3();
  /**
   * A finger (a thumb, most often) that the palms' contact has pushed into the other hand turns aside, out of the
   * contact, its whole chain from its root, until no part of either hand is more than 2 mm inside the other.
   */
  const clearFingers = () => {
    if (skins === null || arms === null || vrm === null) return;
    for (let pass = 0; pass < 6; pass++) {
      const o = skinOverlap(skins.left, skins.right);
      if (o.depth <= SKIN_PEN_M || o.part === null) return;
      const name = humanOf.get(o.part);
      const m =
        name === undefined ? null : /^(left|right)(Thumb|Index|Middle|Ring|Little)/.exec(name);
      if (m === null) return;
      const side = m[1] as "left" | "right";
      const root =
        vrm.humanoid.getRawBoneNode(
          `${side}${m[2]}${m[2] === "Thumb" ? "Metacarpal" : "Proximal"}` as VRMHumanBoneName,
        ) ?? vrm.humanoid.getRawBoneNode(`${side}${m[2]}Proximal` as VRMHumanBoneName);
      if (root === null) return;
      // away from the other hand is back along this palm's own facing
      palmWorld(arms[side], palmP, awayW);
      awayW.negate();
      root.getWorldPosition(rootW);
      o.part.getWorldPosition(tipW).sub(rootW);
      if (tipW.lengthSq() < 1e-8) (root.children[0] ?? root).getWorldPosition(tipW).sub(rootW);
      axisW.crossVectors(tipW, awayW);
      if (axisW.lengthSq() < 1e-10) return;
      turnWorld(
        root,
        axisW.normalize(),
        Math.min(0.35, (1.5 * o.depth) / Math.max(0.02, tipW.length()) + 0.06),
      );
    }
  };
  /**
   * Two-hand contact closed on her real skin: the palms go to the gap asked, then the skin is measured and the gap
   * corrected until the palms' skin is 0-1 mm apart (or the gap asked, when that is wider), a few passes at most.
   */
  const closePalms = (now: number) => {
    if (palms === null || arms === null || palms[1] <= 0) {
      skinNow = null;
      palmsWas = null;
      selfTouch = null;
      return;
    }
    const centre = meetAt() ?? undefined;
    engage(palms[0], palms[1]);
    // the first few mm of a rebound are the skin springing back: still touching
    const want = palms[0] <= PALM_CONTACT + 0.002 ? SKIN_TOUCH_M : palms[0];
    let gap = palms[0] + skinBias;
    meetPalms(arms.left, arms.right, gap, palms[1], palms[2], centre);
    // the skin is read only near contact (cheap enough there, nothing to do further apart)
    if (skins === null || palms[0] > 0.02 || palms[1] < 0.99) skinNow = null;
    else {
      for (let pass = 0; pass < 4; pass++) {
        skinNow = skinBetween(skins.left, skins.right);
        const err = skinNow.gap - want;
        if (Math.abs(err) <= 0.0005) break;
        gap -= err;
        meetPalms(arms.left, arms.right, gap, palms[1], palms[2], centre);
      }
      skinBias = gap - palms[0];
      clearFingers();
    }
    // the palms' skin met: felt from how fast they closed, how much skin, and how deep
    const touching = skinNow !== null && skinNow.gap <= 0.001;
    if (touching && selfTouch === null) {
      const speed =
        palmsWas === null
          ? 0
          : Math.max(0, palmsWas.gap - palms[0]) / Math.max(1e-3, (now - palmsWas.at) / 1000);
      selfTouch = {
        impact: speed,
        since: now,
        area: skinNow!.area,
        depth: Math.max(0, -skinNow!.gap),
      };
      options.onTouch?.("leftHand", "hand", {
        kind: "clap",
        intensity: Math.min(1, speed / 3),
        speed,
        area: Math.round(skinNow!.area * 1e4),
        pressure: contactFeel({
          impact: speed,
          sinceMs: 0,
          depth: selfTouch.depth,
          areaCm2: skinNow!.area * 1e4,
        }).pressure,
        self: true,
      });
    } else if (touching && selfTouch !== null) {
      selfTouch.area = skinNow!.area;
      selfTouch.depth = Math.max(0, -skinNow!.gap);
    } else selfTouch = null;
    palmsWas = { gap: palms[0], at: now };
  };
  /** Her arms as drawn, with each palm measured on her skin: what two-hand contact closes on. */
  let arms: { readonly left: Arm; readonly right: Arm } | null = null;
  /** A clip's palms this frame: [skin gap m, weight 0..1, offset kept along the palms 0..1]. */
  let palms: Euler | null = null;
  /** And where they meet: [ahead, up] from her upper chest on the 1.6 m body (bodySkills MEET_KEY). */
  let meet: Euler | null = null;
  let springs = new Map<string, BoneSpring>();
  let springing = false;
  let lastSpring = 0;
  let goalKey = "";
  let goal: Record<string, Q> = {};
  let issues: ReadonlyArray<RigIssue> = [];
  let stepping: number | null = null;
  let dancing: number | null = null;
  // turning and walking (B-059 step 8): her whole-body yaw on top of the model's own, and a walk in progress
  let facing = 0;
  let baseYaw = 0;
  let loco: {
    from: number;
    to: number;
    start: number;
    ms: number;
    walk: {
      gait: Gait;
      metres: number;
      start: number;
      travelled: number;
      last: number;
      /** The captured walk's place in its loop (frames). */
      phase: number;
    } | null;
    /** A captured turn: which, how much of its heading is used, and where she stood and faced as it began. */
    clip: {
      readonly c: LocoClip;
      readonly ratio: number;
      readonly facing0: number;
      readonly x0: number;
      readonly z0: number;
    } | null;
  } | null = null;
  /** Where her steps have carried her across the floor (her own model's offset, m). */
  let travelX = 0;
  let travelZ = 0;
  /** This frame's captured hips over the root, and how much of the capture is showing (0..1). */
  let locoHips: LocoFrame["hips"] | null = null;
  let locoW = 0;
  let locoPlant: LocoFrame["plant"] = [false, false];
  let restHips: THREE.Vector3 | null = null;
  let legs: { readonly left: Limb; readonly right: Limb } | null = null;
  /** For checks: the way her head, chest and pelvis face, each as a bone-local forward measured at rest. */
  let facingOf: ReturnType<typeof facingsOf> = [];
  let closer = 0;
  let closerTo = 0;
  let ground = 0;
  // where her feet meet the floor at rest, measured when the model loads
  let sole = Number.NaN;
  let idleUntil = 0;
  let framing = options.framing ?? "bust";
  // how much of the view a panel over her bottom edge covers (0..0.6): the framing keeps her above it
  let insetBottom = 0;
  let headY = 1.4;
  let camYaw = 0;
  let camPitch = 0;
  let touchAs: string | null = null;
  // owner extensions: a playing clip, extra touch regions, and model expressions standing in for states and faces
  let clip: (Extract<BodyCue, { kind: "clip" }> & { start: number }) | null = null;
  // the mouth shapes the last face cue asked for that were eased, and why (BodyState faceEased)
  let faceEased: ReadonlyArray<{ key: string; asked: number; shown: number; why: string }> = [];
  // the library move playing its physics-trained version, by its cues' id, until it ends
  let baked: { id: string; until: number } | null = null;
  let expMap: Extract<BodyCue, { kind: "expressions" }>["map"] = {};
  let moodKey = "";
  let outfit = new Map<OutfitPiece, THREE.Object3D[]>();
  let mood = { mood: "neutral", intensity: 0.5 };
  // kemonomimi parts on this model (ear and tail nodes by name) and their rest rotations
  let ears: Array<{ node: THREE.Object3D; x: number }> = [];
  let tails: Array<{ node: THREE.Object3D; x: number; y: number }> = [];
  let kin = beastkin({ mood: "neutral", intensity: 0.5 });
  let kinAt = 0;
  /** A wag is a burst after a mood arrives, then the tail rests: no endless loop at idle. */
  const WAG_MS = 2500;

  let frames = 0;
  let workMs = 0;
  let slow = 0;
  let lastFrame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let raf = 0;

  const resize = () => {
    if (shared !== undefined) return invalidate();
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIERS[tier]!.ratio));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  };

  const posture = () => {
    const p = POSTURES[scenePose ?? affectPose] as (typeof POSTURES)[PostureName] & {
      breath?: number;
      breathHz?: number;
      grounded?: boolean;
    };
    return clip?.grounded ? { ...p, grounded: true } : p;
  };
  const target = () => {
    const m = { ...motionTo, ...override?.motion };
    // a calm breath while she is awake to him; her feel's breath when it runs deeper
    if (performance.now() < idleUntil && m.breath < (posture().breath ?? 0.3))
      Object.assign(m, { breath: posture().breath ?? 0.3, breathHz: posture().breathHz ?? 0.25 });
    if (held("breath")) Object.assign(m, { breath: 0 });
    return { states: { ...statesTo, ...override?.states }, motion: m };
  };
  const setPose = (now: number) => {
    clip = null;
    pace = 1;
    springing = true;
    lastMove = now;
  };
  const wake = (now = performance.now()) => {
    idleUntil = now + IDLE_MS;
  };
  const settling = () => {
    const t = target();
    return (
      INTIMATE_STATES.some((n) => Math.abs((states[n] ?? 0) - (t.states[n] ?? 0)) > 0.01) ||
      (["breath", "tremble", "arch"] as const).some((k) => Math.abs(motion[k] - t.motion[k]) > 0.01)
    );
  };
  /** Only breathing (and slow settling) runs: the slow frame ceiling is enough. */
  const breathing = () =>
    motion.breath > 0.01 || motion.tremble > 0.01 || motion.arch > 0.01 || settling();

  const active = (now: number) =>
    speech !== null ||
    level !== null ||
    gestures.length > 0 ||
    now - faceAt < BLEND_MS ||
    now - blinkAt < BLINK_MS ||
    now - lastMove < SETTLE_MS ||
    (touch !== null && now - touch.at < TOUCH_MS) ||
    springing ||
    stepping !== null ||
    dancing !== null ||
    loco !== null ||
    (clip !== null &&
      (clip.loop || now - clip.start < (clip.frames.length / clip.fps) * 1000 + 500)) ||
    (tails.length > 0 && kin.tailAmp > 0 && now - kinAt < WAG_MS) ||
    propsRunning();

  /**
   * Her posture, with a playing clip's frame and any step or dance over it, made right for this model by the rig
   * (limits, hinge elbows and knees, her own rest pose), then followed by a spring per bone: any change of target, at
   * any moment, bends the motion smoothly instead of cutting it. Once every bone has arrived, nothing moves.
   */
  /** The reference body at her height: a walk's steps are planned on it, so her feet keep pace with the ground. */
  let stepped: { height: number; rig: Rig } | null = null;
  const stepRig = () => {
    const height = rig?.height ?? REFERENCE_RIG.height;
    if (stepped?.height !== height) {
      const k = height / REFERENCE_RIG.height;
      stepped = {
        height,
        rig: makeRig(
          Object.values(REFERENCE_RIG.bones).map((b) => ({
            ...b,
            rest: [b.rest[0] * k, b.rest[1] * k, b.rest[2] * k] as const,
          })),
        ),
      };
    }
    return stepped.rig;
  };
  /** Short quick steps for turning on the spot. */
  const turnGait = () => gaitOf(stepRig(), 0.4, "stroll");
  /** Which way and how far a target is: the host's answer, else him ahead, away behind, a point across this view. */
  const aimOf = (to: BodyTarget): { yaw: number; metres: number } | null => {
    const found = options.locate?.(to);
    if (found != null) return found;
    const height = rig?.height ?? REFERENCE_RIG.height;
    if (to.kind === "him") return { yaw: 0, metres: 0 };
    if (to.kind === "away") return { yaw: facing >= 0 ? Math.PI : -Math.PI, metres: 0 };
    if (to.kind === "persona") return null;
    // across the view: right of centre is her left (+x), so she turns that way; depth is not walked here
    const dx = to.x - 0.5;
    return Math.abs(dx) < 0.05
      ? { yaw: 0, metres: 0 }
      : { yaw: Math.sign(dx) * (Math.PI / 2), metres: Math.abs(dx) * 4 * (height / 1.6) };
  };
  /** A turn at a person's pace: about 180 degrees in 1.4 s, hips first, head leading. */
  const startTurn = (yaw: number, ms: number | undefined, now: number) => {
    const turn = Math.abs(yaw - facing);
    // more than about 25 degrees is stepped round as captured: the turn that way, its heading scaled to this one
    const c = gaits === null || turn <= 0.45 ? null : yaw > facing ? gaits.left : gaits.right;
    loco = {
      from: facing,
      to: yaw,
      start: now,
      ms:
        c !== null
          ? (c.frames.length / c.fps) * 1000
          : (ms ?? Math.max(400, Math.min(2000, 300 + (turn / Math.PI) * 1100))),
      walk: null,
      clip:
        c === null
          ? null
          : {
              c,
              ratio: (yaw - facing) / c.turn,
              facing0: facing,
              x0: travelX,
              z0: travelZ,
            },
    };
  };
  let walkOut: { at: ReturnType<typeof locoFrame>; start: number } | null = null;
  let lastStride: ReturnType<typeof locoFrame> | null = null;
  let walkDX = 0;
  let walkDZ = 0;
  /** A walk loop's root at frame `f` (fractional, any number of loops on): where its strides have carried her. */
  const loopRoot = (c: LocoClip, f: number): readonly [number, number] => {
    const n = c.frames.length - 1;
    const laps = Math.floor(f / n);
    const i = Math.floor(f - laps * n);
    const t = f - laps * n - i;
    // frames run 0..n, the last the first again one stride on: in a stride, frame i and the next one
    const a = c.frames[i]!.root;
    const b = c.frames[i + 1]!.root;
    const end = c.frames[n]!.root;
    return [a[0] + (b[0] - a[0]) * t + laps * end[0], a[1] + (b[1] - a[1]) * t + laps * end[1]];
  };
  /** A captured clip's frame `f` (fractional), each bone between its two nearest frames. */
  const locoFrame = (c: LocoClip, f: number, wrapAround: boolean) => {
    // a loop's last frame is its first again
    const n = wrapAround ? c.frames.length - 1 : c.frames.length;
    const i = wrapAround ? ((Math.floor(f) % n) + n) % n : Math.max(0, Math.min(n - 1, Math.floor(f)));
    const j = wrapAround ? (i + 1) % n : Math.min(n - 1, i + 1);
    return { a: c.frames[i]!, b: c.frames[j]!, t: wrapAround || i < n - 1 ? f - Math.floor(f) : 0 };
  };
  /** Her posture blended toward a captured frame by `w`: each bone and the hips' place. */
  const showLoco = (
    out: Partial<Record<PoseBone, Euler>>,
    base: Partial<Record<PoseBone, Euler>>,
    at: { a: LocoFrame; b: LocoFrame; t: number },
    w: number,
  ) => {
    const { a, b, t } = at;
    for (const [bone, x] of Object.entries(a.bones) as Array<[PoseBone, Euler]>) {
      const y = b.bones[bone] ?? x;
      const from = base[bone] ?? [0, 0, 0];
      out[bone] = [0, 1, 2].map((k) => {
        const v = x[k]! + (y[k]! - x[k]!) * t;
        return from[k]! + (v - from[k]!) * w;
      }) as unknown as Euler;
    }
    const hips = [0, 1, 2].map((k) => a.hips[k]! + (b.hips[k]! - a.hips[k]!) * t);
    // a second capture this frame (a walk taking over a turn) fades in over the first
    const was = locoW > 0 ? locoHips : null;
    locoHips = (was === null ? hips : hips.map((v, k) => was[k]! + (v - was[k]!) * w)) as unknown as LocoFrame["hips"];
    locoW = Math.max(locoW, w);
    locoPlant = t < 0.5 ? a.plant : b.plant;
  };
  const minJerk = (p: number) => {
    const x = Math.max(0, Math.min(1, p));
    return x * x * x * (10 - 15 * x + 6 * x * x);
  };
  /** How much of a captured turn's travel a turn on the spot keeps. */
  const TURN_TRAVEL = 0.33;
  /** Captured motion fades in and out over this long, from and back to her posture. */
  const LOCO_BLEND_MS = 250;
  /** This frame of a turn or walk: her yaw, the head leading it, and a walk's steps over her posture. */
  const locoAt = (
    now: number,
    base: Partial<Record<PoseBone, Euler>>,
  ): Partial<Record<PoseBone, Euler>> => {
    locoW = 0;
    if (walkOut !== null && loco?.walk == null) {
      // a walk's last stride fades into her stance where her feet are: nothing carries her on
      const w = 1 - (now - walkOut.start) / LOCO_BLEND_MS;
      if (w <= 0) walkOut = null;
      else {
        const out: Partial<Record<PoseBone, Euler>> = {};
        showLoco(out, base, walkOut.at, w);
        if (loco === null) return out;
      }
    }
    if (loco === null) return {};
    const out: Partial<Record<PoseBone, Euler>> = {};
    const u = (now - loco.start) / loco.ms;
    const turnClip = loco.clip;
    if (turnClip !== null) {
      // a captured turn: her body plays it, and her heading and place come from where its feet put her
      const ms = Math.max(0, now - loco.start);
      const at = locoFrame(turnClip.c, (ms / 1000) * turnClip.c.fps, false);
      // once it has played, a walk after it moves her on from where it left her
      if (ms <= loco.ms) {
        const root = at.a.root.map((v, k) => v + (at.b.root[k]! - v) * at.t);
        facing = turnClip.facing0 + turnClip.ratio * root[2]!;
        const yaw = baseYaw + turnClip.facing0;
        // the capture turns as it walks on; a turn where she stands keeps a third of that travel (her feet step
        // round about her place, pinned where they land)
        const x = root[0]! * TURN_TRAVEL;
        const z = root[1]! * TURN_TRAVEL;
        travelX = turnClip.x0 + Math.cos(yaw) * x + Math.sin(yaw) * z;
        travelZ = turnClip.z0 - Math.sin(yaw) * x + Math.cos(yaw) * z;
      }
      // a walk after it takes over its last steps
      const w = Math.min(1, ms / LOCO_BLEND_MS, (loco.ms - ms) / LOCO_BLEND_MS);
      if (w > 0) {
        showLoco(out, base, at, Math.max(0, w));
        // she looks first, then her shoulders come round, then her hips: the head ~200 ms ahead, the trunk twisting
        const turn = loco.to - loco.from;
        const lead = (k: number) => turn * (minJerk(u * k) - minJerk(u)) * w;
        for (const [bone, k, share] of [
          ["neck", 1.25, 0.35],
          ["head", 1.25, 0.35],
          ["chest", 1.12, 0.3],
          ["upperChest", 1.12, 0.3],
        ] as const) {
          const e = out[bone] ?? base[bone] ?? [0, 0, 0];
          out[bone] = [e[0], e[1] + lead(k) * share, e[2]];
        }
      }
    } else {
      facing = loco.from + (loco.to - loco.from) * minJerk(u);
      // the head gets there first: a lead that grows as the turn starts and is gone as the body arrives
      const lead = (loco.to - loco.from) * (minJerk(u * 1.6) - minJerk(u)) * 0.5;
      if (Math.abs(lead) > 1e-3) {
        const n = base.neck ?? [0, 0, 0];
        const h = base.head ?? [0, 0, 0];
        out.neck = [n[0], n[1] + lead * 0.5, n[2]];
        out.head = [h[0], h[1] + lead * 0.5, h[2]];
      }
      // a turn of more than about 25 degrees is stepped round, the feet lifting and setting down as she pivots
      if (loco.walk === null && u < 1 && Math.abs(loco.to - loco.from) > 0.45) {
        const t = (now - loco.start) / 1000;
        const ramp = Math.sin(Math.PI * Math.max(0, Math.min(1, u)));
        Object.assign(out, gaitAt(stepRig(), turnGait(), t, base, ramp, 0).bones);
      }
    }
    const w = loco.walk;
    if (w !== null && now >= w.start) {
      const t = (now - w.start) / 1000;
      const dt = Math.min(0.1, (now - w.last) / 1000);
      w.last = now;
      const left = (w.metres - w.travelled) / Math.max(0.05, w.gait.speed);
      // the first and last steps are short: speed eases in over 0.6 s and out over the last 0.6 s
      // a stop is a short decelerating step, not a creep: never under a quarter of her pace
      const ramp = Math.max(0.05, Math.min(1, t / 0.6, Math.max(0.25, left / 0.6)));
      let step: number;
      if (gaits !== null) {
        // the captured walk, played as fast as she is asked to go: her feet stay where they land
        const c = gaits.walk;
        const clipSpeed = c.ahead / ((c.frames.length - 1) / c.fps);
        const rate = w.gait.speed / clipSpeed;
        // she goes as far as the capture's own root goes between these two moments: her stance foot does not slide
        const from = loopRoot(c, w.phase);
        w.phase += rate * ramp * dt * c.fps;
        const to = loopRoot(c, w.phase);
        const dx = to[0] - from[0];
        const dz = to[1] - from[1];
        step = Math.hypot(dx, dz);
        walkDX = dx;
        walkDZ = dz;
        const blend = Math.min(1, (t * 1000) / LOCO_BLEND_MS);
        const at = locoFrame(c, w.phase, true);
        showLoco(out, { ...base, ...out }, at, blend);
        lastStride = at;
      } else {
        const frame = gaitAt(stepRig(), w.gait, t, base, ramp);
        Object.assign(out, frame.bones);
        step = frame.speed * dt;
      }
      w.travelled += step;
      if (options.onWalk !== undefined)
        options.onWalk({
          metres: step,
          heading: facing,
          done: false,
          height: rig?.height ?? REFERENCE_RIG.height,
        });
      else {
        // no host carries her: she goes across the floor herself, the way she faces
        const yaw = baseYaw + facing;
        if (gaits !== null) {
          travelX += Math.cos(yaw) * walkDX + Math.sin(yaw) * walkDZ;
          travelZ += -Math.sin(yaw) * walkDX + Math.cos(yaw) * walkDZ;
        } else {
          travelX += Math.sin(yaw) * step;
          travelZ += Math.cos(yaw) * step;
        }
      }
      if (w.travelled >= w.metres) {
        loco.walk = null;
        if (lastStride !== null) walkOut = { at: lastStride, start: now };
        options.onWalk?.({
          metres: 0,
          heading: facing,
          done: true,
          height: rig?.height ?? REFERENCE_RIG.height,
        });
      }
    }
    if (u >= 1 && loco.walk === null) {
      facing = turnClip === null ? loco.to : turnClip.facing0 + turnClip.ratio * turnClip.c.turn;
      loco = null;
    }
    return out;
  };
  const fingersBent = [false, false];
  const applyPose = (now: number) => {
    if (vrm === null || rig === null) return;
    // her idle under her posture: a posture's own placements win, its plain hanging arms give way to the real ones
    const bones: Partial<Record<PoseBone, Euler>> =
      idle === null ? { ...posture().bones } : { ...clipAt(idle, now) };
    if (idle !== null)
      for (const [b, e] of Object.entries(posture().bones) as Array<[PoseBone, Euler]>)
        if (!isHang(b, e)) bones[b] = e;
    vrm.scene.rotation.y = baseYaw + facing;
    if (clip !== null) Object.assign(bones, clipAt(clip, now - clip.start));
    Object.assign(
      bones,
      dancing === null ? {} : danceAt(now - dancing),
      stepping === null ? {} : stepAt(now - stepping),
      locoAt(now, bones),
    );
    vrm.scene.position.x = travelX;
    vrm.scene.position.z = closer + travelZ;
    // a clip's finger shapes bend whatever finger bones this model has; they are not rig bones
    const shapes = bones as Record<string, Euler | undefined>;
    for (const [i, k] of FINGER_KEYS.entries()) {
      const shape = shapes[k];
      delete shapes[k];
      if (shape === undefined && !fingersBent[i]) continue;
      const side = i === 0 ? "left" : "right";
      const bent = fingerBones(
        side,
        shape ?? [0, 0, 0],
        (b) => vrm!.humanoid.getNormalizedBoneNode(b as VRMHumanBoneName) !== null,
      );
      for (const [b, e] of Object.entries(bent))
        vrm.humanoid.getNormalizedBoneNode(b as VRMHumanBoneName)?.rotation.set(e[0], e[1], e[2]);
      fingersBent[i] = shape !== undefined;
    }
    palms = shapes["palms"] ?? null;
    meet = shapes["meet"] ?? null;
    delete shapes["palms"];
    delete shapes["meet"];
    // the rig's work is redone only when the target changes (a held posture costs nothing per frame)
    const key = JSON.stringify(bones);
    if (key !== goalKey) {
      goalKey = key;
      const prepared = preparePose(rig, bones as Record<string, V3>);
      goal = prepared.pose;
      if (
        prepared.issues.length > 0 &&
        prepared.issues.some((i) => !issues.some((j) => j.bone === i.bone && j.kind === i.kind))
      )
        console.debug("[tessaya-body] pose corrected", prepared.issues);
      issues = prepared.issues;
      springing = true;
    }
    const dt = lastSpring === 0 ? 1000 / 30 : Math.min(100, now - lastSpring);
    lastSpring = now;
    let moving = false;
    for (const b of POSE_BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(b);
      if (!node) continue;
      const g = goal[b] ?? QI;
      const s = springs.get(b) ?? { q: g, w: [0, 0, 0] as V3 };
      // captured motion is already a body's own timing: her springs follow it closely
      const next = springing
        ? springStep(s, g, halfLifeOf(b) * (locoW > 0 ? 0.06 : pace), dt)
        : s;
      const done = settled(next, g);
      const shown = done ? { q: g, w: [0, 0, 0] as V3 } : next;
      if (!done) moving = true;
      springs.set(b, shown);
      node.quaternion.set(shown.q[0], shown.q[1], shown.q[2], shown.q[3]);
    }
    springing = moving;
    if (moving) lastMove = now;
    else lastSpring = 0;
    // the captured hips' place over where she stands (their sway and bob), back at rest as the capture fades out
    const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
    if (hipsNode !== null && restHips !== null) {
      if (locoHips !== null && locoW > 0)
        hipsNode.position.set(
          restHips.x + (locoHips[0] - restHips.x) * locoW,
          restHips.y + (locoHips[1] - restHips.y) * locoW,
          restHips.z + (locoHips[2] - restHips.z) * locoW,
        );
      else if (!hipsNode.position.equals(restHips)) hipsNode.position.copy(restHips);
    }
  };
  /** A foot standing on the floor stays where it was set down, whatever her body over it does (a turn, a blend). */
  const planted = [new THREE.Vector3(), new THREE.Vector3()];
  const plantedOn = [false, false];
  const footTurn = new THREE.Quaternion();
  const legA = new THREE.Vector3();
  const legB = new THREE.Vector3();
  const legC = new THREE.Vector3();
  let stance = false;
  const plantFeet = () => {
    if (locoW > 0) stance = true;
    for (const [k, side] of (["left", "right"] as const).entries()) {
      const leg = legs?.[side];
      // after a walk or turn her feet stay where they were set down (she stops as she stands), until she moves again
      const standing = locoW === 0 && stance && !posture().grounded;
      // in a turn scaled from the capture, a foot down on the floor is a foot planted (it pivots, never slides)
      const down =
        loco?.clip != null &&
        loco.walk === null &&
        leg !== undefined &&
        leg.end.getWorldPosition(legC).y - (vrm?.scene.position.y ?? 0) < sole + 0.015;
      if (leg === undefined || (!standing && (locoW === 0 || !(locoPlant[k] || down)))) {
        plantedOn[k] = false;
        continue;
      }
      if (!plantedOn[k]) {
        leg.end.getWorldPosition(planted[k]!);
        plantedOn[k] = true;
        continue;
      }
      // a leg that cannot reach where its foot was set down lets it go (the body has moved on: the next step)
      const long =
        leg.upper.getWorldPosition(legA).distanceTo(leg.lower.getWorldPosition(legB)) +
        legB.distanceTo(leg.end.getWorldPosition(legC));
      if (legA.distanceTo(planted[k]!) > 0.99 * long) {
        plantedOn[k] = false;
        continue;
      }
      leg.end.getWorldQuaternion(footTurn);
      reach(leg, planted[k]!, footTurn);
    }
  };

  const at = new THREE.Vector3();
  const worldOf = (b: VRMHumanBoneName) =>
    vrm?.humanoid.getRawBoneNode(b)?.getWorldPosition(at).clone();
  /** Any bone by name: a humanoid one, else a node of the model's own (a tail, an ear, his custom bones). */
  const boneAt = (name: string) =>
    worldOf(name as VRMHumanBoneName) ??
    vrm?.scene.getObjectByName(name)?.getWorldPosition(at).clone();
  /**
   * A bone's frame now, as regions are written in it: the model's axes at rest (facing +z, VRM 0.x turned to match),
   * turning with the bone from its bind pose. `q` takes that frame into the world.
   */
  const bindTurn = new WeakMap<THREE.Object3D, THREE.Quaternion>();
  const boneFrame = (name: string) => {
    const node =
      vrm?.humanoid.getRawBoneNode(name as VRMHumanBoneName) ?? vrm?.scene.getObjectByName(name);
    if (vrm === null || node == null) return null;
    let bind = bindTurn.get(node);
    if (bind === undefined) {
      bind = new THREE.Quaternion();
      // the skin's bind matrix holds its rest turn; a node no skin binds is taken as it stands (shortcut: rarely a region)
      vrm.scene.traverse((o) => {
        const sk = (o as THREE.SkinnedMesh).skeleton;
        const i = sk?.bones.indexOf(node as THREE.Bone) ?? -1;
        if (i >= 0)
          new THREE.Matrix4()
            .copy(sk!.boneInverses[i]!)
            .invert()
            .decompose(new THREE.Vector3(), bind!, new THREE.Vector3());
      });
      if (vrm.meta.metaVersion === "0") bind.premultiply(new THREE.Quaternion(0, 1, 0, 0));
      bindTurn.set(node, bind);
    }
    return {
      at: node.getWorldPosition(new THREE.Vector3()),
      q: node.getWorldQuaternion(new THREE.Quaternion()).multiply(bind.clone().invert()),
    };
  };
  /**
   * After the pose lands: set her on the floor when she stands, sits or lies (the rig keeps her hands and arms out of
   * her body, by this model's own measures). Corrects over a few frames and reports whether it is still moving.
   */
  const settleBody = (f: number): boolean => {
    if (vrm === null) return false;
    let moving = false;
    let groundTo = 0;
    if (posture().grounded) {
      let low = Infinity;
      for (const b of BODY_JOINTS) {
        const p = worldOf(b);
        if (p) low = Math.min(low, p.y);
      }
      // bones run through her middle: the lowest stays a little above the floor
      if (Number.isFinite(low)) groundTo = ground + (0.06 - low);
    } else {
      // standing: her lower foot is on the floor, whatever her hips or knees do (a lean, a dance, a clip)
      let low = Infinity;
      for (const b of ["leftFoot", "rightFoot", "leftToes", "rightToes"] as const) {
        const p = worldOf(b);
        if (p) low = Math.min(low, p.y);
      }
      if (Number.isFinite(low) && Number.isFinite(sole)) groundTo = ground + (sole - low);
    }
    if (Math.abs(groundTo - ground) > 0.003) {
      ground += (groundTo - ground) * f;
      moving = true;
    }
    vrm.scene.position.y = ground;
    return moving;
  };

  // where the camera aims and how far back it stands; eased so a posture change glides rather than cuts
  let camAim = { x: 0, y: 0, dist: 0 };
  const placeCamera = (f: number) => {
    if (shared !== undefined && !shared.stage.leads(shared.id)) return false;
    let want: { x: number; y: number; dist: number };
    if (framing === "body" || shared !== undefined) {
      // all of her (all of them on a shared stage), whatever the posture: fit the joints (plus head room) into view
      const pts =
        shared !== undefined
          ? shared.stage.points()
          : BODY_JOINTS.flatMap((b) => {
              const p = worldOf(b);
              return p ? [p] : [];
            });
      if (pts.length === 0) return false;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const pad = 0.12 * headY;
      const [x0, x1] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
      const y1 = Math.max(...ys) + pad * 1.4;
      // a panel over the bottom of the view: the view reaches lower, so all of her stays above it
      const y0 = y1 - (y1 - (Math.min(...ys) - pad * 0.6)) / (1 - insetBottom);
      const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      want = {
        x: (x0 + x1) / 2,
        y: (y0 + y1) / 2,
        dist: Math.max((y1 - y0) / 2 / v, (x1 - x0) / 2 / (v * camera.aspect)) + 0.3,
      };
    } else if (framing === "half") {
      // mid-thigh to the top of her head, lifted clear of whatever covers the bottom of the view
      const head = worldOf("head")?.y ?? headY;
      const hips = worldOf("hips")?.y ?? headY * 0.53;
      const knee = worldOf("leftLowerLeg")?.y ?? headY * 0.28;
      const top = head + 0.22 * headY;
      const span = top - (hips + knee) / 2;
      const bottom = top - span / (1 - insetBottom);
      const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      want = { x: worldOf("hips")?.x ?? 0, y: (top + bottom) / 2, dist: (top - bottom) / 2 / v };
    } else want = { x: 0, y: (worldOf("head")?.y ?? headY) - 0.08, dist: 1.4 };
    // a dead band, so her breath never nudges the camera
    const far =
      Math.abs(want.x - camAim.x) + Math.abs(want.y - camAim.y) + Math.abs(want.dist - camAim.dist);
    if (camAim.dist === 0) camAim = want;
    else if (far > 0.02) {
      camAim = {
        x: camAim.x + (want.x - camAim.x) * f,
        y: camAim.y + (want.y - camAim.y) * f,
        dist: camAim.dist + (want.dist - camAim.dist) * f,
      };
    }
    const lift = framing === "body" ? 0.02 * headY : 0.08;
    camera.position.set(
      camAim.x + Math.sin(camYaw) * Math.cos(camPitch) * camAim.dist,
      camAim.y + lift + Math.sin(camPitch) * camAim.dist,
      Math.cos(camYaw) * Math.cos(camPitch) * camAim.dist,
    );
    // the camera stays where he is: when she walks over she comes closer to him
    camera.lookAt(camAim.x, camAim.y, 0);
    return far > 0.02;
  };

  const frame = (now: number) => {
    raf = 0;
    if (disposed || !shown || !onScreen || vrm === null) return;
    const t0 = performance.now();
    const delta = lastFrame === 0 ? 1 / 30 : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    // face: blend toward the mood (or a word-timed effect's face) over BLEND_MS
    if (override !== null && now >= override.until) {
      override = null;
      setFace(faceWeights(mood.mood, mood.intensity), now);
    }
    const k = Math.min(1, (now - faceAt) / BLEND_MS);
    const keys = new Set([...Object.keys(faceFrom), ...Object.keys(faceTo)]) as Set<keyof Weights>;
    face = Object.fromEntries(
      [...keys].map((p) => [p, (faceFrom[p] ?? 0) + ((faceTo[p] ?? 0) - (faceFrom[p] ?? 0)) * k]),
    );

    // mouth: the line's track by its own clock, or the live level and aligned viseme from the vessel playing it
    let mouth: Weights = {};
    if (speech !== null) {
      const ms = now - speech.start;
      // an effect's face lasts until the end of the speech (G7 `until: endOfSpeech`)
      const until = speech.start + speech.end;
      if (ms > speech.end) speech = null;
      else mouth = mouthWeights(visemeAt(speech.track, ms) ?? "rest");
      for (const e of effects.filter((e) => now >= e.at)) {
        if (e.gesture !== undefined) gestures.push({ name: e.gesture, start: now });
        if (e.act !== undefined) doAct(e.act, now);
        if (e.face !== undefined) {
          const intimate = Object.hasOwn(INTIMATE_FACES, e.face)
            ? INTIMATE_FACES[e.face]
            : undefined;
          override =
            intimate === undefined
              ? { face: faceWeights(e.face, 1), until }
              : { ...intimate, until };
          setFace(override.face, now);
        }
      }
      effects = effects.filter((e) => now < e.at);
    } else if (level !== null) {
      if (now - level.at > LEVEL_HOLD_MS) level = null;
      else mouth = mouthWeights(level.viseme, level.value);
    }
    // a gesture's whole-face act (a yawn, a laugh) rises and falls with it, at its full natural reach
    let jawOpen = 0;
    for (const g of gestures) {
      const move = GESTURES[g.name];
      if (move?.act === undefined) continue;
      const env = actLevel(move.ms, now - g.start);
      for (const [k, v] of Object.entries(move.act.face) as Array<[keyof Weights, number]>)
        mouth[k] = Math.max(mouth[k] ?? 0, v * env);
      for (const sh of move.act.shapes)
        for (const name of shapeKeys.keys())
          if (sh.match.test(name)) shapes[name] = Math.max(shapes[name] ?? 0, sh.weight * env);
      jawOpen = Math.max(jawOpen, move.act.jaw * env);
    }

    // blink: a short close and open, every few seconds
    const b = now - blinkAt;
    const blink = b < BLINK_MS ? Math.sin((Math.PI * b) / BLINK_MS) : 0;

    // the intimate set eases toward where the layer (or a word-timed face) wants it
    const to = target();
    const f = 1 - Math.exp(-FOLLOW * delta);
    states = Object.fromEntries(
      INTIMATE_STATES.map((n) => [
        n,
        (states[n] ?? 0) + ((to.states[n] ?? 0) - (states[n] ?? 0)) * f,
      ]),
    );
    motion = {
      breath: motion.breath + (to.motion.breath - motion.breath) * f,
      breathHz: to.motion.breathHz,
      tremble: motion.tremble + (to.motion.tremble - motion.tremble) * f,
      arch: motion.arch + (to.motion.arch - motion.arch) * f,
    };
    applyPose(now);
    if (moveAgentHand(now)) lastMove = now;
    pullNow(now, delta * 1000);
    feelNerves(now);
    if (grip === null) giveToHand(now);
    // walking to or from him: steps while the distance closes, then she stands
    if (closer !== closerTo) {
      stance = false;
      const stride = WALK_SPEED * delta;
      closer =
        Math.abs(closerTo - closer) <= stride
          ? closerTo
          : closer + Math.sign(closerTo - closer) * stride;
      vrm.scene.position.z = closer + travelZ;
      if (closer === closerTo) stepping = null;
      lastMove = now;
    }
    // a tremble is a brief burst, not a state: held high, it settles to a faint quiver, and comes back only after calm
    if (motion.tremble > 0.2) {
      tremorSince ??= now;
      tremorCalm = null;
    } else if (tremorSince !== null) {
      tremorCalm ??= now;
      if (now - tremorCalm > TREMOR_REARM_MS) tremorSince = null;
    }
    const over = tremorSince === null ? 0 : Math.max(0, now - tremorSince - TREMOR_BURST_MS);
    const burst = 0.35 + 0.65 * Math.exp(-over / 800);
    const touched =
      touch === null
        ? 0
        : Math.sin(Math.PI * Math.min(1, (now - touch.at) / TOUCH_MS)) *
          (0.5 + 0.5 * Math.min(1, touch.strength));
    // a touch stirs her breath, settling over a few seconds: glad of it, slower and deeper; wary, quicker and shallower
    const glad = moodValence(mood.mood) * (0.5 + 0.5 * mood.intensity);
    const quick =
      touch === null
        ? 0
        : Math.min(1, (now - touch.at) / 300) *
          Math.exp(-(now - touch.at) / 4000) *
          (0.5 + 0.5 * Math.min(1, touch.strength));
    breathCycles +=
      (motion.breathHz * (1 + (0.8 - 0.6 * glad) * quick) * Math.min(100, now - breathAt)) / 1000;
    breathAt = now;
    const exhale = applyMotion(
      (n) => vrm!.humanoid.getNormalizedBoneNode(n),
      {
        ...motion,
        tremble: motion.tremble * burst,
        breath: Math.min(1, motion.breath + (0.6 + 0.3 * glad) * touched),
      },
      now / 1000,
      breathCycles,
    );
    // a touch, read at a glance: she turns to it and then to whoever touched her, leans into it when she is glad of
    // it or away and lifts her shoulders when not, and breathes deeper, all by how firm it was and how she feels
    const felt = touch === null ? 0 : Math.sin(Math.PI * Math.min(1, (now - touch.at) / TOUCH_MS));
    if (touch !== null && felt > 0) {
      const k = felt * (0.55 + 0.45 * Math.min(1, touch.strength));
      const u = Math.min(1, (now - touch.at) / TOUCH_MS);
      const node = (b: VRMHumanBoneName) => vrm!.humanoid.getNormalizedBoneNode(b);
      const from = (node("head") ?? vrm.scene).getWorldPosition(scratch);
      // first the touch, then (from a third of the way) whoever it came from: him at the camera unless a hand says
      const toward = (p: THREE.Vector3) => {
        const d = p.clone().sub(from);
        return {
          yaw: Math.max(-1.1, Math.min(1.1, Math.atan2(d.x, Math.max(0.05, d.z + 0.3)))),
          pitch: Math.max(-0.5, Math.min(0.35, Math.atan2(-d.y, 0.4))),
        };
      };
      const atTouch = toward(touch.point);
      const atThem = toward(touch.from ?? camera.position);
      const w = Math.max(0, Math.min(1, (u - 0.3) / 0.3));
      const yaw = atTouch.yaw + (atThem.yaw - atTouch.yaw) * w;
      const pitch = atTouch.pitch + (atThem.pitch - atTouch.pitch) * w;
      const neck = node("neck");
      const head = node("head");
      const chest = node("chest");
      const spine = node("spine");
      if (neck) neck.rotation.y += 0.45 * yaw * k;
      if (head) {
        head.rotation.y += 0.4 * yaw * k;
        head.rotation.x += 0.6 * pitch * k;
      }
      // the trunk follows the head round a little, and leans toward the touch or away from it by her mood
      const side = Math.sign(atTouch.yaw) || 1;
      if (spine) spine.rotation.y += 0.18 * atTouch.yaw * k;
      if (chest) {
        chest.rotation.x += (glad > 0 ? -0.1 * glad : 0.12 * -glad + 0.04) * k;
        chest.rotation.z += -side * (glad > 0 ? 0.08 * glad : -0.08 * -glad) * k;
      }
      // a quick flinch first, and the shoulders lift and stay up while she does not like it
      const lift =
        (0.12 * (0.4 + 0.6 * Math.exp(-(now - touch.at) / 250)) + 0.14 * Math.max(0, -glad)) * k;
      const ls = node("leftShoulder");
      const rs = node("rightShoulder");
      if (ls) ls.rotation.z += lift;
      if (rs) rs.rotation.z -= lift;
    }
    const added = stateWeights(
      states,
      style,
      exhale,
      (n) => own.has(n) || (sync !== null && SCULPTED.has(n)),
    );
    // drawn overlays only for the states the model can't show itself
    overlays?.set(
      own.size === 0
        ? states
        : Object.fromEntries(Object.entries(states).filter(([n]) => !own.has(n))),
    );

    const em = vrm.expressionManager;
    if (em !== undefined) {
      for (const n of own) em.setValue(n, states[n as keyof States] ?? 0);
      if (sync !== null) {
        const units = perfectSyncWeights(states, exhale);
        for (const u of SYNC_UNITS) {
          const name = sync.get(u.toLowerCase());
          if (name !== undefined) em.setValue(name, units[u] ?? 0);
        }
      }
      // a model's own body shapes: chest and belly rise on the inhale, skin flushes with her blush, hair dampens with sweat
      for (const [n, w] of [
        ["breath", motion.breath * (1 - exhale)],
        ["flush", states.blush ?? 0],
        ["hairDamp", states.sweat ?? 0],
      ] as const)
        if (bodyOwn.has(n)) em.setValue(n, w);
      // rolled-up eyes through the model's own lookAt (three-vrm: negative pitch looks up)
      if (vrm.lookAt) {
        const roll = own.has("eyesRoll") ? 0 : (states.eyesRoll ?? 0);
        const toTouch =
          touch !== null && felt > 0
            ? touch.point.clone().sub(vrm.scene.getWorldPosition(new THREE.Vector3()))
            : null;
        // listening, her eyes find him (the camera) wherever he is, with a small saccade at each blink
        const eye = worldOf("head") ?? new THREE.Vector3(0, headY, 0);
        const toHim = camera.position.clone().sub(eye);
        const himYaw = (Math.atan2(toHim.x, toHim.z) * 180) / Math.PI;
        const himPitch = (-Math.atan2(toHim.y, Math.hypot(toHim.x, toHim.z)) * 180) / Math.PI;
        const held = gazeHold !== null && now < gazeHold.until ? gazeHold : null;
        vrm.lookAt.yaw =
          toTouch !== null
            ? (Math.atan2(toTouch.x, 0.6) * 180) / Math.PI
            : held !== null
              ? held.yaw
              : himYaw + glance.yaw;
        vrm.lookAt.pitch =
          -25 * roll +
          (1 - roll) *
            (toTouch !== null ? -12 * felt : held !== null ? held.pitch : himPitch + glance.pitch);
      }
      for (const p of [
        "happy",
        "angry",
        "sad",
        "relaxed",
        "surprised",
        "aa",
        "ih",
        "ou",
        "ee",
        "oh",
        "blink",
        "blinkLeft",
      ] as const)
        em.setValue(
          p,
          Math.min(
            1,
            (face[p] ?? 0) + (mouth[p] ?? 0) + (added[p] ?? 0) + (p === "blink" ? blink : 0),
          ),
        );
      if (look !== null) em.setValue(look, 1);
      // his own mappings: a state or face drawn with the model's expressions
      for (const [target, use] of Object.entries(expMap)) {
        const v =
          (states as Record<string, number | undefined>)[target] ??
          (face as Record<string, number | undefined>)[target] ??
          0;
        for (const u of use)
          if (em.getExpression(u.name)) em.setValue(u.name, Math.min(1, v * u.weight));
          // a raw shape key (VRoid's Fcl_…) rather than an expression: driven directly after the update
          else if (shapeKeys.has(u.name))
            shapes[u.name] = Math.max(shapes[u.name] ?? 0, Math.min(1, v * u.weight));
      }
    }

    const jaw = vrm.humanoid.getNormalizedBoneNode("jaw");
    if (jaw) jaw.rotation.x += jawOpen;
    gestures = gestures.filter((g) => {
      const move = GESTURES[g.name];
      if (move === undefined || now - g.start >= move.ms) return false;
      for (const s of move.swings) {
        const node = vrm!.humanoid.getNormalizedBoneNode(s.bone);
        if (node) node.rotation[s.axis] += swingAt(s, move.ms, now - g.start);
      }
      lastMove = now;
      return true;
    });
    if (speech !== null || level !== null) lastMove = now;

    const wagging = now - kinAt < WAG_MS;
    const sec = now / 1000;
    for (const [i, e] of ears.entries())
      e.node.rotation.x = e.x - kin.earPitch + kin.earQuiver * Math.sin(sec * 31 + i * 1.7);
    for (const [i, t] of tails.entries()) {
      const fade = wagging ? Math.sin((Math.PI * (now - kinAt)) / WAG_MS) : 0;
      t.node.rotation.y =
        t.y +
        kin.tailAmp * fade * Math.sin((2 * Math.PI * kin.tailHz * (now - kinAt)) / 1000 - i * 0.6) +
        // a slow sway with her breath while she is stirred
        0.12 * motion.breath * Math.sin(Math.PI * motion.breathHz * sec - i * 0.5);
      t.node.rotation.x = t.x + kin.tailDroop / Math.max(1, tails.length);
    }
    for (const p of props.values()) if (p.on) p.mixer?.update(delta * p.rate);
    // her head follows her eyes to him a little, when nothing else turns it
    if (touch === null || felt === 0) {
      const head = vrm.humanoid.getNormalizedBoneNode("head");
      const eye = worldOf("head");
      if (head && eye) {
        const toHim = camera.position.clone().sub(eye);
        head.rotation.y += 0.3 * Math.max(-0.6, Math.min(0.6, Math.atan2(toHim.x, toHim.z)));
      }
    }
    if (mirrored) flipVrm0(vrm);
    vrm.update(delta);
    aimLock();
    // palms meet on her own hands, after everything else has posed the arms: the clip was authored on another body
    plantFeet();
    closePalms(now);
    // shape keys asked for by name go on after the expressions, which would otherwise reset the ones they bind
    for (const [name, w] of Object.entries({ ...shapes, ...morphHold }))
      for (const k of shapeKeys.get(name) ?? [])
        if (k.mesh.morphTargetInfluences) k.mesh.morphTargetInfluences[k.i] = w;
    shapes = {};
    if (mirrored) flipVrm0(vrm);
    const f2 = 1 - Math.exp(-4 * delta);
    if (settleBody(f2) || placeCamera(f2)) lastMove = now;
    if (drawHand(now)) lastMove = now;
    if (soft !== null && rig !== null) {
      const pos: Record<string, V3> = {};
      for (const b of CONTACT_BONES) {
        const p = worldOf(b);
        if (p) pos[b] = [p.x, p.y, p.z];
      }
      const own = softContacts(rig, pos, 3);
      // his hand gives her skin too, as firmly as he presses
      const his =
        handFrame !== null && handHeld && handFrame.pressure > 0.05
          ? [
              {
                at: handFrame.palm,
                normal: handFrame.normal.map((v) => -v) as unknown as V3,
                radius: handLength() * 0.5,
                depth: SOFT_DEPTH * 1.25 * handFrame.pressure,
              },
            ]
          : [];
      soft.set([...his, ...own]);
    }
    if (shared === undefined) renderer.render(scene, camera);
    frames++;
    const spent = performance.now() - t0;
    workMs += spent;
    // too slow for this device: drop a tier (never climbs back on its own within a session)
    slow = spent > SLOW_FRAME_MS ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 20 && tier > 0) {
      tier--;
      slow = 0;
      resize();
    }
    // her body moving gets the tier's full rate; a blink or a face alone needs no more than 30
    const bodyMoving =
      springing ||
      gestures.length > 0 ||
      dancing !== null ||
      stepping !== null ||
      handHeld ||
      now - lastMove < SETTLE_MS;
    if (active(now) || motion.tremble > 0.05)
      schedule(1000 / (bodyMoving ? TIERS[tier]!.fps : Math.min(30, TIERS[tier]!.fps)));
    else if (breathing()) schedule(1000 / Math.min(BREATH_FPS, TIERS[tier]!.fps));
    else {
      planBlink();
      // she has come to rest: tell the page what her body is doing now, once per settle
      if (!settledSent) {
        settledSent = true;
        options.onSettle?.(bodyState());
      }
    }
    if (active(now)) settledSent = false;
  };

  const schedule = (afterMs = 0) => {
    if (disposed || !shown || !onScreen) return;
    if (shared !== undefined) return shared.stage.wake(afterMs, shared.id);
    if (raf !== 0 || timer !== null) return;
    // half a frame early: the animation frame then lands on the intended vsync, not one after (uneven 16/33 ms steps)
    const wait = Math.max(0, afterMs - (performance.now() - lastFrame) - 8);
    timer = setTimeout(() => {
      timer = null;
      raf = requestAnimationFrame(frame);
    }, wait);
  };
  const invalidate = () => schedule(0);

  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  const planBlink = () => {
    if (blinkTimer !== null || disposed) return;
    const fire = () => {
      // a held blink comes the moment the hold lets go, as a person's does
      const wait = (holds["blink"] ?? 0) - performance.now();
      if (wait > 0) return void (blinkTimer = setTimeout(fire, wait));
      blinkTimer = null;
      blinkAt = performance.now();
      // a saccade hidden in the blink: a degree or two, mostly back toward him
      if (!held("saccade"))
        glance = { yaw: (Math.random() - 0.5) * 4, pitch: (Math.random() - 0.5) * 2.5 };
      invalidate();
    };
    blinkTimer = setTimeout(fire, 2500 + Math.random() * 3500);
  };

  const setFace = (to: Weights, now = performance.now()) => {
    faceFrom = face;
    faceTo = to;
    faceAt = now;
    invalidate();
  };

  const loadModel = async (persona: string, url: string) => {
    if (model === url) return;
    model = url;
    const gltf = await loader.loadAsync(url);
    if (disposed || model !== url) return VRMUtils.deepDispose(gltf.scene);
    const next = gltf.userData["vrm"] as VRM | undefined;
    if (next === undefined) return;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(next);
    baseYaw = next.scene.rotation.y;
    if (vrm !== null) {
      root.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }
    vrm = next;
    overlays?.dispose();
    style = styleOf(next);
    // cel shading adds every light at full strength, so anime models get a gentler stage
    const k = style === "anime" ? 0.8 : 1;
    fill.intensity = 1.1 * k;
    sun.intensity = 1.5 * k;
    rim.intensity = 1.3 * k;
    overlays = makeOverlays(next, style);
    soft = softenOnContact(next.scene);
    // states the model carries itself as custom expressions win over the built ones
    own = new Set(INTIMATE_STATES.filter((n) => next.expressionManager?.getExpression(n)));
    const names = new Map(
      (next.expressionManager?.expressions ?? []).map((e) => [
        e.expressionName.toLowerCase(),
        e.expressionName,
      ]),
    );
    sync = names.has("jawopen") && names.has("eyeblinkleft") ? names : null;
    mirrored = mirroredOf(next);
    idle = null;
    gaits = null;
    restHips = next.humanoid.getNormalizedBoneNode("hips")?.position.clone() ?? null;
    legs = legsOf(next);
    facingOf = facingsOf(next);
    void bakeIdle(next, mirrored).then(() => bakeGaits(next, mirrored));
    shapeKeys = new Map();
    next.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      for (const [name, i] of Object.entries(mesh.morphTargetDictionary ?? {}))
        shapeKeys.set(name, [...(shapeKeys.get(name) ?? []), { mesh, i }]);
    });
    morphHold = {};
    rig = rigOf(next);
    const samples = skinSamples(next);
    rig = { ...rig, proxies: fitProxies(rig, samples) };
    arms = armsOf(next, samples, rig.height);
    skins = skinsOf(next);
    humanOf = new Map(
      Object.entries(next.humanoid.humanBones).flatMap(([n, b]) =>
        b?.node ? [[b.node, n] as const] : [],
      ),
    );
    manifest = manifestOf(rig, {
      expressions: (next.expressionManager?.expressions ?? []).map((e) => e.expressionName),
      morphs: [...shapeKeys.keys()],
      springChains: next.springBoneManager?.joints.size ?? 0,
    });
    springs = new Map();
    goalKey = "";
    bodyOwn = new Set(BODY_EXPRESSIONS.filter((n) => next.expressionManager?.getExpression(n)));
    const humanoid = new Set(Object.values(vrm.humanoid.humanBones).map((b) => b?.node));
    ears = [];
    tails = [];
    vrm.scene.traverse((o) => {
      if (humanoid.has(o) || !(o as THREE.Bone).isBone) return;
      if (/ear/i.test(o.name) && !/(earring|hear|pearl|wear)/i.test(o.name))
        ears.push({ node: o, x: o.rotation.x });
      else if (/tail/i.test(o.name) && !/ponytail|twintail/i.test(o.name))
        tails.push({ node: o, x: o.rotation.x, y: o.rotation.y });
    });
    vrm.scene.name = persona;
    root.add(vrm.scene);
    // frame the head and shoulders, whatever the model's height
    vrm.scene.updateMatrixWorld(true);
    // frame her whatever her height: "body" is top of the head to the knees, so every part can be touched
    headY = vrm.humanoid.getRawBoneNode("head")?.getWorldPosition(new THREE.Vector3()).y ?? 1.4;
    camAim = { x: 0, y: 0, dist: 0 };
    ground = 0;
    closer = closerTo = 0;
    placeCamera(1);
    sole = Math.min(
      ...(["leftFoot", "rightFoot", "leftToes", "rightToes"] as const).flatMap((b) => {
        const p = worldOf(b);
        return p ? [p.y] : [];
      }),
    );
    outfit = new Map();
    vrm.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).isMesh ? [(o as THREE.Mesh).material].flat() : [];
      for (const m of mats) {
        const piece = outfitPiece(m.name);
        if (piece) outfit.set(piece, [...(outfit.get(piece) ?? []), o]);
      }
    });
    options.onOutfit?.([...outfit.keys()]);
    lastMove = performance.now();
    wake();
    invalidate();
  };

  const dropProp = (id: string) => {
    const old = props.get(id);
    if (old === undefined) return;
    old.mixer?.stopAllAction();
    old.object.removeFromParent();
    VRMUtils.deepDispose(old.object);
    props.delete(id);
  };

  /** A prop: loaded once per url onto its bone, then only its state changes; no url puts it away. */
  const putProp = async (c: Extract<BodyCue, { kind: "prop" }>) => {
    if (c.url === undefined) {
      dropProp(c.id);
      return invalidate();
    }
    let p = props.get(c.id);
    if (p === undefined || p.url !== c.url) {
      if (vrm === null) return;
      const gltf = await loader.loadAsync(c.url);
      if (disposed) return VRMUtils.deepDispose(gltf.scene);
      dropProp(c.id);
      // a prop's `attach` node is its grip: that point sits on the bone
      const grip = gltf.scene.getObjectByName("attach");
      if (grip) {
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.position.sub(grip.getWorldPosition(new THREE.Vector3()));
      }
      vrm.humanoid.getNormalizedBoneNode(c.bone ?? "rightHand")?.add(gltf.scene);
      const mixer = gltf.animations.length > 0 ? new THREE.AnimationMixer(gltf.scene) : null;
      for (const clip of gltf.animations) mixer?.clipAction(clip).play();
      p = { url: c.url, object: gltf.scene, mixer, on: false, rate: 1 };
      props.set(c.id, p);
    }
    p.on = c.on ?? p.on;
    // its own animation runs faster with speed and with intensity
    p.rate = (c.speed ?? 1) * (0.5 + (c.intensity ?? 0.5));
    lastMove = performance.now();
    invalidate();
  };

  const stopAll = () => {
    for (const p of props.values()) p.on = false;
    // she stops where she is: no dancing or walking on, and a held scene posture lets go
    dancing = stepping = null;
    if (loco?.walk != null)
      options.onWalk?.({
        metres: 0,
        heading: facing,
        done: true,
        height: rig?.height ?? REFERENCE_RIG.height,
      });
    loco = null;
    clip = null;
    closerTo = closer;
    if (scenePose !== null) setPose(performance.now());
    scenePose = null;
    speech = null;
    level = null;
    effects = [];
    gestures = [];
    override = null;
    gazeHold = null;
    for (const t of seqTimers) clearTimeout(t);
    seqTimers = [];
    statesTo = {};
    motionTo = STILL;
    setFace(faceWeights("neutral", 0));
  };

  const hideNow = () => {
    shown = false;
    canvas.hidden = true;
    speech = null;
    level = null;
    gestures = [];
    if (timer !== null) clearTimeout(timer);
    if (raf !== 0) cancelAnimationFrame(raf);
    timer = null;
    raf = 0;
  };

  /** Something she does with her own body: a held posture, a gesture, a walk toward or away from him, or a dance. */
  const doAct = (act: keyof typeof ACTS, now: number) => {
    const a: {
      posture?: PostureName | "auto";
      gesture?: string;
      closer?: number;
      steps?: boolean;
      dance?: boolean;
    } = ACTS[act];
    if (a.posture !== undefined) {
      setPose(now);
      scenePose = a.posture === "auto" ? null : a.posture;
    }
    if (a.gesture !== undefined) gestures.push({ name: a.gesture, start: now });
    if (a.closer !== undefined) closerTo = Math.max(-0.4, Math.min(0.6, closer + a.closer));
    if (a.steps === true && closerTo !== closer) stepping = now;
    dancing = a.dance === true ? now : null;
    wake(now);
  };

  /** Lays an agent's hand on a part of her: found on her surface from his side, the way he would reach it. */
  const startAgentTouch = (
    c: {
      part: string;
      motion: HandMotion;
      pressure: number;
      ms: number;
      pull?: readonly [number, number, number];
    },
    now: number,
  ) => {
    const region = sense.regions.get(c.part);
    if (region === undefined) return;
    // a pack region without a reach is met on its own bone, from in front of her
    const r = region.reach ?? {
      from: region.anchor.bone,
      to: region.anchor.to ?? region.anchor.bone,
      at: 0.5,
      up: 0,
      dir: [0, 0, 1] as const,
    };
    const boneName = r.at < 0.5 ? r.from : r.to;
    const bone =
      vrm?.humanoid.getRawBoneNode(boneName as VRMHumanBoneName) ??
      vrm?.scene.getObjectByName(boneName) ??
      null;
    const a = boneAt(r.from) ?? worldOf("upperChest") ?? worldOf("chest");
    const b = boneAt(r.to) ?? a;
    if (vrm === null || a === undefined || b === undefined) return;
    vrm.scene.updateMatrixWorld(true);
    // a region set off its bone is met at its own centre, from the side it sits on
    const off = region.reach === undefined ? region.anchor.offset : undefined;
    const frame = off === undefined ? null : boneFrame(region.anchor.bone);
    const out = frame === null ? null : new THREE.Vector3(...off!).applyQuaternion(frame.q);
    const p =
      frame === null
        ? a.lerp(b, r.at).add(new THREE.Vector3(0, r.up * (rig?.height ?? 1.6), 0))
        : frame.at.clone().add(out!);
    const side =
      out !== null && out.length() > 0.01
        ? out.clone().normalize()
        : new THREE.Vector3(...r.dir).normalize();
    // reached from that part's own side, from a little way off her
    const from = p.clone().addScaledVector(side, 0.6);
    ray.set(from, p.clone().sub(from).normalize());
    const hit = ray.intersectObject(vrm.scene, true).find((h) => h.object.visible);
    const normal = hit !== undefined ? surfaceNormal(hit) : from.clone().sub(p).normalize();
    const up = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const along = up
      .clone()
      .sub(normal.clone().multiplyScalar(up.dot(normal)))
      .normalize();
    // fingers laid flat on a curved part (a cheek, the jaw, a shoulder) would sink in: lift the hand off by the most any
    // point along them is inside her (a point is inside when the nearest surface out from it is one it would leave)
    const landed = hit?.point ?? p;
    const sides = new Map<THREE.Material, THREE.Side>();
    vrm.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) if (!sides.has(x)) sides.set(x, x.side);
    });
    for (const x of sides.keys()) x.side = THREE.DoubleSide;
    let lift = 0;
    for (const k of [0.35, 0.7, 1]) {
      const q = landed.clone().addScaledVector(along, k * handLength());
      ray.set(q, normal);
      const inside = ray
        .intersectObject(vrm.scene, true)
        .find((h) => h.object.visible && !isHair(h.object) && h.face != null);
      if (inside === undefined || inside.distance > 0.1) continue;
      const n = inside.face!.normal.clone().transformDirection(inside.object.matrixWorld);
      if (n.dot(normal) > 0) lift = Math.max(lift, inside.distance);
    }
    for (const [x, side] of sides) x.side = side;
    // she reacts to a hand arriving from that side (another persona's on a shared stage, his otherwise)
    if (c.motion !== "grab") touch = { at: now, point: landed.clone(), strength: c.pressure, from };
    // a new touch starts where it lands: the drawn hand does not glide there through her body from the last one
    handEuro = null;
    drawnAt = 0;
    agentTouch = {
      start: now,
      part: c.part,
      motion: c.motion,
      pressure: c.pressure,
      ms: c.ms,
      hit: hit?.point.clone() ?? p,
      normal,
      along,
      lift,
      bone,
      unbone: bone?.matrixWorld.clone().invert() ?? new THREE.Matrix4(),
    };
    // the nerves under the hand fire, wherever it actually landed on her
    nerveRegion = (hit && regionOf(hit)) ?? c.part;
    fired.clear();
    if (c.motion === "grab" && hit !== undefined) {
      startGrab(hit, now);
      // her frame to the world's: she faces +z with her left +x, turned however her body stands
      if (grip !== null && c.pull !== undefined)
        grip.pull
          .set(...c.pull)
          .applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion()));
    }
    wake(now);
  };
  /** The agent's hand this frame, as the same hand frame the pointer makes; false once its touch is over. */
  const moveAgentHand = (now: number): boolean => {
    if (agentTouch === null) return false;
    const a = agentTouch;
    // a frame's clock can trail the cue's by a frame: that is the touch's start, not before it
    const h = agentHandAt(a.motion, a.pressure, a.ms, Math.max(0, now - a.start));
    if (h === null) {
      agentTouch = null;
      handHeld = false;
      if (grip !== null) endGrab();
      return false;
    }
    if (a.motion === "grab") {
      if (grip === null) return true;
      // the pull goes out over the first 40% of the touch (minimum jerk), holds, and lets go at the end
      const x = Math.min(1, (now - a.start) / (0.4 * a.ms));
      moveGrab(
        grip.from.clone().addScaledVector(grip.pull, x * x * x * (10 - 15 * x + 6 * x * x)),
        now,
      );
      return true;
    }
    // her reflex and her reaction move the part under the hand: it rides that bone instead of staying where she was
    follow.identity();
    if (a.bone !== null) follow.multiplyMatrices(a.bone.matrixWorld, a.unbone);
    const normal = scratch.copy(a.normal).transformDirection(follow);
    const at = a.hit
      .clone()
      .addScaledVector(a.along, h.along * 0.05 * (rig?.height ?? 1.6))
      .applyMatrix4(follow)
      .addScaledVector(normal, a.lift);
    handFrame = pointerHand({
      at: now,
      hit: [at.x, at.y, at.z],
      normal: [normal.x, normal.y, normal.z],
      pressure: h.pressure,
      pressed: h.pressure > 0.02,
      fingertip: h.fingertip,
      source: "agent",
    });
    handEuro = euroStep(handEuro, handFrame.palm, now);
    handHeld = true;
    return true;
  };
  /**
   * Her nerves, each frame a hand is on her (nothing at rest): the region under it fires (bodySense.ts), and the reflex
   * arcs that firing sets off act on her body after their own latency, before any word reaches her brain.
   */
  const feelNerves = (now: number) => {
    const own =
      selfTouch === null
        ? []
        : [
            {
              region: "hand",
              ...contactFeel({
                impact: selfTouch.impact,
                sinceMs: now - selfTouch.since,
                depth: selfTouch.depth,
                areaCm2: selfTouch.area * 1e4,
              }),
            },
          ];
    const on = handFrame !== null && handHeld && nerveRegion !== null;
    if (!on && own.length > 0) {
      const step = fire(sense, nerves, own, now);
      nerves = step.state;
      const f = feltOf(step.rates)[0];
      if (f !== undefined) nerveFelt = { intensity: f.intensity, kind: f.kind, cmPerS: 0 };
      return;
    }
    if (!on && nerves.at === 0) return;
    if (!on) {
      nerves = fire(sense, nerves, [], now).state;
      // her skin forgets the touch once it is no longer worn or raw, and the next touch is new
      if (Object.keys(nerves.sites).length === 0) nerves = NO_SENSE;
      fired.clear();
      nerveFelt = null;
      return;
    }
    const h = handFrame!;
    const cmPerS = handEuro === null ? 0 : Math.hypot(...handEuro.dx) * 100;
    const step = fire(
      sense,
      nerves,
      [
        {
          region: nerveRegion!,
          pressure: h.pressure,
          cmPerS,
          areaCm2: handContact(h, handLength()).area,
          ...(grip === null
            ? {}
            : {
                stretch: grip.stretch,
                // a hand on her clothes or hair meets her skin only through them
                pressure: grip.kind === "skin" ? h.pressure : 0.2,
              }),
        },
        ...own,
      ],
      now,
    );
    nerves = step.state;
    const f = feltOf(step.rates)[0];
    nerveFelt =
      f === undefined
        ? nerveFelt
        : { intensity: f.intensity, kind: f.kind, cmPerS: Math.round(cmPerS * 10) / 10 };
    for (const r of reflexesOf(sense, step.levels)) {
      const key = `${r.id}@${r.region}`;
      if (fired.has(key)) continue;
      fired.add(key);
      const t = now + r.latencyMs;
      if (r.action === "withdraw" || r.action === "flinch") {
        reflexAt = t;
        reflexGain = 0.6 * r.strength;
      } else if (r.action === "leanIn") leanAt = t;
      else if (handFrame !== null)
        touch = {
          at: t - TOUCH_MS * 0.1,
          point: new THREE.Vector3(...handFrame.palm),
          strength: handFrame.pressure,
        };
    }
  };
  /** Her body gives to the hand on her: the part under it turns away by how firmly, more for a reflex. */
  const pickGive = (pos: Record<string, V3>, bone: string): Record<string, V3> =>
    Object.fromEntries(
      Object.entries(pos).filter(([b]) => b === bone || GIVE_CHILD[bone]?.includes(b) === true),
    );
  const giveToHand = (now: number) => {
    if (vrm === null || handFrame === null || !handHeld) {
      giving = null;
      return;
    }
    const reflex =
      Math.max(0, Math.sin(Math.PI * Math.min(1, (now - reflexAt) / REFLEX_MS))) * reflexGain;
    // leaning into a caress: she gives toward the hand instead of away, easing in over a second
    const lean = Math.max(0, Math.sin(Math.PI * Math.min(1, (now - leanAt) / 1200)));
    const pos: Record<string, V3> = {};
    for (const b of CONTACT_BONES) {
      const w = worldOf(b);
      if (w) pos[b] = [w.x, w.y, w.z];
    }
    // one part gives for the whole of a contact: re-choosing the nearest each frame let two parts trade it, and shake
    const only = giving === null ? pos : pickGive(pos, giving.bone);
    const raw = yieldTo(only, handFrame.palm, handFrame.normal, handFrame.pressure, reflex);
    if (raw === null) return;
    const k = 1 - Math.exp(-Math.max(0, now - (giving?.at ?? now)) / GIVE_TAU_MS);
    giving =
      giving === null
        ? { bone: raw.bone, angle: raw.angle * 0.2, at: now }
        : { bone: giving.bone, angle: giving.angle + (raw.angle - giving.angle) * k, at: now };
    const give = { ...raw, angle: giving.angle };
    const node = vrm.humanoid.getNormalizedBoneNode(give.bone as VRMHumanBoneName);
    if (!node?.parent) return;
    // a firm push on her trunk held past a moment takes her off balance: she steps with it, back or forward
    const trunk = give.bone === "spine" && handFrame.pressure > 0.75;
    pushSince = trunk ? (pushSince ?? now) : null;
    if (pushSince !== null && now - pushSince > PUSH_STEP_MS && stepping === null) {
      const into = new THREE.Vector3(...handFrame.normal).applyQuaternion(
        vrm.scene.getWorldQuaternion(new THREE.Quaternion()).invert(),
      );
      if (Math.abs(into.z) > 0.5) {
        closerTo = Math.max(-0.4, Math.min(0.6, closer + Math.sign(into.z) * 0.08));
        stepping = now;
        pushSince = null;
      }
    }
    // the turn is in her world: carried into the bone's parent frame, then added to its pose
    const parent = node.parent.getWorldQuaternion(new THREE.Quaternion());
    const turn = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(...give.axis),
      // braced (guarded), she gives less
      give.angle * (1 - 1.6 * lean) * (1 - 0.6 * braced()),
    );
    node.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
  };
  /**
   * A hand closes on her at `hit`: on a lock of hair, a fold of her clothes, an accessory, or her skin. What it holds
   * is found from what it met (a spring-bone joint near it, the mesh and material names), and the bone a pull acts
   * through from where that hangs on her.
   */
  const startGrab = (hit: THREE.Intersection, now: number) => {
    if (vrm === null) return;
    let lock: { bone: THREE.Object3D; child: THREE.Object3D | null; d: number } | null = null;
    const w = new THREE.Vector3();
    for (const j of vrm.springBoneManager?.joints ?? []) {
      const d = j.bone.getWorldPosition(w).distanceTo(hit.point);
      if (d < 0.08 && (lock === null || d < lock.d)) lock = { bone: j.bone, child: j.child, d };
    }
    const humanOf = new Map<THREE.Object3D, string>();
    for (const [name, b] of Object.entries(vrm.humanoid.humanBones))
      if (b?.node) humanOf.set(b.node, name);
    // a lock hangs from the bone it is parented to (hair from her head, a skirt from her hips)
    let hangs: string | null = null;
    for (let o = lock?.bone.parent ?? null; o !== null && hangs === null; o = o.parent)
      hangs = humanOf.get(o) ?? null;
    const mats = [(hit.object as THREE.Mesh).material].flat();
    const names = `${hit.object.name} ${mats.map((m) => m?.name ?? "").join(" ")} ${lock?.bone.name ?? ""}`;
    const kind = grabKindOf(names, lock !== null);
    const pos = Object.fromEntries(
      BODY_JOINTS.flatMap((b) => {
        const q = worldOf(b);
        return q ? [[b, [q.x, q.y, q.z] as V3]] : [];
      }),
    );
    const root =
      (hangs !== null ? pullRoot(hangs) : null) ??
      nearestRoot([hit.point.x, hit.point.y, hit.point.z], pos);
    const rootNode =
      root === null ? null : vrm.humanoid.getNormalizedBoneNode(root as VRMHumanBoneName);
    if (root === null || !rootNode) return;
    rootNode.updateWorldMatrix(true, false);
    const under = regionOf(hit);
    grip = {
      kind,
      root,
      region: kind === "hair" && sense.regions.has("hair") ? "hair" : (under ?? root),
      local: rootNode.worldToLocal(hit.point.clone()),
      lock: kind === "skin" ? null : (lock?.bone ?? null),
      lockChild: kind === "skin" ? null : (lock?.child ?? null),
      hand: hit.point.clone(),
      from: hit.point.clone(),
      pull: new THREE.Vector3(),
      speed: 0,
      at: now,
      turns: new Map(),
      force: 0,
      stretch: 0,
      hurtSince: null,
      free: false,
    };
    nerveRegion = grip.region;
    fired.clear();
    wake(now);
  };
  /** Moves the holding hand to `to` (world): how fast it went is how hard it yanks. */
  const moveGrab = (to: THREE.Vector3, now: number) => {
    if (grip === null) return;
    const dt = Math.max(1, now - grip.at) / 1000;
    const v = to.distanceTo(grip.hand) / dt;
    grip.speed += (v - grip.speed) * Math.min(1, dt / 0.08);
    grip.hand.copy(to);
    grip.at = now;
    wake(now);
  };
  const endGrab = () => {
    grip = null;
    wrapTurns = null;
    handHeld = false;
    if (handFrame !== null) handFrame = { ...handFrame, at: performance.now() };
  };
  /**
   * The pull, each frame a hand holds her: through what it holds into her bones (pullOn), eased in so it never
   * jitters; what they cannot give stretches what is grip, and her nerves feel that. Past its break force, after a
   * pull that hurts too long, or when she wants to, she pulls free.
   */
  const pullNow = (now: number, dt: number) => {
    if (vrm === null || grip === null) return;
    const g = grip;
    const rootNode = vrm.humanoid.getNormalizedBoneNode(g.root as VRMHumanBoneName);
    if (!rootNode) return endGrab();
    rootNode.updateWorldMatrix(true, false);
    const anchor = rootNode.localToWorld(g.local.clone());
    const pos: Record<string, V3> = {};
    for (const b of ["hips", "spine", "chest", "upperChest", "neck", "head", g.root]) {
      const n = vrm.humanoid.getNormalizedBoneNode(b as VRMHumanBoneName);
      const q = n?.getWorldPosition(new THREE.Vector3());
      if (q) pos[b] = [q.x, q.y, q.z];
    }
    for (const side of ["left", "right"])
      for (const part of ["Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg"]) {
        const q = vrm.humanoid
          .getNormalizedBoneNode(`${side}${part}` as VRMHumanBoneName)
          ?.getWorldPosition(new THREE.Vector3());
        if (q) pos[`${side}${part}`] = [q.x, q.y, q.z];
      }
    const hurting = (nerves.sites[g.region]?.sens ?? 0) > 0 && g.stretch > 0.6;
    g.hurtSince = hurting ? (g.hurtSince ?? now) : null;
    const answer = pullOn(
      { kind: g.kind, root: g.root, anchor: [anchor.x, anchor.y, anchor.z] },
      pos,
      [g.hand.x, g.hand.y, g.hand.z],
      g.speed,
      {
        free: g.free || (g.hurtSince !== null && now - g.hurtSince > PULL_HURT_MS),
        stiff: braced(),
      },
    );
    g.force = answer.force;
    if (answer.broke) {
      // she is free: a pull back from it, a startled face, and her nerves let go
      reflexAt = now;
      reflexGain = 0.6;
      override = { face: faceWeights(g.free ? "annoyed" : "surprised", 0.7), until: now + 900 };
      setFace(override.face, now);
      return endGrab();
    }
    g.stretch = answer.stretch;
    const k = 1 - Math.exp(-dt / PULL_TAU_MS);
    const seen = new Set<string>();
    for (const t of answer.turns) {
      seen.add(t.bone);
      const s = g.turns.get(t.bone) ?? { axis: new THREE.Vector3(...t.axis), angle: 0 };
      s.axis.lerp(new THREE.Vector3(...t.axis), k).normalize();
      s.angle += (t.angle - s.angle) * k;
      g.turns.set(t.bone, s);
    }
    for (const [bone, s] of g.turns) if (!seen.has(bone)) s.angle *= 1 - k;
    for (const [bone, s] of g.turns) {
      const node = vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
      if (!node?.parent) continue;
      const parent = node.parent.getWorldQuaternion(new THREE.Quaternion());
      const turn = new THREE.Quaternion().setFromAxisAngle(s.axis, s.angle);
      node.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
      node.updateWorldMatrix(false, true);
    }
    // the hand stays on what it holds, wherever her give has carried it, fingers closed round it
    rootNode.updateWorldMatrix(true, false);
    const at = rootNode.localToWorld(g.local.clone());
    const bonePos = rootNode.getWorldPosition(new THREE.Vector3());
    const out = at.clone().sub(bonePos);
    const r = out.length();
    const L = handLength();
    wrapTurns = wrapAround(
      g.kind === "hair" || g.kind === "accessory" || g.lock !== null
        ? 0.012
        : Math.min(0.12, Math.max(0.02, r)),
      FINGER_SHARES.map((x) => x * L * 0.42),
      L * FINGER_THICK,
    );
    const n = r > 1e-4 ? out.divideScalar(r) : new THREE.Vector3(0, 0, 1);
    handFrame = {
      ...pointerHand({
        at: now,
        hit: [at.x, at.y, at.z],
        normal: [n.x, n.y, n.z],
        pressure: 0.6,
        pressed: true,
        fingertip: false,
        source: handFrame?.source ?? "pointer",
      }),
      curl: 1,
    };
    handEuro = euroStep(handEuro, handFrame.palm, now);
    handHeld = true;
    lastMove = now;
  };
  /** A lock of hair or a ribbon held: its joint turns so it runs to the hand, after the spring bones have moved. */
  const aimLock = () => {
    if (grip?.lock == null || grip.lockChild === null || grip.lock.parent === null) return;
    const a = grip.lock.getWorldPosition(new THREE.Vector3());
    const b = grip.lockChild.getWorldPosition(new THREE.Vector3());
    const want = grip.hand.clone().sub(a);
    if (want.lengthSq() < 1e-8 || b.distanceToSquared(a) < 1e-8) return;
    const q = new THREE.Quaternion().setFromUnitVectors(b.sub(a).normalize(), want.normalize());
    const parent = grip.lock.parent.getWorldQuaternion(new THREE.Quaternion());
    grip.lock.quaternion.premultiply(parent.clone().invert().multiply(q).multiply(parent));
    grip.lock.updateMatrixWorld(true);
  };
  const playClip = (c: Extract<BodyCue, { kind: "clip" }>, now: number) => {
    setPose(now);
    const held = { ...c, start: now };
    clip = held;
    // a direct pose asked to arrive in `ms`: her springs take that long instead of her own pace
    pace = c.ms === undefined ? 1 : c.ms / 450;
    // a stream's frame: if no newer frame comes within its lapse, she takes her own posture back
    if (lapse !== null) clearTimeout(lapse);
    lapse =
      c.lapseMs === undefined
        ? null
        : setTimeout(() => {
            lapse = null;
            if (clip !== held) return;
            setPose(performance.now());
            invalidate();
          }, c.lapseMs);
    wake(now);
    invalidate();
  };
  const cue = (raw: unknown) => {
    const c: BodyCue | null = parseCue(raw);
    if (c === null || disposed) return;
    const now = performance.now();
    switch (c.kind) {
      case "show":
        shown = true;
        canvas.hidden = false;
        resize();
        return;
      case "hide":
        return hideNow();
      case "model":
        return void loadModel(c.persona, c.url).catch(() => {
          model = null;
        });
      case "speaker":
        // one body per page today: the speaker switch turns her toward the one talking, and back
        if (vrm !== null && vrm.scene.name !== c.persona)
          gestures.push({ name: "tilt", start: now });
        return invalidate();
      case "mood": {
        // the page re-sends her mood every few seconds: an unchanged one does nothing at all (no face blend, no frame)
        const key = JSON.stringify([c.mood, c.intensity, c.states, c.motion, c.look]);
        if (key === moodKey) return;
        mood = { mood: c.mood, intensity: c.intensity };
        const next = postureFor(c);
        if (next !== affectPose) {
          if (scenePose === null && clip === null) setPose(now);
          affectPose = next;
        }
        wake(now);
        moodKey = key;
        kin = beastkin(c);
        kinAt = now;
        look = c.look ?? null;
        statesTo = c.states ?? {};
        motionTo = c.motion ?? STILL;
        invalidate();
        if (override === null) setFace(faceWeights(c.mood, c.intensity), now);
        return;
      }
      case "pose":
        setPose(now);
        scenePose = c.pose === "auto" ? null : c.pose;
        wake(now);
        return invalidate();
      case "act":
        doAct(c.act, now);
        return invalidate();
      case "clip":
        // a library move playing its physics-trained version keeps it to the end: that move's own clips wait
        if (baked !== null && c.id.startsWith(`${baked.id}-`) && now < baked.until) return;
        return playClip(c, now);
      case "baked": {
        // loaded the first time one is asked for; until then (or with none for this entry) the renderer's clip plays
        const at = now;
        void import("@t3tools/tessaya-shared/bodyBakedClips").then(({ bakedClip }) => {
          const b = bakedClip(c.entry);
          if (b === undefined || disposed) return;
          baked = { id: c.id, until: at + b.ms };
          const grounded = clip?.id.startsWith(`${c.id}-`) === true && clip.grounded;
          playClip(
            {
              kind: "clip",
              id: c.id,
              fps: b.fps,
              loop: false,
              grounded,
              frames: b.frames,
              lapseMs: b.ms + 100,
            },
            at,
          );
        });
        return;
      }
      case "zones":
      case "sense": {
        const pack = c.kind === "sense" ? c.pack : zonesPack(c.zones);
        if (c.kind === "zones" && c.dropped !== undefined)
          console.warn(
            `[tessaya-body] ${c.dropped} touch regions past ${c.zones.length} were not kept`,
          );
        packs = [...packs.filter((p) => p.id !== pack.id), pack];
        sense = mergeSense(packs, true);
        return;
      }
      case "hand":
        startAgentTouch(c, now);
        return invalidate();
      case "free":
        if (grip !== null) grip.free = true;
        wake(now);
        return invalidate();
      case "gaze":
        gazeHold = { yaw: c.x * 30, pitch: -c.y * 20, until: now + c.ms };
        lastMove = now;
        // her eyes come back to him when it ends, even if nothing else is moving then
        seqTimers.push(setTimeout(() => ((lastMove = performance.now()), invalidate()), c.ms));
        return invalidate();
      case "morphs":
        // a key let go is drawn once at 0, then forgotten
        morphHold = {
          ...Object.fromEntries(Object.entries(morphHold).filter(([, w]) => w > 0)),
          ...c.weights,
        };
        lastMove = now;
        return invalidate();
      case "face": {
        // a face asking more of her jaw than its intent supports is eased, not cut, and she says so (her state)
        const intent = mouthIntentOf(c.weights);
        const limited = limitMouth(c.weights, intent);
        faceEased = limited.eased.map((e) => ({
          ...e,
          why: `more than a ${intent} face opens her jaw`,
        }));
        override = { face: limited.weights, until: now + c.ms };
        setFace(limited.weights, now);
        seqTimers.push(setTimeout(invalidate, c.ms));
        return;
      }
      case "perform": {
        // composed over the posture she is in now (a step's act or posture came first), its bones part of the base
        const p = posture();
        const own = {
          ...(c.bones ? { bones: c.bones } : {}),
          ...(c.keys ? { keys: c.keys } : {}),
          look: c.keep?.includes("look") === true,
          face: c.keep?.includes("face") === true,
        };
        for (const x of performCues(c.perform, p.bones, p.grounded === true, c.id, own).cues)
          cue(x);
        return;
      }
      case "hold":
        for (const [id, ms] of Object.entries(c.systems)) holds[id] = now + ms;
        // a feeling kept off her face still leaks through, at the system's floor
        if (c.systems["moodLeak"] !== undefined) {
          const floor = INVOLUNTARY.find((s) => s.id === "moodLeak")?.override.floor ?? 0;
          const kept = faceWeights(mood.mood, mood.intensity * floor);
          override = { face: kept, until: now + c.systems["moodLeak"] };
          setFace(kept, now);
          seqTimers.push(setTimeout(invalidate, c.systems["moodLeak"]));
        }
        return invalidate();
      case "seq":
        for (const step of c.steps)
          seqTimers.push(
            setTimeout(() => {
              for (const x of step.cues) cue(x);
            }, step.atMs),
          );
        return;
      case "expressions":
        expMap = c.map;
        lastMove = now;
        return invalidate();
      case "outfit":
        for (const [piece, nodes] of outfit)
          for (const n of nodes) n.visible = !c.off.includes(piece);
        lastMove = now;
        return invalidate();
      case "gesture":
        gestures.push({ name: c.gesture, start: now });
        return invalidate();
      case "prop":
        return void putProp(c).catch(() => undefined);
      case "stop":
        return stopAll();
      case "turn": {
        const aim = aimOf(c.to);
        if (aim === null) return;
        startTurn(aim.yaw, c.ms, now);
        return invalidate();
      }
      case "walk": {
        const aim = aimOf(c.to);
        if (aim === null) return;
        startTurn(aim.yaw, undefined, now);
        const metres = Math.max(0, aim.metres - c.stop * (rig?.height ?? REFERENCE_RIG.height));
        if (metres > 0.05 && loco !== null)
          loco.walk = {
            gait: gaitOf(stepRig(), c.speed, c.style),
            metres,
            // a captured turn hands over to the walk as it ends; a stepped one partway through
            start: now + (loco.clip !== null ? loco.ms - LOCO_BLEND_MS : loco.ms * 0.6),
            travelled: 0,
            last: now + (loco.clip !== null ? loco.ms - LOCO_BLEND_MS : loco.ms * 0.6),
            phase: 0,
          };
        return invalidate();
      }
      case "speak":
        speech = { track: c.track, start: now, end: c.track.at(-1)?.end ?? 0 };
        effects = c.effects.map((e) => ({ ...e, at: now + e.atMs }));
        return invalidate();
      case "level":
        level = { value: c.value, ...(c.viseme ? { viseme: c.viseme } : {}), at: now };
        return invalidate();
      case "silent":
        speech = null;
        level = null;
        effects = [];
        return invalidate();
    }
  };

  // A touch on her: where it landed (her joints and the hit mesh), then what kind it was once the pointer tells us.
  const ray = new THREE.Raycaster();
  const skeleton = (): Skeleton =>
    Object.fromEntries(
      BODY_JOINTS.flatMap((b) => {
        const p = worldOf(b);
        return p ? [[b, [p.x, p.y, p.z]]] : [];
      }),
    );
  const pointers = new Map<number, { x: number; y: number; dx: number; reversals: number }>();
  let press: {
    at: number;
    zone: string;
    travel: number;
    spread0: number;
    spread: number;
    pressure: number;
    pointers: number;
    done: boolean;
    hit: THREE.Intersection;
  } | null = null;
  let taps: number[] = [];
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const spreadOf = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const feel = (kind0: string, intensity: number, speed: number) => {
    if (press === null || press.done) return;
    press.done = true;
    const kind = touchAs ?? kind0;
    const now = performance.now();
    // her face answers on this frame (well inside 150 ms); her feel and words come back from the layer
    override = {
      face: faceWeights(TOUCH_FACE[kind as TouchKind] ?? "attentive", 0.5 + 0.5 * intensity),
      until: now + 900,
    };
    setFace(override.face, now);
    if (kind === "tickle") gestures.push({ name: "giggleOnce", start: now });
    wake(now);
    options.onTouch?.(PROP_BONE[press.zone] ?? "spine", press.zone, {
      kind,
      intensity,
      speed,
      ...(handFrame === null ? {} : handContact(handFrame, handLength())),
      ...(nerveFelt === null ? {} : { felt: nerveFelt }),
    });
  };
  /** The part of her under a point on the canvas, or null (off her, or no model yet). */
  const partAt = (x: number, y: number) => {
    if (vrm === null) return null;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1),
      camera,
    );
    const hit = ray.intersectObject(vrm.scene, true).find((h) => h.object.visible);
    if (hit === undefined) return null;
    const where = regionOf(hit);
    return where === null ? null : { hit, where };
  };
  /** The region of her skin at a point on her: a pack region that claims it, else the general map's own split. */
  const regionOf = (hit: THREE.Intersection): string | null => {
    const mats = [(hit.object as THREE.Mesh).material].flat();
    const zone = touchZoneAt(
      [hit.point.x, hit.point.y - ground, hit.point.z - closer],
      Object.fromEntries(
        Object.entries(skeleton()).map(([k, v]) => [k, [v[0], v[1] - ground, v[2] - closer]]),
      ),
      `${hit.object.name} ${mats.map((m) => m?.name ?? "").join(" ")}`,
    );
    const bone = (n: string) => {
      const p = boneAt(n);
      return p && ([p.x, p.y, p.z] as const);
    };
    const local = (n: string, p: readonly [number, number, number]) => {
      const f = boneFrame(n);
      if (f === null) return undefined;
      const v = new THREE.Vector3(...p).sub(f.at).applyQuaternion(f.q.invert());
      return [v.x, v.y, v.z] as const;
    };
    return claimedRegion(sense, [hit.point.x, hit.point.y, hit.point.z], bone, local) ?? zone;
  };
  const onDown = (e: PointerEvent) => {
    if (vrm === null || options.onTouch === undefined) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, dx: 0, reversals: 0 });
    if (press !== null && !press.done) {
      press.pointers = Math.max(press.pointers, pointers.size);
      press.spread0 = press.spread = spreadOf();
      return;
    }
    const at = partAt(e.clientX, e.clientY);
    if (at === null) return pointers.delete(e.pointerId);
    const { hit, where } = at;
    // a quick firm press is a fingertip; anything else lays the palm on her
    handAt(hit, true, e.pressure || 0.5, (e.pressure || 0.5) >= 0.6);
    canvas.setPointerCapture?.(e.pointerId);
    const now = performance.now();
    nerveRegion = where;
    touch = { at: now, point: hit.point.clone(), strength: e.pressure || 0.5 };
    blinkAt = now;
    taps = taps.filter((t) => now - t < 900);
    press = {
      at: now,
      zone: where,
      travel: 0,
      spread0: 0,
      spread: 0,
      pressure: e.pressure || 0.5,
      pointers: 1,
      done: false,
      hit,
    };
    invalidate();
    if (holdTimer !== null) clearTimeout(holdTimer);
    // a hold is felt while it lasts, not when he lets go
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (press === null || press.done || press.travel >= 24) return;
      const t = readTouch({
        ms: HOLD_MS,
        travelPx: press.travel,
        pointers: press.pointers,
        spreadPx: press.spread - press.spread0,
        pressure: press.pressure,
      });
      if (t.kind === "hold" || t.kind === "grab" || t.kind === "squeeze")
        feel(t.kind, t.intensity, t.speed);
      // held still on her, the hand has closed on what is there: dragging now pulls it
      if (t.kind === "hold" || t.kind === "grab") startGrab(press.hit, performance.now());
    }, HOLD_MS);
  };
  // A mouse moving over her with nothing pressed: fingertips trailing across her (M-062). Raycast at most every
  // HOVER_RAY_MS while it moves; she feels it at the trace's own beat (traceStep), so nothing runs while it rests.
  let trace: Trace | null = null;
  let hoverAt = 0;
  let hoverTravel = 0;
  let hoverLast: { x: number; y: number } | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverIdle: ReturnType<typeof setTimeout> | null = null;
  const traced = (at: ReturnType<typeof partAt>, travel: number, now: number) => {
    const step = traceStep(trace, at?.where ?? null, travel, now);
    trace = step.trace;
    if (step.feel === null || at === null) return;
    const { intensity, speed } = step.feel;
    // she glances toward it and leans in a touch; her breath deepens, and a quick one sends a shiver through her
    touch = { at: now, point: at.hit.point.clone(), strength: 0.3 + 0.5 * intensity };
    override = {
      face: faceWeights(TOUCH_FACE.trace, 0.4 + intensity),
      motion: { breath: 0.35 + 0.4 * intensity, ...(speed > 0.6 ? { tremble: 0.25 * speed } : {}) },
      until: now + 1200,
    };
    setFace(override.face, now);
    wake(now);
    invalidate();
    options.onTouch?.(PROP_BONE[at.where] ?? "spine", at.where, {
      kind: "trace",
      intensity,
      speed,
      ...(nerveFelt === null ? {} : { felt: nerveFelt }),
    });
  };
  const offHer = () => {
    if (handFrame !== null) handFrame = { ...handFrame, at: performance.now() };
    handHeld = false;
    invalidate();
    trace = null;
    hoverLast = null;
    hoverTravel = 0;
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    lingerTimer = null;
  };
  const onHover = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0 || press !== null) return;
    if (options.onTouch === undefined) return;
    if (hoverLast !== null)
      hoverTravel += Math.hypot(e.clientX - hoverLast.x, e.clientY - hoverLast.y);
    hoverLast = { x: e.clientX, y: e.clientY };
    const now = performance.now();
    if (now - hoverAt < HOVER_RAY_MS) return;
    hoverAt = now;
    const at = partAt(e.clientX, e.clientY);
    if (at !== null) handAt(at.hit, false, 0, false);
    if (at !== null && press === null) nerveRegion = at.where;
    else if (handHeld) offHer();
    traced(at, hoverTravel, now);
    hoverTravel = 0;
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    lingerTimer =
      at === null ? null : setTimeout(() => traced(at, 0, performance.now()), TRACE_LINGER_MS);
    // a mouse left resting over her is not a hand on her: it fades once it has been still a moment
    if (hoverIdle !== null) clearTimeout(hoverIdle);
    hoverIdle =
      at === null
        ? null
        : setTimeout(() => {
            hoverIdle = null;
            if (press === null && handHeld && handFrame !== null) {
              handFrame = { ...handFrame, at: performance.now() };
              handHeld = false;
              invalidate();
            }
          }, HOVER_IDLE_MS);
  };
  const onMove = (e: PointerEvent) => {
    onHover(e);
    const p = pointers.get(e.pointerId);
    if (p === undefined || press === null) return;
    if (grip !== null) {
      // the holding hand moves in the plane through what it holds, facing the camera
      const r = canvas.getBoundingClientRect();
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()),
        grip.from,
      );
      const to = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (to !== null) moveGrab(to, performance.now());
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) > 2 && Math.sign(dx) !== Math.sign(p.dx) && p.dx !== 0) p.reversals++;
    if (Math.abs(dx) > 2) p.dx = dx;
    press.travel += Math.hypot(dx, dy);
    press.pressure = Math.max(press.pressure, e.pressure || 0);
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size >= 2) press.spread = spreadOf();
  };
  const onUp = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (grip !== null && pointers.size === 0) endGrab();
    if (p === undefined || press === null || pointers.size > 0) return;
    const now = performance.now();
    const tap = press.travel < 24 && now - press.at < HOLD_MS;
    if (tap) taps.push(now);
    const t = readTouch({
      ms: now - press.at,
      travelPx: press.travel,
      reversals: p.reversals,
      taps: tap ? taps.length : 1,
      pointers: press.pointers,
      spreadPx: press.spread - press.spread0,
      pressure: press.pressure,
    });
    feel(t.kind, t.intensity, t.speed);
    press = null;
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", offHer);

  const onVisibility = () => {
    onScreen = document.visibilityState === "visible";
    if (onScreen) invalidate();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const seen = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting === true && document.visibilityState === "visible";
    if (onScreen) invalidate();
  });
  seen.observe(canvas);
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- not React: the helper would pull react-dom into the body script
  const sized = new ResizeObserver(resize);
  sized.observe(canvas);
  canvas.hidden = true;

  /** Where her hands are resting, from her joints: on her own body (hip, thigh, chest, face) or not. */
  const contactsNow = (): BodyState["contacts"] => {
    const out: Array<{ part: string; with: string }> = [];
    const reach = 0.09 * (rig?.height ?? 1.6);
    for (const side of ["left", "right"] as const) {
      const hand = worldOf(`${side}Hand`);
      if (!hand) continue;
      for (const [part, bone] of [
        ["face", "head"],
        ["chest", "upperChest"],
        ["hip", `${side}UpperLeg`],
        ["thigh", `${side}LowerLeg`],
        ["other hand", side === "left" ? "rightHand" : "leftHand"],
      ] as const) {
        const at = worldOf(bone as VRMHumanBoneName);
        // a thigh is touched along it, so its midpoint stands for it
        const p =
          bone.endsWith("LowerLeg") && at
            ? at.clone().lerp(worldOf(`${side}UpperLeg`) ?? at, 0.5)
            : at;
        if (p && hand.distanceTo(p) < reach) out.push({ part: `${side} hand`, with: part });
      }
    }
    if (agentTouch !== null) out.push({ part: "agent hand", with: agentTouch.part });
    if (grip !== null)
      out.push({
        part: "a hand",
        with: `holding her ${grip.kind === "skin" ? grip.region : grip.kind}`,
      });
    return out;
  };
  const feltNow = (): Pick<BodyState, "felt"> =>
    nerveFelt === null || nerveRegion === null
      ? {}
      : {
          felt: {
            region: nerveRegion,
            ...nerveFelt,
            reflexes: [...fired].map((k) => k.split("@")[0]!),
          },
        };
  const heldNow = (): Pick<BodyState, "heldBy"> => {
    if (grip === null || vrm === null) return {};
    const d = grip.hand.clone().sub(grip.from);
    const toward = d.lengthSq() < 1e-8 ? d : d.normalize();
    toward.applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion()).invert());
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      heldBy: {
        kind: grip.kind,
        region: grip.region,
        root: grip.root,
        force: r(grip.force),
        stretch: r(grip.stretch),
        toward: [r(toward.x), r(toward.y), r(toward.z)],
      },
    };
  };
  const bodyState = (): BodyState => ({
    ...feltNow(),
    ...heldNow(),
    at: Date.now(),
    vessel: "",
    model,
    posture: scenePose ?? affectPose,
    moving: springing || (vrm !== null && active(performance.now())),
    bones: Object.fromEntries(
      [...springs].map(([b, s]) => [
        b,
        qToEuler(s.q).map((x) => Math.round(x * 1000) / 1000) as [number, number, number],
      ]),
    ),
    face: Object.fromEntries(Object.entries(face).filter(([, w]) => (w ?? 0) > 0.01)) as Record<
      string,
      number
    >,
    gaze:
      gazeHold !== null && performance.now() < gazeHold.until
        ? { x: gazeHold.yaw / 30, y: -gazeHold.pitch / 20 }
        : null,
    corrected: issues.map((i) => ({
      bone: i.bone,
      kind: i.kind,
      by: Math.round(i.by * 1000) / 1000,
    })),
    contacts: contactsNow(),
    ...(faceEased.length === 0 ? {} : { faceEased }),
    facing: Math.round(facing * 1000) / 1000,
    walking: loco?.walk != null,
    ...(rig === null ? {} : { height: Math.round(rig.height * 1000) / 1000 }),
    involuntary: Object.fromEntries(
      INVOLUNTARY.map((s) => {
        const left = Math.round((holds[s.id] ?? 0) - performance.now());
        return [s.id, left > 0 ? { on: false, heldMs: left } : { on: true }];
      }),
    ),
    manifest,
  });

  return {
    cue,
    /** Her body now (proprioception): posture, every posed bone, face, gaze, contacts, corrections and manifest. */
    state: bodyState,
    /** Bust or whole body, at any time (the page's "whole body" button). */
    frame: (next: "bust" | "body" | "half") => {
      framing = next;
      lastMove = performance.now();
      invalidate();
    },
    /** The share of the view a panel covers at the bottom (the phone's reply and controls), so she stays above it. */
    inset: (bottom: number) => {
      insetBottom = Math.max(0, Math.min(0.6, bottom));
      lastMove = performance.now();
      invalidate();
    },
    /** Move the camera round her (radians); her eyes follow him there. */
    /** Turns the camera round her (rad, either way to her side) and, for checks, up over her (`pitch`, rad). */
    orbit: (yaw: number, pitch = 0) => {
      camYaw = Math.max(-1.6, Math.min(1.6, yaw));
      camPitch = Math.max(0, Math.min(1.45, pitch));
      lastMove = performance.now();
      invalidate();
    },
    /** Kiss and hug can't be read off a pointer: the page says the next touches are one. null reads them again. */
    touchAs: (kind: TouchKind | (string & {}) | null) => {
      touchAs = kind;
    },
    outfit: () => [...outfit.keys()],
    /** What this model's body can do (its rig's manifest) and what the rig last had to correct in a pose. */
    rig: () => ({ manifest, issues }),
    /**
     * For checks and the playground: her joints in the world (m), and the hand on her: its palm and fingertips, and
     * how far each sits inside her (mm, 0 when outside), found by casting at her from outside along the palm.
     */
    probe: () => {
      const world = Object.fromEntries(
        Object.entries(skeleton()).map(([k, v]) => [k, v.map((x) => Math.round(x * 1e4) / 1e4)]),
      );
      const palmsNow = palmsOf();
      const yaws = Object.fromEntries(
        facingOf.map((f) => {
          const v = f.ahead.clone().applyQuaternion(f.node.getWorldQuaternion(new THREE.Quaternion()));
          return [f.bone, Math.atan2(v.x, v.z)];
        }),
      );
      if (vrm === null || handMesh === null || !handMesh.group.visible || handFrame === null)
        return {
          world,
          palms: palmsNow,
          yaws,
          facing,
          hand: null,
          held: grip === null ? null : { kind: grip.kind, root: grip.root },
        };
      handMesh.group.updateMatrixWorld(true);
      const e = handMesh.group.matrixWorld.elements;
      const out = new THREE.Vector3(...handFrame.normal).negate();
      const points = [
        handMesh.group.getWorldPosition(new THREE.Vector3()),
        ...handMesh.fingers.map((f) => {
          const tip = f.at(-1)!;
          return tip.localToWorld(
            new THREE.Vector3(0, (tip.children[0] as THREE.Mesh).position.y * 2, 0),
          );
        }),
      ];
      // a point is inside her when the nearest surface out along the touch is one it would leave (a back face); a
      // surface it would enter first means it is outside, even when another part of her is in the way
      const sides = new Map<THREE.Material, THREE.Side>();
      vrm.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const x of Array.isArray(m) ? m : m ? [m] : [])
          if (!sides.has(x)) sides.set(x, x.side);
      });
      for (const x of sides.keys()) x.side = THREE.DoubleSide;
      const inside = points.map((p) => {
        ray.set(p, out);
        const hit = ray
          .intersectObject(vrm!.scene, true)
          .find((h) => h.object.visible && !isHair(h.object) && h.face != null);
        if (hit === undefined || hit.distance > 0.15) return 0;
        const n = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
        return n.dot(out) > 0 ? Math.round(hit.distance * 1e4) / 10 : 0;
      });
      for (const [x, side] of sides) x.side = side;
      return {
        world,
        palms: palmsNow,
        yaws,
        facing,
        hand: {
          points: points.map((p) => [p.x, p.y, p.z]),
          insideMm: inside,
          facing: [e[8], e[9], e[10]],
          opacity: handMesh.material.opacity,
        },
        held: grip === null ? null : { kind: grip.kind, root: grip.root },
      };
    },
    /** Where each of her joints is on the canvas (CSS px), for a page that labels or aims at her parts. */
    joints: () => {
      const r = canvas.getBoundingClientRect();
      return Object.fromEntries(
        Object.entries(skeleton()).map(([j, p]) => {
          const v = new THREE.Vector3(...p).project(camera);
          return [
            j,
            { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, depth: v.z, world: p },
          ];
        }),
      );
    },
    stats: (): BodyStats => ({
      tier,
      frames,
      avgFrameMs: frames === 0 ? 0 : workMs / frames,
      visible: shown && onScreen,
      model,
      posture: scenePose ?? affectPose,
    }),
    dispose: () => {
      disposed = true;
      if (lapse !== null) clearTimeout(lapse);
      hideNow();
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", offHer);
      offHer();
      if (holdTimer !== null) clearTimeout(holdTimer);
      for (const t of seqTimers) clearTimeout(t);
      seen.disconnect();
      sized.disconnect();
      for (const id of props.keys()) dropProp(id);
      overlays?.dispose();
      if (vrm !== null) VRMUtils.deepDispose(vrm.scene);
      scene.remove(root);
      if (shared === undefined) renderer.dispose();
    },
    /** Where she stands on a shared stage (metres across and toward him) and how big. */
    setPlace: (x: number, z: number, scale: number) => {
      root.position.set(x, 0, z);
      stance = false;
      root.scale.setScalar(scale);
      invalidate();
    },
    /** One frame of this body's own work on a shared stage (the stage draws). */
    tick: (now: number) => frame(now),
    /** Her joints in the world, for a shared stage's camera (into vectors she keeps, so a frame allocates none). */
    worldJoints: (into: THREE.Vector3[]) => {
      if (vrm === null) return;
      for (const [i, b] of BODY_JOINTS.entries()) {
        const node = vrm.humanoid.getRawBoneNode(b);
        if (node) into.push(node.getWorldPosition(jointPool[i]!));
      }
    },
  };
}

export type Body = ReturnType<typeof mountBody>;

// a spot's 0..1 across the view, in metres on the stage; a forward body stands this much nearer him
const STAGE_WIDTH_M = 3;
const FRONT_M = 0.35;

/**
 * Several bodies in one view (a mirror, the phone's crew), as rooms.ts `StageMount` asks: `mount(personas)` gives a
 * body per persona, each with its own cues, `BodyState`, `locate` and `onWalk`, and `place(spot)`. One renderer,
 * scene, camera and light rig; one frame loop that ticks only the bodies that asked and draws once; a hidden or
 * off-screen canvas draws nothing, as one body's does.
 */
export function mountBodies(
  canvas: HTMLCanvasElement,
  /** Options every body shares, and any one body's own by persona (its `locate` wins over the stage's). */
  options: Parameters<typeof mountBody>[1] & {
    readonly each?: Readonly<Record<string, Parameters<typeof mountBody>[1]>>;
  } = {},
  tier = options.tier ?? startTier(),
) {
  const base = makeStage(canvas, tier);
  const list: Array<{ readonly id: string; readonly body: Body }> = [];
  const wanting = new Set<string>();
  const points: THREE.Vector3[] = [];
  let due = Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let raf = 0;
  let disposed = false;
  // made once: a frame's scheduling allocates nothing
  const fire = () => {
    timer = null;
    raf = requestAnimationFrame(draw);
  };
  const draw = (now: number) => {
    raf = 0;
    due = Infinity;
    if (disposed) return;
    // each body that asked ticks (and may ask again); the rest hold their pose; then one draw for all
    for (const { id, body } of list)
      if (wanting.has(id)) {
        wanting.delete(id);
        body.tick(now);
      }
    base.renderer.render(base.scene, base.camera);
  };
  const stage: Stage = {
    ...base,
    wake: (afterMs, id) => {
      wanting.add(id);
      const at = performance.now() + afterMs;
      if (disposed || raf !== 0 || at >= due) return;
      if (timer !== null) clearTimeout(timer);
      due = at;
      // half a frame early, so the animation frame lands on the intended vsync
      timer = setTimeout(fire, Math.max(0, afterMs - 8));
    },
    points: () => {
      points.length = 0;
      for (const { body } of list) body.worldJoints(points);
      return points;
    },
    leads: (id) => list[0]?.id === id,
  };
  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    base.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIERS[tier]!.ratio));
    base.renderer.setSize(w, h, false);
    base.camera.aspect = w / h;
    base.camera.updateProjectionMatrix();
    for (const { id } of list) stage.wake(0, id);
  };
  const spots = new Map<string, { x: number; z: number }>();
  /** Another body on this stage: which way it is from this one and how far. */
  const locateOn =
    (from: string) =>
    (to: BodyTarget): { yaw: number; metres: number } | null => {
      if (to.kind !== "persona") return null;
      const a = spots.get(from);
      const b = spots.get(to.id);
      if (a === undefined || b === undefined) return null;
      // she faces +z with her left +x: a body to her left is a positive turn
      return { yaw: Math.atan2(b.x - a.x, b.z - a.z), metres: Math.hypot(b.x - a.x, b.z - a.z) };
    };
  const { each, ...common } = options;
  const add = (id: string) => {
    const own = each?.[id] ?? {};
    const theirs = own.locate ?? common.locate;
    const mine = locateOn(id);
    const body = mountBody(
      canvas,
      { ...common, ...own, tier, locate: (to) => theirs?.(to) ?? mine(to) },
      { stage, id },
    );
    list.push({ id, body });
    return body;
  };
  // a body facing one not placed yet turns once that one has a spot (a plan places them one at a time)
  const waiting = new Map<string, string>();
  const place = (id: string, body: Body, spot: StageSpot) => {
    const at = { x: (spot.x - 0.5) * STAGE_WIDTH_M, z: spot.front ? FRONT_M : 0 };
    spots.set(id, at);
    body.setPlace(at.x, at.z, spot.scale);
    if (spot.faces.kind === "persona" && !spots.has(spot.faces.id)) waiting.set(id, spot.faces.id);
    else body.cue({ kind: "turn", to: spot.faces });
    for (const [other, target] of waiting)
      if (target === id) {
        waiting.delete(other);
        list.find((b) => b.id === other)?.body.cue({ kind: "turn", to: { kind: "persona", id } });
      }
  };
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- not React: the helper would pull react-dom into the body script
  const sized = new ResizeObserver(resize);
  sized.observe(canvas);
  const mount = (personas: ReadonlyArray<string>) =>
    new Map(
      personas.map((id) => {
        const body = list.find((b) => b.id === id)?.body ?? add(id);
        return [id, { ...body, place: (spot: StageSpot) => place(id, body, spot) }] as const;
      }),
    );
  return {
    /** A body per persona, made once and kept (a later mount adds the new ones), each placeable on a spot. */
    mount: mount satisfies StageMount["mount"],
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (raf !== 0) cancelAnimationFrame(raf);
      sized.disconnect();
      for (const { body } of list) body.dispose();
      base.renderer.dispose();
    },
  };
}
