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
  blendAt,
  danceAt,
  outfitPiece,
  postureFor,
  readTouch,
  stepAt,
  touchZoneAt,
  HOLD_MS,
  type Euler,
  type OutfitPiece,
  type PoseBone,
  type PostureName,
  type Skeleton,
  type TouchKind,
} from "@t3tools/tessaya-shared/bodyMotion";
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
 * VRM 0.x keeps its X and Z axes flipped on three-vrm's normalized rig even after rotateVRM0 (three-vrm's own retarget
 * example negates them too), so the same pose would raise the arms. Mirroring the normalized rotations around the update
 * lets every pose here be written once, in VRM 1.0's axes.
 */
const flipVrm0 = (vrm: VRM) => {
  for (const b of Object.values(vrm.humanoid.normalizedHumanBones)) {
    const r = b?.node.rotation;
    if (r) r.set(-r.x, r.y, -r.z);
  }
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
const ZERO: Euler = [0, 0, 0];
/** How long her head and eyes follow a touch, and a little more than the 150 ms in which a person turns to one. */
const TOUCH_MS = 1600;

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
  let vrm0 = false;
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
  let poseFrom: Partial<Record<PoseBone, Euler>> = POSTURES.stand.bones;
  let poseShown: Partial<Record<PoseBone, Euler>> = POSTURES.stand.bones;
  let poseAt = 0;
  let stepping: number | null = null;
  let dancing: number | null = null;
  let closer = 0;
  let closerTo = 0;
  let ground = 0;
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
    poseFrom = poseShown;
    poseAt = now;
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
    now - poseAt < 500 ||
    stepping !== null ||
    dancing !== null ||
    (clip !== null &&
      (clip.loop || now - clip.start < (clip.frames.length / clip.fps) * 1000 + 500)) ||
    (tails.length > 0 && kin.tailAmp > 0 && now - kinAt < WAG_MS) ||
    propsRunning();

  /** Her posture, crossfaded from the last one, with any step or dance on top; every bone it names is set. */
  const applyPose = (now: number) => {
    if (vrm === null) return;
    const to: Partial<Record<PoseBone, Euler>> = posture().bones;
    const k = blendAt(now - poseAt);
    const blended: Partial<Record<PoseBone, Euler>> = {};
    for (const b of POSE_BONES) {
      const f = poseFrom[b] ?? ZERO;
      const t = to[b] ?? ZERO;
      blended[b] = [f[0] + (t[0] - f[0]) * k, f[1] + (t[1] - f[1]) * k, f[2] + (t[2] - f[2]) * k];
    }
    poseShown = blended;
    let frameNow: Partial<Record<PoseBone, Euler>> = {};
    if (clip !== null) {
      const n = clip.frames.length;
      const at = ((now - clip.start) / 1000) * clip.fps;
      const i = clip.loop ? at % n : Math.min(n - 1, at);
      const a = clip.frames[Math.floor(i)]!;
      const b =
        clip.frames[clip.loop ? (Math.floor(i) + 1) % n : Math.min(n - 1, Math.floor(i) + 1)]!;
      const t = i - Math.floor(i);
      // the clip eases in over the posture like any other change
      const w = blendAt(now - clip.start);
      for (const bone of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<PoseBone>) {
        const x = a[bone] ?? ZERO;
        const y = b[bone] ?? x;
        const base = blended[bone] ?? ZERO;
        frameNow[bone] = [0, 1, 2].map((k) => {
          const v = x[k]! + (y[k]! - x[k]!) * t;
          return base[k]! + (v - base[k]!) * w;
        }) as unknown as Euler;
      }
      if (!clip.loop && at >= n - 1 && now - clip.start > 500)
        poseShown = { ...blended, ...frameNow };
    }
    const cycles = {
      ...frameNow,
      ...(dancing === null ? {} : danceAt(now - dancing)),
      ...(stepping === null ? {} : stepAt(now - stepping)),
    } as Partial<Record<PoseBone, Euler>>;
    for (const b of POSE_BONES) {
      const r = cycles[b] ?? blended[b]!;
      vrm.humanoid.getNormalizedBoneNode(b)?.rotation.set(r[0], r[1], r[2]);
    }
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
        vrm.lookAt.yaw =
          toTouch === null ? himYaw + glance.yaw : (Math.atan2(toTouch.x, 0.6) * 180) / Math.PI;
        vrm.lookAt.pitch =
          -25 * roll + (1 - roll) * (toTouch === null ? himPitch + glance.pitch : -12 * felt);
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
    if (vrm0) flipVrm0(vrm);
    vrm.update(delta);
    if (vrm0) flipVrm0(vrm);
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
    else planBlink();
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
    vrm0 = next.meta.metaVersion === "0";
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
        wake(now);
        return invalidate();
      case "zones":
        zones = c.zones;
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
  const onDown = (e: PointerEvent) => {
    if (vrm === null || options.onTouch === undefined) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, dx: 0, reversals: 0 });
    if (press !== null && !press.done) {
      press.pointers = Math.max(press.pointers, pointers.size);
      press.spread0 = press.spread = spreadOf();
      return;
    }
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      ),
      camera,
    );
    const hit = ray.intersectObject(vrm.scene, true).find((h) => h.object.visible);
    if (hit === undefined) return pointers.delete(e.pointerId);
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
    if (where === null) return pointers.delete(e.pointerId);
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
  const onMove = (e: PointerEvent) => {
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

  return {
    cue,
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
      if (holdTimer !== null) clearTimeout(holdTimer);
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
