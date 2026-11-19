/**
 * The body's control language (M-065, the digital nervous system): intent (act, posture, gesture, mood, gaze) and direct
 * control (bones, face, keys) in one bounded move with timed steps. Pure: decoding, the cues a move becomes, whether it
 * needs a private moment, the per-caller rate gate, and what the body reports back (proprioception).
 */
import {
  decodeTarget,
  decodeTurn,
  decodeWalk,
  TARGET_HELP,
  type BodyTarget,
  type Turn,
  type Walk,
} from "./bodyLocomotion.ts";
import {
  BODY_FACES,
  GESTURES,
  INTIMATE_FACES,
  REGION_ID,
  type BodyCue,
  type VrmPreset,
} from "./bodyCues.ts";
import { HUMAN_SENSE } from "./bodySense.ts";
import { HAND_MOTIONS, type HandMotion } from "./bodyHand.ts";
import {
  ACT_NAMES,
  ACTS,
  POSE_BONES,
  POSTURE_NAMES,
  isAct,
  type Act,
  type Euler,
  type PoseBone,
  type PostureName,
} from "./bodyMotion.ts";
import { recall } from "./bodyLibrary.ts";
import { MOTION_LIBRARY } from "./bodyMotionLibrary.ts";
import { decodeHold, decodePerform, INVOLUNTARY, type Perform } from "./bodyPlanner.ts";
import { JOINT_LIMITS } from "./bodyRig.ts";

export const BODY_MOVE_VERSION = 1;
/** Postures, faces and acts that belong to a private moment only. */
const PRIVATE_POSTURES: ReadonlySet<string> = new Set(["aroused"]);
/**
 * Parts a hand other than his may touch outside a private moment: the general map's everyday regions. A region only
 * a pack names (his, on a custom bone) may be private, and nothing here can tell, so it waits for a private moment.
 */
const EVERYDAY_REGIONS: ReadonlyArray<string> = HUMAN_SENSE.regions
  .filter((r) => r.private !== true)
  .map((r) => r.id);
const FACE_PRESETS = [
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
] as const satisfies ReadonlyArray<VrmPreset>;
const MAX_STEPS = 8;
const STREAMABLE: ReadonlySet<string> = new Set(["stream", "bones", "look", "face", "ms"]);
/** A stream lets go this long after its last frame, unless another comes. */
export const STREAM_LAPSE_MS = 1000;
const MAX_KEYS = 32;
const MAX_MS = 20_000;

export interface BodyMove {
  /** Something she does with her whole body (ACTS), or an extension act's name in a private moment. */
  readonly act?: string;
  readonly posture?: PostureName | "auto";
  readonly gesture?: string;
  readonly mood?: { readonly name: string; readonly intensity: number };
  /** Where she looks: -1..1 across (her left +) and up; held `ms` then back to him. */
  readonly look?: { readonly x: number; readonly y: number; readonly ms: number };
  /** Face weights (VRM presets 0..1), held `ms`. */
  readonly face?: { readonly weights: Partial<Record<VrmPreset, number>>; readonly ms: number };
  /** The model's own shape keys by name (its manifest lists them), 0..1, held until set again. */
  readonly morphs?: Readonly<Record<string, number>>;
  /** Bones in VRM 1.0 axes from the T-pose (radians), reached over `ms`, held until released. */
  readonly bones?: Partial<Record<PoseBone, Euler>>;
  readonly ms?: number;
  /** A keyframed motion: each key's bones at `atMs`, played once (or looped) and held at its end. */
  readonly keys?: ReadonlyArray<{
    readonly atMs: number;
    readonly bones: Partial<Record<PoseBone, Euler>>;
  }>;
  readonly loop?: boolean;
  /** A hand on her (an agent's, or a second body's): where, how it moves, how firmly (0..1), for how long. */
  readonly touch?: {
    readonly part: string;
    readonly motion: HandMotion;
    readonly pressure: number;
    readonly ms: number;
    /** With grab: where the hand pulls what it holds, metres in her frame (her left +x, up +y, toward him +z). */
    readonly pull?: readonly [number, number, number];
  };
  /** Hand her body back to her own feelings: drop held bones, posture and keyframes. */
  readonly release?: boolean;
  /** She pulls free of any hand holding her (her own will: a grab never overrides it). */
  readonly free?: boolean;
  /** Whom or where this step's gaze, gesture and touch aim at (another body, him); eyes only on a one-body vessel. */
  readonly toward?: BodyTarget;
  /** Her whole body turning to a target. */
  readonly turn?: Turn;
  /** Walking to a target, in real steps (the renderer's). */
  readonly walk?: Walk;
  /**
   * A whole performance composed for this body from how the moment feels and moves (bodyPlanner.ts): over this step's
   * posture; the step's own `bones` and `keys` stay as placed, and the performance moves everything else.
   */
  readonly perform?: Perform;
  /** Her involuntary systems held back, each up to a person's limit (INVOLUNTARY): {breath: 5000}. */
  readonly hold?: Readonly<Record<string, number>>;
  /**
   * One frame of a live stream of direct control (bones, look, face), up to STREAM_RATE a second. The body
   * lets go and returns to her own posture when no frame comes within STREAM_LAPSE_MS (a dead-man lapse).
   */
  readonly stream?: boolean;
  /** More of the same, each `afterMs` from the start: one request, one coordinated performance. */
  readonly then?: ReadonlyArray<BodyMove & { readonly afterMs: number }>;
}

