/**
 * The light 3D body (M-047): one VRM model on three.js, driven only by body cues (tessaya-shared bodyCues.ts). Built for
 * old devices: it draws only while something moves (speech, a gesture, a blend, a blink), capped per quality tier, and
 * nothing at all while hidden. At rest it is a still picture with a blink every few seconds.
 */
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
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
  type Weights,
} from "@t3tools/tessaya-shared/bodyCues";
import { visemeAt, type VisemeSegment } from "@t3tools/tessaya-shared/visemes";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { applyMotion, makeOverlays, stateWeights, styleOf, type Style } from "./intimate";

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
const TOUCH_BONES: ReadonlyArray<BodyBone> = [
  "head",
  "neck",
  "chest",
  "spine",
  "hips",
  "leftHand",
  "rightHand",
];

export interface BodyStats {
  readonly tier: number;
  readonly frames: number;
  readonly avgFrameMs: number;
  readonly visible: boolean;
  readonly model: string | null;
}

const startTier = () => {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  if ((nav.deviceMemory ?? 4) <= 2 || cores <= 2) return 0;
  return cores <= 4 ? 1 : 2;
};

export function mountBody(
  canvas: HTMLCanvasElement,
  options: { readonly tier?: number; readonly onTouch?: (bone: BodyBone) => void } = {},
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
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.6, 1.8, 2);
  scene.add(sun);
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
  let bodyOwn = new Set<string>();
  let vrm0 = false;
  let speech: { track: ReadonlyArray<VisemeSegment>; start: number; end: number } | null = null;
  let effects: Array<{ at: number; face?: string; gesture?: string }> = [];
  let level: { value: number; viseme?: VisemeSegment["viseme"]; at: number } | null = null;
  let gestures: Array<{ name: string; start: number }> = [];
  let blinkAt = 0;
  let lastMove = 0;
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

  const target = () => ({
    states: { ...statesTo, ...override?.states },
    motion: { ...motionTo, ...override?.motion },
  });
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
    (tails.length > 0 && kin.tailAmp > 0 && now - kinAt < WAG_MS) ||
    propsRunning();

  const restPose = () => {
    if (vrm === null) return;
    const bone = (b: BodyBone) => vrm!.humanoid.getNormalizedBoneNode(b);
    for (const b of [
      "hips",
      "head",
      "neck",
      "spine",
      "chest",
      "rightLowerArm",
      "leftShoulder",
      "rightShoulder",
    ] as const)
      bone(b)?.rotation.set(0, 0, 0);
    // arms down from the T-pose
    bone("leftUpperArm")?.rotation.set(0, 0, -1.2);
    bone("rightUpperArm")?.rotation.set(0, 0, 1.2);
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
    restPose();
    const exhale = applyMotion((n) => vrm!.humanoid.getNormalizedBoneNode(n), motion, now / 1000);
    const added = stateWeights(states, style, exhale, (n) => own.has(n));
    // drawn overlays only for the states the model can't show itself
    overlays?.set(
      own.size === 0
        ? states
        : Object.fromEntries(Object.entries(states).filter(([n]) => !own.has(n))),
    );

    const em = vrm.expressionManager;
    if (em !== undefined) {
      for (const n of own) em.setValue(n, states[n as keyof States] ?? 0);
      // a model's own body shapes: chest and belly rise on the inhale, skin flushes with her blush, hair dampens with sweat
      for (const [n, w] of [
        ["breath", motion.breath * (1 - exhale)],
        ["flush", states.blush ?? 0],
        ["hairDamp", states.sweat ?? 0],
      ] as const)
        if (bodyOwn.has(n)) em.setValue(n, w);
      // rolled-up eyes through the model's own lookAt (three-vrm: negative pitch looks up)
      if (vrm.lookAt && !own.has("eyesRoll")) vrm.lookAt.pitch = -25 * (states.eyesRoll ?? 0);
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
    if (vrm0) flipVrm0(vrm);
    vrm.update(delta);
    if (vrm0) flipVrm0(vrm);
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
    overlays = makeOverlays(next, style);
    // states the model carries itself as custom expressions win over the built ones
    own = new Set(INTIMATE_STATES.filter((n) => next.expressionManager?.getExpression(n)));
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
    const head = vrm.humanoid.getRawBoneNode("head")?.getWorldPosition(new THREE.Vector3());
    if (head) {
      camera.position.set(0, head.y, 1.4);
      camera.lookAt(0, head.y - 0.08, 0);
    }
    lastMove = performance.now();
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
      case "mood":
        mood = { mood: c.mood, intensity: c.intensity };
        kin = beastkin(c);
        kinAt = now;
        look = c.look ?? null;
        statesTo = c.states ?? {};
        motionTo = c.motion ?? STILL;
        invalidate();
        if (override === null) setFace(faceWeights(c.mood, c.intensity), now);
        return;
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

  // A tap on her: the nearest humanoid bone to the hit, so the page can apply a prop there.
  const ray = new THREE.Raycaster();
  const onPointer = (e: PointerEvent) => {
    if (vrm === null || options.onTouch === undefined) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      ),
      camera,
    );
    const hit = ray.intersectObject(vrm.scene, true)[0];
    if (hit === undefined) return;
    let best: BodyBone | null = null;
    let bestD = Infinity;
    const at = new THREE.Vector3();
    for (const b of TOUCH_BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(b);
      if (!node) continue;
      const d = node.getWorldPosition(at).distanceTo(hit.point);
      if (d < bestD) [best, bestD] = [b, d];
    }
    if (best !== null) options.onTouch(best);
  };
  canvas.addEventListener("pointerdown", onPointer);

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
    stats: (): BodyStats => ({
      tier,
      frames,
      avgFrameMs: frames === 0 ? 0 : workMs / frames,
      visible: shown && onScreen,
      model,
    }),
    dispose: () => {
      disposed = true;
      hideNow();
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onPointer);
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
