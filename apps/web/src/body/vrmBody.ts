/**
 * The light 3D body (M-047): one VRM model on three.js, driven only by body cues (tessaya-shared bodyCues.ts). Built for
 * old devices: it draws only while something moves (speech, a gesture, a blend, a blink), capped per quality tier, and
 * nothing at all while hidden. At rest it is a still picture with a blink every few seconds.
 */
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  GESTURES,
  INTIMATE_FACES,
  INTIMATE_STATES,
  STILL,
  beastkin,
  faceWeights,
  mouthWeights,
  parseCue,
  swingAt,
  type BodyBone,
  type BodyCue,
  type Motion,
  type States,
  type TouchZone,
  type Weights,
} from "@t3tools/tessaya-shared/bodyCues";
import {
  ACTS,
  BODY_JOINTS,
  POSE_BONES,
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
  preparePose,
  settled,
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
  { ratio: 1.5, aa: true, fps: 30 },
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
const PROP_BONE: Readonly<Record<TouchZone, BodyBone>> = {
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
/** How long her head and eyes follow a touch, and a little more than the 150 ms in which a person turns to one. */
const TOUCH_MS = 1600;
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

export function mountBody(
  canvas: HTMLCanvasElement,
  options: {
    readonly tier?: number;
    /** `bone` is where a held prop goes; `zone` is the part of her he touched, and `touch` what kind and how strong. */
    readonly onTouch?: (
      bone: BodyBone,
      zone: TouchZone | (string & {}),
      touch: {
        readonly kind: TouchKind | (string & {});
        readonly intensity: number;
        readonly speed: number;
      },
    ) => void;
    /** The outfit pieces this model can take off, once it loads (none when clothing is painted on). */
    readonly onOutfit?: (pieces: ReadonlyArray<OutfitPiece>) => void;
    /** "body" frames all of her (the phone's touch view); the default frames head and shoulders. */
    readonly framing?: "bust" | "body";
    /** Each time she comes to rest after moving: what her body is doing now (proprioception), for the layer to keep. */
    readonly onSettle?: (state: BodyState) => void;
  } = {},
) {
  let tier = options.tier ?? startTier();
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
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

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
  // the last touch: where, and when; her head and eyes follow it for TOUCH_MS
  let touch: { at: number; point: THREE.Vector3 } | null = null;
  // a small gaze shift that comes with each blink, so her eyes never sit dead still
  let glance = { yaw: 0, pitch: 0 };
  // her posture: the one her affect picks, a scene's held one, and the crossfade between them
  let affectPose: PostureName = "stand";
  let scenePose: PostureName | null = null;
  // the rig of the model on screen, every bone's spring toward its target, and what the last target needed fixing
  let rig: Rig | null = null;
  let manifest: RigManifest | null = null;
  let springs = new Map<string, BoneSpring>();
  let springing = false;
  let lastSpring = 0;
  let goalKey = "";
  let goal: Record<string, Q> = {};
  let issues: ReadonlyArray<RigIssue> = [];
  let stepping: number | null = null;
  let dancing: number | null = null;
  let closer = 0;
  let closerTo = 0;
  let ground = 0;
  // where her feet meet the floor at rest, measured when the model loads
  let sole = Number.NaN;
  // extra lift of each upper arm when a hand or elbow would pass into her body on this model
  let armOut = { left: 0, right: 0 };
  let idleUntil = 0;
  let framing = options.framing ?? "bust";
  let headY = 1.4;
  let camYaw = 0;
  let touchAs: string | null = null;
  // owner extensions: a playing clip, extra touch regions, and model expressions standing in for states and faces
  let clip: (Extract<BodyCue, { kind: "clip" }> & { start: number }) | null = null;
  let zones: Extract<BodyCue, { kind: "zones" }>["zones"] = [];
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
    return { states: { ...statesTo, ...override?.states }, motion: m };
  };
  const setPose = (now: number) => {
    clip = null;
    pace = 1;
    springing = true;
    armOut = { left: 0, right: 0 };
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
    (clip !== null &&
      (clip.loop || now - clip.start < (clip.frames.length / clip.fps) * 1000 + 500)) ||
    (tails.length > 0 && kin.tailAmp > 0 && now - kinAt < WAG_MS) ||
    propsRunning();

  /**
   * Her posture, with a playing clip's frame and any step or dance over it, made right for this model by the rig
   * (limits, hinge elbows and knees, her own rest pose), then followed by a spring per bone: any change of target, at
   * any moment, bends the motion smoothly instead of cutting it. Once every bone has arrived, nothing moves.
   */
  const applyPose = (now: number) => {
    if (vrm === null || rig === null) return;
    const bones: Partial<Record<PoseBone, Euler>> = { ...posture().bones };
    if (clip !== null) Object.assign(bones, clipAt(clip, now - clip.start));
    Object.assign(
      bones,
      dancing === null ? {} : danceAt(now - dancing),
      stepping === null ? {} : stepAt(now - stepping),
    );
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
      const next = springing ? springStep(s, g, halfLifeOf(b) * pace, dt) : s;
      const done = settled(next, g);
      const shown = done ? { q: g, w: [0, 0, 0] as V3 } : next;
      if (!done) moving = true;
      springs.set(b, shown);
      node.quaternion.set(shown.q[0], shown.q[1], shown.q[2], shown.q[3]);
    }
    springing = moving;
    if (moving) lastMove = now;
    else lastSpring = 0;
    const la = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
    const ra = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    if (la) la.rotation.z += armOut.left;
    if (ra) ra.rotation.z -= armOut.right;
  };

  const at = new THREE.Vector3();
  const worldOf = (b: VRMHumanBoneName) =>
    vrm?.humanoid.getRawBoneNode(b)?.getWorldPosition(at).clone();
  /**
   * After the pose lands: lift an arm whose hand or elbow is inside her trunk (her proportions, not the pose's), and
   * set her on the floor when she sits or lies. Each corrects over a few frames and reports whether it is still moving.
   */
  const settleBody = (f: number): boolean => {
    if (vrm === null) return false;
    let moving = false;
    const hips = worldOf("hips");
    const top = worldOf("upperChest") ?? worldOf("chest");
    const ll = worldOf("leftUpperLeg");
    const rl = worldOf("rightUpperLeg");
    if (hips && top && ll && rl && !posture().grounded) {
      const half = Math.abs(ll.x - rl.x) * 1.05;
      for (const side of ["left", "right"] as const) {
        for (const j of [`${side}Hand`, `${side}LowerArm`] as const) {
          const p = worldOf(j);
          if (!p || p.y > top.y || p.y < hips.y - half) continue;
          const dx = (p.x - hips.x) / half;
          const dz = (p.z - hips.z) / (half * 0.7);
          if (dx * dx + dz * dz < 1 && armOut[side] < 0.4) {
            armOut[side] += 0.04;
            moving = true;
          }
        }
      }
    }
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
    let want: { x: number; y: number; dist: number };
    if (framing === "body") {
      // all of her, whatever her posture: fit her joints (plus head room) into the view
      const pts = BODY_JOINTS.flatMap((b) => {
        const p = worldOf(b);
        return p ? [p] : [];
      });
      if (pts.length === 0) return false;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const pad = 0.12 * headY;
      const [x0, x1] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
      const [y0, y1] = [Math.min(...ys) - pad * 0.6, Math.max(...ys) + pad * 1.4];
      const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      want = {
        x: (x0 + x1) / 2,
        y: (y0 + y1) / 2,
        dist: Math.max((y1 - y0) / 2 / v, (x1 - x0) / 2 / (v * camera.aspect)) + 0.3,
      };
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
      camAim.x + Math.sin(camYaw) * camAim.dist,
      camAim.y + lift,
      Math.cos(camYaw) * camAim.dist,
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
    // walking to or from him: steps while the distance closes, then she stands
    if (closer !== closerTo) {
      const stride = WALK_SPEED * delta;
      closer =
        Math.abs(closerTo - closer) <= stride
          ? closerTo
          : closer + Math.sign(closerTo - closer) * stride;
      vrm.scene.position.z = closer;
      if (closer === closerTo) stepping = null;
      lastMove = now;
    }
    const exhale = applyMotion((n) => vrm!.humanoid.getNormalizedBoneNode(n), motion, now / 1000);
    // a touch: she turns her head toward it and flinches a little, then eases back
    const felt = touch === null ? 0 : Math.sin(Math.PI * Math.min(1, (now - touch.at) / TOUCH_MS));
    if (touch !== null && felt > 0) {
      const headNode = vrm.humanoid.getNormalizedBoneNode("head");
      const neckNode = vrm.humanoid.getNormalizedBoneNode("neck");
      const chestNode = vrm.humanoid.getNormalizedBoneNode("chest");
      const from = (headNode ?? vrm.scene).getWorldPosition(new THREE.Vector3());
      const to = touch.point.clone().sub(from);
      const yaw = Math.max(-0.5, Math.min(0.5, Math.atan2(to.x, Math.max(0.05, to.z + 0.3))));
      const pitch = Math.max(-0.45, Math.min(0.3, Math.atan2(-to.y, 0.4)));
      if (neckNode) neckNode.rotation.y += 0.45 * yaw * felt;
      if (headNode) {
        headNode.rotation.y += 0.35 * yaw * felt;
        headNode.rotation.x += 0.6 * pitch * felt;
      }
      if (chestNode) chestNode.rotation.x += -0.05 * felt * (now - touch.at < 300 ? 1 : 0.4);
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
    // shape keys asked for by name go on after the expressions, which would otherwise reset the ones they bind
    for (const [name, w] of Object.entries({ ...shapes, ...morphHold }))
      for (const k of shapeKeys.get(name) ?? [])
        if (k.mesh.morphTargetInfluences) k.mesh.morphTargetInfluences[k.i] = w;
    shapes = {};
    if (mirrored) flipVrm0(vrm);
    const f2 = 1 - Math.exp(-4 * delta);
    if (settleBody(f2) || placeCamera(f2)) lastMove = now;
    renderer.render(scene, camera);
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
    if (active(now) || motion.tremble > 0.05) schedule(1000 / TIERS[tier]!.fps);
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
    if (disposed || !shown || !onScreen || raf !== 0 || timer !== null) return;
    const wait = Math.max(0, afterMs - (performance.now() - lastFrame));
    timer = setTimeout(() => {
      timer = null;
      raf = requestAnimationFrame(frame);
    }, wait);
  };
  const invalidate = () => schedule(0);

  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  const planBlink = () => {
    if (blinkTimer !== null || disposed) return;
    blinkTimer = setTimeout(
      () => {
        blinkTimer = null;
        blinkAt = performance.now();
        // a saccade hidden in the blink: a degree or two, mostly back toward him
        glance = { yaw: (Math.random() - 0.5) * 4, pitch: (Math.random() - 0.5) * 2.5 };
        invalidate();
      },
      2500 + Math.random() * 3500,
    );
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
    if (vrm !== null) {
      scene.remove(vrm.scene);
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
    shapeKeys = new Map();
    next.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      for (const [name, i] of Object.entries(mesh.morphTargetDictionary ?? {}))
        shapeKeys.set(name, [...(shapeKeys.get(name) ?? []), { mesh, i }]);
    });
    morphHold = {};
    rig = rigOf(next);
    rig = { ...rig, proxies: fitProxies(rig, skinSamples(next)) };
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
    scene.add(vrm.scene);
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
        mood = { mood: c.mood, intensity: c.intensity };
        const next = postureFor(c);
        if (next !== affectPose) {
          if (scenePose === null && clip === null) setPose(now);
          affectPose = next;
        }
        // the page re-sends her mood every few seconds: only a change wakes her idle breathing
        const key = JSON.stringify([c.mood, c.intensity, c.states, c.motion]);
        if (key !== moodKey) wake(now);
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
        setPose(now);
        clip = { ...c, start: now };
        // a direct pose asked to arrive in `ms`: her springs take that long instead of her own pace
        pace = c.ms === undefined ? 1 : c.ms / 450;
        wake(now);
        return invalidate();
      case "zones":
        zones = c.zones;
        return;
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
      case "face":
        override = { face: c.weights, until: now + c.ms };
        setFace(c.weights, now);
        seqTimers.push(setTimeout(invalidate, c.ms));
        return;
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
    options.onTouch?.(PROP_BONE[press.zone as TouchZone] ?? "spine", press.zone, {
      kind,
      intensity,
      speed,
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
    const mats = [(hit.object as THREE.Mesh).material].flat();
    const zone = touchZoneAt(
      [hit.point.x, hit.point.y - ground, hit.point.z - closer],
      Object.fromEntries(
        Object.entries(skeleton()).map(([k, v]) => [k, [v[0], v[1] - ground, v[2] - closer]]),
      ),
      `${hit.object.name} ${mats.map((m) => m?.name ?? "").join(" ")}`,
    );
    const extra = zones.find((z) => {
      const p = worldOf(z.bone as VRMHumanBoneName);
      return p !== undefined && p.distanceTo(hit.point) <= z.radius;
    });
    const where = extra?.id ?? zone;
    return where === null ? null : { hit, where };
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
    canvas.setPointerCapture?.(e.pointerId);
    const now = performance.now();
    touch = { at: now, point: hit.point.clone() };
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
    }, HOLD_MS);
  };
  // A mouse moving over her with nothing pressed: fingertips trailing across her (M-062). Raycast at most every
  // HOVER_RAY_MS while it moves; she feels it at the trace's own beat (traceStep), so nothing runs while it rests.
  let trace: Trace | null = null;
  let hoverAt = 0;
  let hoverTravel = 0;
  let hoverLast: { x: number; y: number } | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  const traced = (at: ReturnType<typeof partAt>, travel: number, now: number) => {
    const step = traceStep(trace, at?.where ?? null, travel, now);
    trace = step.trace;
    if (step.feel === null || at === null) return;
    const { intensity, speed } = step.feel;
    // she glances toward it and leans in a touch; her breath deepens, and a quick one sends a shiver through her
    touch = { at: now, point: at.hit.point.clone() };
    override = {
      face: faceWeights(TOUCH_FACE.trace, 0.4 + intensity),
      motion: { breath: 0.35 + 0.4 * intensity, ...(speed > 0.6 ? { tremble: 0.25 * speed } : {}) },
      until: now + 1200,
    };
    setFace(override.face, now);
    wake(now);
    invalidate();
    options.onTouch?.(PROP_BONE[at.where as TouchZone] ?? "spine", at.where, {
      kind: "trace",
      intensity,
      speed,
    });
  };
  const offHer = () => {
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
    traced(at, hoverTravel, now);
    hoverTravel = 0;
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    lingerTimer =
      at === null ? null : setTimeout(() => traced(at, 0, performance.now()), TRACE_LINGER_MS);
  };
  const onMove = (e: PointerEvent) => {
    onHover(e);
    const p = pointers.get(e.pointerId);
    if (p === undefined || press === null) return;
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
    return out;
  };
  const bodyState = (): BodyState => ({
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
    manifest,
  });

  return {
    cue,
    /** Her body now (proprioception): posture, every posed bone, face, gaze, contacts, corrections and manifest. */
    state: bodyState,
    /** Bust or whole body, at any time (the page's "whole body" button). */
    frame: (next: "bust" | "body") => {
      framing = next;
      lastMove = performance.now();
      invalidate();
    },
    /** Move the camera round her (radians); her eyes follow him there. */
    orbit: (yaw: number) => {
      camYaw = Math.max(-1.2, Math.min(1.2, yaw));
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
      renderer.dispose();
    },
  };
}

export type Body = ReturnType<typeof mountBody>;