export type Decoded =
  | { readonly ok: true; readonly move: BodyMove }
  | { readonly ok: false; readonly error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;
const BONES: ReadonlySet<string> = new Set(POSE_BONES);
/** Bones as [x, y, z] radians, each clamped to ±π; unknown bones are an error the caller can fix. */
const bonesOf = (v: unknown): Partial<Record<PoseBone, Euler>> | string => {
  if (!isObj(v)) return "bones must be an object of bone: [x, y, z]";
  const out: Partial<Record<PoseBone, Euler>> = {};
  for (const [b, r] of Object.entries(v)) {
    if (!BONES.has(b)) return `unknown bone ${b}; bones are ${POSE_BONES.join(", ")}`;
    if (
      !Array.isArray(r) ||
      r.length !== 3 ||
      !r.every((x) => typeof x === "number" && Number.isFinite(x))
    )
      return `bone ${b} needs [x, y, z] in radians`;
    out[b as PoseBone] = r.map((x: number) =>
      Math.max(-Math.PI, Math.min(Math.PI, x)),
    ) as unknown as Euler;
  }
  return out;
};

const decodeOne = (raw: unknown, depth: number): Decoded => {
  if (!isObj(raw)) return { ok: false, error: "a move is an object" };
  // an intent in words: her library's nearest validated performance, under whatever else this step says
  if (typeof raw["intent"] === "string") {
    const { intent, ...rest } = raw;
    // the server may have found the entry by meaning already, and names it by id
    const byId = MOTION_LIBRARY.find((e) => e.id === intent);
    const hit =
      byId === undefined ? recall(String(intent).slice(0, 200), MOTION_LIBRARY) : { entry: byId };
    if (hit === null && Object.keys(rest).length === 0)
      return {
        ok: false,
        error: `her motion library has nothing near "${String(intent).slice(0, 60)}": give a perform (feel) or other fields`,
      };
    const own = (hit?.entry.move ?? {}) as Record<string, unknown>;
    // its later steps stay unless this step brings its own
    return decodeOne(
      { ...own, ...rest, ...(rest["then"] === undefined ? {} : { then: rest["then"] }) },
      depth,
    );
  }
  const m: Record<string, unknown> = {};
  if (raw["act"] !== undefined) {
    if (typeof raw["act"] !== "string" || !/^[a-zA-Z][\w-]{0,39}$/.test(raw["act"]))
      return { ok: false, error: "act is a name" };
    m["act"] = raw["act"];
  }
  if (raw["posture"] !== undefined) {
    if (
      raw["posture"] !== "auto" &&
      !(POSTURE_NAMES as ReadonlyArray<unknown>).includes(raw["posture"])
    )
      return { ok: false, error: `posture is one of ${POSTURE_NAMES.join(", ")} or auto` };
    m["posture"] = raw["posture"];
  }
  if (raw["gesture"] !== undefined) {
    if (typeof raw["gesture"] !== "string" || !Object.hasOwn(GESTURES, raw["gesture"]))
      return { ok: false, error: `gesture is one of ${Object.keys(GESTURES).join(", ")}` };
    m["gesture"] = raw["gesture"];
  }
  if (raw["mood"] !== undefined) {
    const mood = raw["mood"];
    const name = isObj(mood) ? mood["name"] : mood;
    if (
      typeof name !== "string" ||
      !(Object.hasOwn(BODY_FACES, name) || Object.hasOwn(INTIMATE_FACES, name))
    )
      return { ok: false, error: `mood is one of ${Object.keys(BODY_FACES).join(", ")}` };
    m["mood"] = { name, intensity: num(isObj(mood) ? mood["intensity"] : undefined, 0, 1) ?? 0.6 };
  }
  if (raw["toward"] !== undefined) {
    const t = decodeTarget(raw["toward"]);
    if (t === null) return { ok: false, error: `toward: ${TARGET_HELP}` };
    m["toward"] = t;
  }
  if (raw["turn"] !== undefined) {
    const t = decodeTurn(raw["turn"]);
    if (typeof t === "string") return { ok: false, error: t };
    m["turn"] = t;
  }
  if (raw["walk"] !== undefined) {
    const w = decodeWalk(raw["walk"]);
    if (typeof w === "string") return { ok: false, error: w };
    m["walk"] = w;
  }
  if (raw["look"] !== undefined) {
    const l = raw["look"];
    if (!isObj(l)) return { ok: false, error: "look is {x, y} from -1 to 1" };
    m["look"] = {
      x: num(l["x"], -1, 1) ?? 0,
      y: num(l["y"], -1, 1) ?? 0,
      ms: num(l["ms"], 200, MAX_MS) ?? 2500,
    };
  }
  if (raw["face"] !== undefined) {
    const f = raw["face"];
    const w = isObj(f) && isObj(f["weights"]) ? f["weights"] : f;
    if (!isObj(w)) return { ok: false, error: "face is {weights: {happy: 0.6, ...}, ms}" };
    const weights: Partial<Record<VrmPreset, number>> = {};
    for (const [k, v] of Object.entries(w)) {
      if (!(FACE_PRESETS as ReadonlyArray<string>).includes(k))
        return { ok: false, error: `face weights are ${FACE_PRESETS.join(", ")}` };
      weights[k as VrmPreset] = num(v, 0, 1) ?? 0;
    }
    m["face"] = { weights, ms: num(isObj(f) ? f["ms"] : undefined, 200, MAX_MS) ?? 3000 };
  }
  if (raw["morphs"] !== undefined) {
    const w = raw["morphs"];
    if (!isObj(w) || Object.keys(w).length > 64)
      return { ok: false, error: "morphs is {shapeKey: 0..1}, up to 64" };
    m["morphs"] = Object.fromEntries(
      Object.entries(w).map(([k, v]) => [k.slice(0, 64), num(v, 0, 1) ?? 0]),
    );
  }
  if (raw["bones"] !== undefined) {
    const b = bonesOf(raw["bones"]);
    if (typeof b === "string") return { ok: false, error: b };
    m["bones"] = b;
  }
  if (raw["ms"] !== undefined) m["ms"] = num(raw["ms"], 80, 5000) ?? 450;
  if (raw["keys"] !== undefined) {
    if (!Array.isArray(raw["keys"]) || raw["keys"].length < 2 || raw["keys"].length > MAX_KEYS)
      return { ok: false, error: `keys are 2 to ${MAX_KEYS} {atMs, bones}` };
    const keys: Array<{ atMs: number; bones: Partial<Record<PoseBone, Euler>> }> = [];
    for (const k of raw["keys"]) {
      if (!isObj(k)) return { ok: false, error: "each key is {atMs, bones}" };
      const at = num(k["atMs"], 0, MAX_MS);
      const b = bonesOf(k["bones"]);
      if (at === null) return { ok: false, error: "each key needs atMs" };
      if (typeof b === "string") return { ok: false, error: b };
      if (keys.length > 0 && at <= keys.at(-1)!.atMs)
        return { ok: false, error: "keys must be in time order" };
      keys.push({ atMs: at, bones: b });
    }
    m["keys"] = keys;
    if (raw["loop"] === true) m["loop"] = true;
  }
  if (raw["touch"] !== undefined) {
    const t = raw["touch"];
    if (!isObj(t) || typeof t["part"] !== "string" || !REGION_ID.test(t["part"]))
      return {
        ok: false,
        error: `touch is {part, motion, pressure, ms}; part is a region of her, such as ${EVERYDAY_REGIONS.join(", ")}`,
      };
    const motion = t["motion"] ?? "rest";
    if (!(HAND_MOTIONS as ReadonlyArray<unknown>).includes(motion))
      return { ok: false, error: `touch motion is one of ${HAND_MOTIONS.join(", ")}` };
    const pull = t["pull"];
    if (
      pull !== undefined &&
      (motion !== "grab" ||
        !Array.isArray(pull) ||
        pull.length !== 3 ||
        !pull.every((v) => typeof v === "number" && Math.abs(v) <= 0.3))
    )
      return {
        ok: false,
        error:
          "touch pull is [x, y, z] in metres (each at most 0.3; her left +x, up +y, toward him +z), with motion grab",
      };
    m["touch"] = {
      part: t["part"],
      motion,
      pressure: num(t["pressure"], 0, 1) ?? 0.4,
      ms: num(t["ms"], 150, 10_000) ?? 1500,
      ...(pull === undefined ? {} : { pull }),
    };
  }
  if (raw["release"] === true) m["release"] = true;
  if (raw["free"] === true) m["free"] = true;
  if (raw["perform"] !== undefined) {
    const p = decodePerform(raw["perform"]);
    if (!p.ok) return p;
    m["perform"] = p.perform;
  }
  if (raw["hold"] !== undefined) {
    const h = decodeHold(raw["hold"]);
    if (!h.ok) return h;
    m["hold"] = h.hold;
  }
  if (raw["stream"] === true) {
    const extra = Object.keys(raw).filter((k) => !STREAMABLE.has(k));
    if (extra.length > 0)
      return {
        ok: false,
        error: `a stream frame carries only bones, look, face and ms; send ${extra.join(", ")} as a move`,
      };
    m["stream"] = true;
  }
  if (raw["then"] !== undefined) {
    if (depth > 0) return { ok: false, error: "steps cannot have steps" };
    if (!Array.isArray(raw["then"]) || raw["then"].length > MAX_STEPS)
      return { ok: false, error: `then is up to ${MAX_STEPS} steps` };
    const steps: Array<BodyMove & { afterMs: number }> = [];
    for (const s of raw["then"]) {
      const d = decodeOne(s, 1);
      if (!d.ok) return d;
      const after = num(isObj(s) ? s["afterMs"] : undefined, 0, MAX_MS);
      if (after === null) return { ok: false, error: "each step needs afterMs" };
      steps.push({ ...d.move, afterMs: after });
    }
    m["then"] = steps;
  }
  if (Object.keys(m).length === 0)
    return {
      ok: false,
      error:
        "nothing to do: give a perform, act, posture, gesture, mood, look, face, morphs, bones, keys, touch, hold, release or free",
    };
  return { ok: true, move: m as BodyMove };
};
/** A move off the wire (an MCP tool, the bridge), bounded and checked; errors say how to fix the request. */
export const decodeBodyMove = (raw: unknown): Decoded => decodeOne(raw, 0);

const flat = (m: BodyMove): ReadonlyArray<BodyMove> => [m, ...(m.then ?? [])];
/** Needs a private moment: a private posture or face, or an act that is not one of her everyday ones (an extension). */
export const isPrivateMove = (m: BodyMove): boolean =>
  flat(m).some(
    (s) =>
      (s.posture !== undefined && PRIVATE_POSTURES.has(s.posture)) ||
      (s.mood !== undefined && Object.hasOwn(INTIMATE_FACES, s.mood.name)) ||
      (s.act !== undefined && !isAct(s.act)) ||
      (s.touch !== undefined && !EVERYDAY_REGIONS.includes(s.touch.part)),
  );
/** Acts a private moment resolves itself (owner extensions), in order. */
export const extensionActs = (m: BodyMove): ReadonlyArray<string> =>
  flat(m).flatMap((s) => (s.act !== undefined && !isAct(s.act) ? [s.act] : []));

/** Keyframes as a clip at 30 fps: each frame interpolated between its keys, so any renderer just plays it. */
const keysToFrames = (
  keys: NonNullable<BodyMove["keys"]>,
): Array<Partial<Record<PoseBone, Euler>>> => {
  const end = keys.at(-1)!.atMs;
  const frames: Array<Partial<Record<PoseBone, Euler>>> = [];
  for (let t = 0; t <= end + 1; t += 1000 / 30) {
    const i = Math.max(
      0,
      keys.findLastIndex((k) => k.atMs <= t),
    );
    const a = keys[i]!;
    const b = keys[Math.min(keys.length - 1, i + 1)]!;
    const u = b.atMs === a.atMs ? 0 : Math.min(1, (t - a.atMs) / (b.atMs - a.atMs));
    const frame: Partial<Record<PoseBone, Euler>> = {};
    for (const bone of new Set([
      ...Object.keys(a.bones),
      ...Object.keys(b.bones),
    ]) as Set<PoseBone>) {
      const x = a.bones[bone] ?? b.bones[bone]!;
      const y = b.bones[bone] ?? x;
      frame[bone] = [0, 1, 2].map((k) => x[k]! + (y[k]! - x[k]!) * u) as unknown as Euler;
    }
    frames.push(frame);
  }
  return frames;
};

/** One step's cues, in the order the body should take them. */
const stepCues = (m: BodyMove, id: string): BodyCue[] => {
  const out: BodyCue[] = [];
  if (m.release === true) out.push({ kind: "pose", pose: "auto" });
  if (m.free === true) out.push({ kind: "free" });
  if (m.posture !== undefined) out.push({ kind: "pose", pose: m.posture });
  if (m.act !== undefined && isAct(m.act)) out.push({ kind: "act", act: m.act as Act });
  if (m.mood !== undefined)
    out.push({ kind: "mood", mood: m.mood.name, intensity: m.mood.intensity });
  if (m.turn !== undefined) out.push({ kind: "turn", ...m.turn });
  if (m.walk !== undefined) out.push({ kind: "walk", ...m.walk });
  if (m.toward !== undefined) out.push({ kind: "toward", to: m.toward });
  if (m.gesture !== undefined) out.push({ kind: "gesture", gesture: m.gesture });
  // a stream's gaze and face last only until the lapse; each frame renews them
  const hold = (ms: number) => (m.stream === true ? STREAM_LAPSE_MS : ms);
  if (m.look !== undefined)
    out.push({ kind: "gaze", x: m.look.x, y: m.look.y, ms: hold(m.look.ms) });
  if (m.face !== undefined)
    out.push({ kind: "face", weights: m.face.weights, ms: hold(m.face.ms) });
  if (m.morphs !== undefined) out.push({ kind: "morphs", weights: m.morphs });
  if (m.touch !== undefined) out.push({ kind: "hand", ...m.touch });
  if (m.hold !== undefined) out.push({ kind: "hold", systems: m.hold });
  // last, so the body composes it over the posture this step chose; the step's bones are part of its base
  if (m.perform !== undefined)
    out.push({
      kind: "perform",
      id: `${id}-perform`,
      perform: m.perform,
      ...(m.bones === undefined ? {} : { bones: m.bones }),
      ...(m.keys === undefined ? {} : { keys: m.keys }),
      // her own look or face in this step is what she chose: the performance leaves it alone
      ...(m.look === undefined && m.face === undefined
        ? {}
        : {
            keep: [
              ...(m.look === undefined ? [] : (["look"] as const)),
              ...(m.face === undefined ? [] : (["face"] as const)),
            ],
          }),
    });
  else if (m.keys !== undefined)
    out.push({
      kind: "clip",
      id: `${id}-keys`,
      fps: 30,
      loop: m.loop === true,
      grounded: false,
      frames: keysToFrames(m.keys),
      ...(m.ms === undefined ? {} : { ms: m.ms }),
    });
  else if (m.bones !== undefined)
    out.push({
      kind: "clip",
      id: `${id}-bones`,
      fps: 30,
      loop: false,
      grounded: false,
      frames: [m.bones],
      // a stream's frames follow closely (unless it says otherwise) and lapse when they stop
      ...(m.ms === undefined ? (m.stream === true ? { ms: 80 } : {}) : { ms: m.ms }),
      ...(m.stream === true ? { lapseMs: STREAM_LAPSE_MS } : {}),
    });
  return out;
};
/** The cues a move becomes: its first step now, later steps as one timed sequence the body plays by its own clock. */
export const moveCues = (m: BodyMove, id = "move"): BodyCue[] => {
  const now = stepCues(m, id);
  const later = (m.then ?? []).map((s, i) => ({
    atMs: s.afterMs,
    cues: stepCues(s, `${id}-${i + 1}`),
  }));
  return later.length === 0 ? now : [...now, { kind: "seq", steps: later }];
};

/**
 * Requests per caller: a burst of `burst`, refilled at `perSecond`. Pure: the state goes in and comes out, so the
 * service keeps one per caller and tests drive time directly. A body is not a stream: keys and steps carry motion.
 */
export interface RateState {
  readonly tokens: number;
  readonly at: number;
}
export const RATE = { burst: 12, perSecond: 4 } as const;
/** Stream frames have their own bucket, so a live stream never starves a caller's moves. */
export const STREAM_RATE = { burst: 30, perSecond: 30 } as const;
export const rateGate = (
  s: RateState | undefined,
  now: number,
  r: { readonly burst: number; readonly perSecond: number } = RATE,
): { readonly ok: boolean; readonly state: RateState; readonly retryMs: number } => {
  const was = s ?? { tokens: r.burst, at: now };
  const tokens = Math.min(r.burst, was.tokens + ((now - was.at) / 1000) * r.perSecond);
  if (tokens < 1)
    return {
      ok: false,
      state: { tokens, at: now },
      retryMs: Math.ceil(((1 - tokens) / r.perSecond) * 1000),
    };
  return { ok: true, state: { tokens: tokens - 1, at: now }, retryMs: 0 };
};

/** What a body reports of itself (proprioception), from the renderer drawing it; null fields are unknown. */
export interface BodyState {
  readonly at: number;
  readonly vessel: string;
  readonly model: string | null;
  readonly posture: string;
  readonly moving: boolean;
  /** Each posed bone's rotation (VRM 1.0 axes, radians, 3 decimals). */
  readonly bones: Readonly<Record<string, readonly [number, number, number]>>;
  readonly face: Readonly<Record<string, number>>;
  readonly gaze: { readonly x: number; readonly y: number } | null;
  /** What the rig had to correct in the last pose, so an agent can learn the body's limits. */
  readonly corrected: ReadonlyArray<{
    readonly bone: string;
    readonly kind: string;
    readonly by: number;
  }>;
  /** Where she is touching herself or something now (hand on hip): part, what it meets. */
  readonly contacts: ReadonlyArray<{ readonly part: string; readonly with: string }>;
  /** Her whole body's yaw (rad): 0 toward him, + turned to her left. Where she is on the desk is the host's to report. */
  readonly facing?: number;
  readonly walking?: boolean;
  /**
   * A hand holding her now (bodyGrab.ts): what it holds (skin, hair, cloth, accessory) and where, the bone the pull
   * acts through, how hard (0..~2, past ~1 a firm full pull), how far what is held is stretched (0..1), and which way
   * it pulls in her frame (her left +x, up +y, toward him +z).
   */
  readonly heldBy?: {
    readonly kind: string;
    readonly region: string;
    readonly root: string;
    readonly force: number;
    readonly stretch: number;
    readonly toward: readonly [number, number, number];
  };
  /** What her nerves feel under a hand on her now (bodySense.ts): the region, how strongly, and the reflexes it set off. */
  readonly felt?: {
    readonly region: string;
    readonly intensity: number;
    readonly kind: string;
    readonly cmPerS: number;
    readonly reflexes: ReadonlyArray<string>;
  };
  /** What her body is doing on its own (the involuntary layer), and what is held back and for how much longer. */
  readonly involuntary?: Readonly<
    Record<string, { readonly on: boolean; readonly heldMs?: number }>
  >;
  readonly manifest: unknown;
}

/** What any body can be asked to do: the vocabulary and the limits, before the model is known. */
export const BODY_CAPABILITIES = {
  version: BODY_MOVE_VERSION,
  acts: ACT_NAMES.map((a) => ({ act: a, ...ACTS[a] })),
  postures: POSTURE_NAMES.filter((p) => !PRIVATE_POSTURES.has(p)),
  gestures: Object.keys(GESTURES),
  moods: Object.keys(BODY_FACES),
  faceWeights: FACE_PRESETS,
  touch: {
    parts: EVERYDAY_REGIONS,
    motions: HAND_MOTIONS,
    pull: "with grab: [x, y, z] metres, each at most 0.3 (her left +x, up +y, toward him +z); a hair pull tilts her head toward it",
  },
  bones: POSE_BONES,
  axes: "VRM 1.0 normalized from a T-pose: she faces +z, her left is +x; Euler XYZ in radians. Arms down: leftUpperArm z -1.2, rightUpperArm z 1.2. Elbows fold on y (left -, right +); knees on x (+); trunk bends forward on x (+).",
  limits: Object.fromEntries(
    Object.entries(JOINT_LIMITS)
      .filter(([b]) => BONES.has(b))
      .map(([b, l]) => [
        b,
        { twist: l.twist, swing: [l.uRange, l.vRange], hinge: l.hinge === true },
      ]),
  ),
  rate: RATE,
  stream: { rate: STREAM_RATE, lapseMs: STREAM_LAPSE_MS },
  involuntary: INVOLUNTARY.map((s) => ({ system: s.id, ...s.override })),
  /** Her motion library's validated performances, by the words that asked for them: an `intent` near one plays it. */
  motions: MOTION_LIBRARY.map((m) => m.text),
} as const;
