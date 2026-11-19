/**
 * One cue protocol for every 3D body (M-047): the light VRM body in the private page and the VaM plugin read the same
 * JSON lines, so a scene drives both. Cues carry what the spine already decided (mood, gesture, the aligner's visemes,
 * G7 word-timed effects, the group's speaker); a body only renders them and never decides anything itself.
 */
import { decodeSensePack, type SensePack } from "./bodySense.ts";
import {
  decodeTarget,
  decodeTurn,
  decodeWalk,
  type BodyTarget,
  type Turn,
  type Walk,
} from "./bodyLocomotion.ts";
import { HAND_MOTIONS, type HandMotion } from "./bodyHand.ts";
import { decodeHold, decodePerform, type Perform } from "./bodyPlanner.ts";
import { FINGER_KEYS } from "./bodySkills.ts";
import { fireAtMs, type EffectWhen } from "./speechEffects.ts";
import {
  isAct,
  OUTFIT_PIECES,
  POSTURES,
  talkBeats,
  type Act,
  POSE_BONES,
  type Euler,
  type OutfitPiece,
  type PoseBone,
  type PostureName,
} from "./bodyMotion.ts";
import { speechUnits, type Viseme, type VisemeSegment } from "./visemes.ts";

export const BODY_CUE_VERSION = 1;

/** The VRM 1.0 preset expressions a body blends (any VRM 0.x model maps onto them in three-vrm). */
export type VrmPreset =
  | "happy"
  | "angry"
  | "sad"
  | "relaxed"
  | "surprised"
  | "aa"
  | "ih"
  | "ou"
  | "ee"
  | "oh"
  | "blink"
  | "blinkLeft";
export type Weights = Partial<Record<VrmPreset, number>>;

/**
 * Every face library name (expressionMap FACE_LIBRARY) and spine mood as VRM weights. Kept free of the expression map's
 * imports on purpose: those pull the contracts' schemas into the body's page script.
 */
export const BODY_FACES: Readonly<Record<string, Weights>> = {
  neutral: {},
  attentive: { surprised: 0.15 },
  calm: { relaxed: 0.5 },
  steady: { relaxed: 0.5 },
  unimpressed: { relaxed: 0.3, angry: 0.15 },
  bored: { relaxed: 0.4, blink: 0.3 },
  happy: { happy: 0.7 },
  delighted: { happy: 1 },
  laughing: { happy: 1, aa: 0.3 },
  giggle: { happy: 0.8, ih: 0.2 },
  excited: { happy: 0.8, surprised: 0.3 },
  proud: { happy: 0.5, relaxed: 0.3 },
  smug: { happy: 0.4, relaxed: 0.4 },
  relieved: { relaxed: 0.7 },
  playful: { happy: 0.6 },
  wink: { happy: 0.5, blinkLeft: 1 },
  shy: { happy: 0.3, relaxed: 0.3 },
  love: { happy: 0.7, relaxed: 0.4 },
  embarrassed: { happy: 0.3, sad: 0.2 },
  curious: { surprised: 0.3 },
  thinking: { relaxed: 0.2 },
  searching: { surprised: 0.2 },
  skeptical: { angry: 0.2, relaxed: 0.2 },
  dizzy: { surprised: 0.3, sad: 0.2 },
  focused: { angry: 0.15 },
  determined: { angry: 0.3 },
  confused: { sad: 0.2, surprised: 0.2 },
  surprised: { surprised: 1 },
  amazed: { surprised: 0.8, happy: 0.3 },
  nervous: { sad: 0.3, surprised: 0.2 },
  concerned: { sad: 0.4 },
  worried: { sad: 0.5, surprised: 0.2 },
  sad: { sad: 0.8 },
  hurt: { sad: 0.9 },
  crying: { sad: 1 },
  lonely: { sad: 0.6 },
  sulky: { sad: 0.4, angry: 0.3 },
  putout: { angry: 0.3, sad: 0.2 },
  pout: { angry: 0.3, ou: 0.4 },
  annoyed: { angry: 0.5 },
  frustrated: { angry: 0.7 },
  angry: { angry: 1 },
  grumpy: { angry: 0.5 },
  sleepy: { relaxed: 0.6, blink: 0.5 },
  asleep: { relaxed: 0.5, blink: 1 },
};

/** A mood at an intensity as face weights: a faint feeling still shows a little, a strong one fully. */
export const faceWeights = (mood: string, intensity: number): Weights => {
  const k = 0.4 + 0.6 * Math.max(0, Math.min(1, intensity));
  return Object.fromEntries(
    Object.entries(Object.hasOwn(BODY_FACES, mood) ? BODY_FACES[mood]! : {}).map(([p, w]) => [
      p,
      p.startsWith("blink") ? w : w * k,
    ]),
  );
};

/** Mouth shapes per viseme (visemes.ts, the Character Studio's names), at full openness. */
const MOUTH: Readonly<Record<Viseme, Weights>> = {
  rest: {},
  mbp: {},
  fv: { ih: 0.3 },
  th: { ih: 0.3, aa: 0.1 },
  l: { aa: 0.3, ih: 0.2 },
  ee: { ee: 0.8 },
  aa: { aa: 1 },
  uh: { aa: 0.5, ou: 0.2 },
  oh: { oh: 0.9 },
  oo: { ou: 1 },
  sh: { ih: 0.5, ou: 0.3 },
  er: { oh: 0.4, ih: 0.2 },
  etc: { aa: 0.3, ih: 0.3 },
};

/** The mouth for a viseme, opened by the voice's level when the vessel hears one (0..1), else fully. */
export const mouthWeights = (viseme: Viseme | undefined, open = 1): Weights => {
  const o = Math.max(0, Math.min(1, open));
  // no aligned shape yet: the level alone opens the jaw
  if (viseme === undefined) return o > 0.05 ? { aa: 0.7 * o } : {};
  return Object.fromEntries(Object.entries(MOUTH[viseme]).map(([p, w]) => [p, w * o]));
};

/**
 * The intimate expression set (M-047), beside the presets. A renderer builds each from the model's own morphs, its
 * lookAt and small overlays (blush, tears, sweat, skin sheen); a model carrying a custom expression of the same name
 * wins. The private layer decides the weights from her feel; a body only draws them.
 */
export const INTIMATE_STATES = [
  "eyesHalf",
  "eyesRoll",
  "eyesShut",
  "eyesTeary",
  "browsUp",
  "mouthPant",
  "mouthO",
  "mouthBite",
  "tongue",
  "blush",
  "sweat",
  "sheen",
] as const;
export type IntimateState = (typeof INTIMATE_STATES)[number];
export type States = Partial<Record<IntimateState, number>>;

/** Whole-body motion while she is stirred: breath depth, breaths a second, trembling and back arch (0..1 but `breathHz`). */
export interface Motion {
  readonly breath: number;
  readonly breathHz: number;
  readonly tremble: number;
  readonly arch: number;
}
export const STILL: Motion = { breath: 0, breathHz: 0.25, tremble: 0, arch: 0 };

/** Word-timed intimate faces: G7 effects name them like any face, and each holds over her felt state until the line ends. */
export const INTIMATE_FACES: Readonly<
  Record<
    string,
    { readonly face: Weights; readonly states: States; readonly motion?: Partial<Motion> }
  >
> = {
  gasp: { face: { surprised: 0.4 }, states: { mouthO: 0.8, browsUp: 0.5 }, motion: { arch: 0.3 } },
  moan: {
    face: { relaxed: 0.4 },
    states: { mouthO: 0.5, eyesHalf: 0.7, browsUp: 0.7, blush: 0.6 },
  },
  bite: { face: { happy: 0.2 }, states: { mouthBite: 1, eyesHalf: 0.5, browsUp: 0.3, blush: 0.5 } },
  pleading: {
    face: { sad: 0.4 },
    states: { eyesTeary: 0.7, eyesHalf: 0.3, browsUp: 0.9, blush: 0.6 },
  },
  shiver: { face: {}, states: { eyesShut: 0.6, browsUp: 0.4 }, motion: { tremble: 0.7 } },
  melt: {
    face: { relaxed: 0.7 },
    states: { eyesHalf: 0.8, browsUp: 0.5, blush: 0.7, mouthPant: 0.3 },
  },
  peak: {
    face: { surprised: 0.2 },
    states: {
      eyesRoll: 0.8,
      eyesTeary: 0.6,
      browsUp: 1,
      mouthO: 0.6,
      tongue: 0.5,
      blush: 1,
      sweat: 0.6,
    },
    motion: { tremble: 1, arch: 1 },
  },
};

/**
 * Where he touched her: a region id from the sense packs (bodySense.ts), never a fixed list; the private layer
 * decides what a touch there means.
 */
export const REGION_ID = /^[a-zA-Z][\w-]{0,39}$/;

export type BodyBone =
  | "head"
  | "neck"
  | "spine"
  | "chest"
  | "hips"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftShoulder"
  | "rightShoulder"
  | "leftHand"
  | "rightHand";

/** One joint's swing during a gesture: radians on an axis, `cycles` back-and-forths over the gesture's length. */
export interface Swing {
  readonly bone: BodyBone;
  readonly axis: "x" | "y" | "z";
  readonly rad: number;
  readonly cycles: number;
}

/** The public gesture list (tessaya-contracts EXPRESSION_GESTURES) as short procedural moves; none means stillness. */
export const GESTURES: Readonly<
  Record<string, { readonly ms: number; readonly swings: ReadonlyArray<Swing> }>
> = {
  nodSmall: { ms: 600, swings: [{ bone: "head", axis: "x", rad: 0.12, cycles: 1 }] },
  nodSoft: { ms: 900, swings: [{ bone: "head", axis: "x", rad: 0.18, cycles: 2 }] },
  tilt: { ms: 1200, swings: [{ bone: "head", axis: "z", rad: 0.22, cycles: 0.5 }] },
  shrug: {
    ms: 900,
    swings: [
      { bone: "leftShoulder", axis: "z", rad: 0.25, cycles: 0.5 },
      { bone: "rightShoulder", axis: "z", rad: -0.25, cycles: 0.5 },
    ],
  },
  leanIn: { ms: 1600, swings: [{ bone: "spine", axis: "x", rad: 0.16, cycles: 0.5 }] },
  wave: {
    ms: 1600,
    swings: [
      // the arm up to the side, turned so the elbow folds the hand up (not sideways), and the hand waves from the
      // elbow: a turn of the upper arm about its own length, as a person's does
      { bone: "rightUpperArm", axis: "z", rad: -1.0, cycles: 0.5 },
      { bone: "rightUpperArm", axis: "x", rad: -1.45, cycles: 0.5 },
      { bone: "rightLowerArm", axis: "y", rad: 1.35, cycles: 0.5 },
      { bone: "rightUpperArm", axis: "x", rad: 0.28, cycles: 3 },
    ],
  },
  hop: { ms: 500, swings: [{ bone: "spine", axis: "x", rad: -0.08, cycles: 1 }] },
  bounce: { ms: 800, swings: [{ bone: "spine", axis: "x", rad: -0.06, cycles: 2 }] },
  lookAway: { ms: 1400, swings: [{ bone: "head", axis: "y", rad: 0.45, cycles: 0.5 }] },
  chuckle: { ms: 700, swings: [{ bone: "chest", axis: "x", rad: 0.05, cycles: 3 }] },
  sigh: { ms: 1600, swings: [{ bone: "chest", axis: "x", rad: -0.08, cycles: 0.5 }] },
  yawn: { ms: 1800, swings: [{ bone: "head", axis: "x", rad: -0.2, cycles: 0.5 }] },
  startle: { ms: 500, swings: [{ bone: "spine", axis: "x", rad: -0.12, cycles: 0.5 }] },
  dizzy: { ms: 1500, swings: [{ bone: "head", axis: "z", rad: 0.15, cycles: 2 }] },
  thumbsUp: { ms: 1200, swings: [{ bone: "rightUpperArm", axis: "z", rad: -0.7, cycles: 0.5 }] },
  bow: { ms: 1600, swings: [{ bone: "spine", axis: "x", rad: 0.45, cycles: 0.5 }] },
  think: {
    ms: 1600,
    swings: [
      { bone: "head", axis: "z", rad: 0.12, cycles: 0.5 },
      { bone: "head", axis: "x", rad: -0.1, cycles: 0.5 },
    ],
  },
  giggleOnce: { ms: 600, swings: [{ bone: "chest", axis: "x", rad: 0.06, cycles: 2 }] },
  // talking beats (bodyMotion talkBeats): a forearm lifts toward him on a word that carries the line
  beatR: {
    ms: 650,
    swings: [
      { bone: "rightUpperArm", axis: "y", rad: 0.25, cycles: 0.5 },
      { bone: "rightLowerArm", axis: "y", rad: 0.45, cycles: 0.5 },
    ],
  },
  beatL: {
    ms: 650,
    swings: [
      { bone: "leftUpperArm", axis: "y", rad: -0.25, cycles: 0.5 },
      { bone: "leftLowerArm", axis: "y", rad: -0.45, cycles: 0.5 },
    ],
  },
};

/** A swing's angle `t` ms into its gesture: eases out and back so every gesture ends where it began. */
export const swingAt = (s: Swing, ms: number, t: number): number => {
  if (t <= 0 || t >= ms) return 0;
  const p = t / ms;
  const envelope = Math.sin(Math.PI * p);
  return s.cycles <= 0.5
    ? s.rad * envelope
    : s.rad * envelope * Math.sin(2 * Math.PI * s.cycles * p);
};

export type BodyCue =
  | { readonly kind: "show" }
  | { readonly kind: "hide" }
  /** Load a persona's model; the URL is same-origin and gated by the layer, never a public CDN. */
  | { readonly kind: "model"; readonly persona: string; readonly url: string }
  /** The group loop's speaker switch: who the body now is (or faces). */
  | { readonly kind: "speaker"; readonly persona: string }
  /** Affect: the spine's mood at its intensity, plus a private look the model may carry as a custom expression. */
  | {
      readonly kind: "mood";
      readonly mood: string;
      readonly intensity: number;
      readonly look?: string;
      /** The private layer's felt state (0..1), when it has one: how stirred she is and how at ease. */
      readonly arousal?: number;
      readonly comfort?: number;
      /** The intimate set's weights and her body's motion, when the private layer sends them. */
      readonly states?: States;
      readonly motion?: Motion;
    }
  | { readonly kind: "gesture"; readonly gesture: string }
  /** Her whole body turns to a target (bodyLocomotion.ts); the renderer leads with the head, hips follow. */
  | ({ readonly kind: "turn" } & Turn)
  /** She walks to a target in real steps; on the desk the page moves its window along her path. */
  | ({ readonly kind: "walk" } & Walk)
  /** This step's gaze, gesture and touch aim at a target. */
  | { readonly kind: "toward"; readonly to: BodyTarget }
  /** A held posture from a scene beat; "auto" hands her back to the posture her affect picks. */
  | { readonly kind: "pose"; readonly pose: PostureName | "auto" }
  /** Something she does with her body now (bodyMotion ACTS): she chose it in her reply, or a beat did. */
  | { readonly kind: "act"; readonly act: Act }
  /** The outfit pieces she has off right now; every other piece is on. */
  | { readonly kind: "outfit"; readonly off: ReadonlyArray<OutfitPiece> }
  /** A keyframed clip from the owner's extensions (humanoid Euler per bone), played now; held at its end unless it loops. */
  | {
      readonly kind: "clip";
      readonly id: string;
      readonly fps: number;
      readonly loop: boolean;
      readonly grounded: boolean;
      readonly frames: ReadonlyArray<Partial<Record<PoseBone, Euler>>>;
      /** How long the body takes to arrive (direct control); her own pace when absent. */
      readonly ms?: number;
      /** A live stream's frame: let go this long after it unless another comes (dead-man lapse). */
      readonly lapseMs?: number;
    }
  /** Where she looks, -1..1 across (her left +) and up, for `ms`; then back to him. */
  /** A library move's physics-trained version, by entry id: the body plays it when it has one, else ignores this. */
  | { readonly kind: "baked"; readonly entry: string; readonly id: string }
  | { readonly kind: "gaze"; readonly x: number; readonly y: number; readonly ms: number }
  /** A hand (an agent's, or a second body's) on a part of her, moving as `motion` for `ms` (bodyHand.ts). */
  | {
      readonly kind: "hand";
      readonly part: string;
      readonly pull?: readonly [number, number, number];
      readonly motion: HandMotion;
      readonly pressure: number;
      readonly ms: number;
    }
  /** The model's own shape keys by name (0..1), held until set again; 0 lets one go. */
  | { readonly kind: "morphs"; readonly weights: Readonly<Record<string, number>> }
  /** Face weights held for `ms` over her mood's face. */
  | { readonly kind: "face"; readonly weights: Weights; readonly ms: number }
  /** A whole performance the body composes over its current posture (bodyPlanner.ts), `bones` part of its base. */
  | {
      readonly kind: "perform";
      readonly id: string;
      readonly perform: Perform;
      /** What the agent placed itself, kept as placed: held bones, and keys over time. */
      readonly bones?: Partial<Record<PoseBone, Euler>>;
      readonly keys?: ReadonlyArray<{
        readonly atMs: number;
        readonly bones: Partial<Record<PoseBone, Euler>>;
      }>;
      /** Channels the same step set itself (its own look or face), which the performance leaves alone. */
      readonly keep?: ReadonlyArray<"look" | "face">;
    }
  /** Her involuntary systems held back for ms each (breath, blink, saccade, moodLeak, sway). */
  | { readonly kind: "hold"; readonly systems: Readonly<Record<string, number>> }
  /** Cues the body plays by its own clock, each `atMs` after this one arrives (a move's later steps). */
  | {
      readonly kind: "seq";
      readonly steps: ReadonlyArray<{
        readonly atMs: number;
        readonly cues: ReadonlyArray<BodyCue>;
      }>;
    }
  /** She pulls free of any hand holding her. */
  | { readonly kind: "free" }
  /** A sense pack (bodySense.ts): regions, receptors and reflex arcs her skin adds or overrides, by pack id. */
  | { readonly kind: "sense"; readonly pack: SensePack }
  /** Extra touch regions: within `radius` m of a humanoid bone, a touch is that region (a sense pack, older form). */
  | {
      readonly kind: "zones";
      readonly zones: ReadonlyArray<{
        readonly id: string;
        readonly bone: string;
        readonly radius: number;
      }>;
      /** Regions past MAX_ZONES that were not kept (the body warns), so a large pack never loses some silently. */
      readonly dropped?: number;
    }
  /** A state or face drawn with the model's own expressions at these weights. */
  | {
      readonly kind: "expressions";
      readonly map: Readonly<
        Record<string, ReadonlyArray<{ readonly name: string; readonly weight: number }>>
      >;
    }
  /** A prop held on a bone (gated by the layer like models); no url puts it away. */
  | {
      readonly kind: "prop";
      readonly id: string;
      readonly url?: string;
      readonly bone?: BodyBone;
      /** Its live state: running or not, how strongly, how fast (its own animation's speed). */
      readonly on?: boolean;
      readonly intensity?: number;
      readonly speed?: number;
    }
  /** Stop word, Stop button or auto-off: every prop, gesture and line ends at once. */
  | { readonly kind: "stop" }
  /** A line spoken from now: its mouth track and word-timed effects, ms after the cue arrives. */
  | {
      readonly kind: "speak";
      readonly track: ReadonlyArray<VisemeSegment>;
      readonly effects: ReadonlyArray<{
        readonly atMs: number;
        readonly face?: string;
        readonly gesture?: string;
        readonly act?: Act;
      }>;
    }
  /** Live audio from the vessel playing her voice: its level and the viseme aligned at this moment. */
  | { readonly kind: "level"; readonly value: number; readonly viseme?: Viseme }
  | { readonly kind: "silent" };

const VISEMES = new Set<string>(Object.keys(MOUTH));
const FACE_PRESET_NAMES = new Set<string>([
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
]);
const BONES = new Set<string>([
  "head",
  "neck",
  "spine",
  "chest",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
  "leftShoulder",
  "rightShoulder",
  "leftHand",
  "rightHand",
  "hips",
]);
// a blob: URL is minted only by this page's own script (a model it already fetched or he dropped in)
const sameOrigin = (url: string) =>
  (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) || url.startsWith("blob:");
const num = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;
const str = (v: unknown, max = 200) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

const STATE_NAMES = new Set<string>(INTIMATE_STATES);
const parseStates = (v: unknown): States | null => {
  if (v === null || typeof v !== "object") return null;
  const out = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).flatMap(([k, w]) => {
      const n = num(w, 0, 1);
      return STATE_NAMES.has(k) && n !== null ? [[k, n]] : [];
    }),
  );
  return Object.keys(out).length > 0 ? out : null;
};

/** Reads one cue off the wire (page, plugin socket); null when it is not one. Every body decodes through this. */
/** How many touch regions one zones cue keeps: a safety bound far above any real pack (one held 83). */
export const MAX_ZONES = 1024;

export const parseCue = (raw: unknown): BodyCue | null => {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  switch (c["kind"]) {
    case "show":
    case "hide":
    case "silent":
    case "stop":
      return { kind: c["kind"] };
    case "model": {
      const persona = str(c["persona"], 64);
      const url = str(c["url"], 500);
      // same-origin paths only, so a cue can never point a body at another host
      return persona && url && sameOrigin(url) ? { kind: "model", persona, url } : null;
    }
    case "speaker": {
      const persona = str(c["persona"], 64);
      return persona ? { kind: "speaker", persona } : null;
    }
    case "mood": {
      const mood = str(c["mood"], 32);
      const intensity = num(c["intensity"], 0, 1);
      const look = str(c["look"], 32);
      const arousal = num(c["arousal"], 0, 1);
      const comfort = num(c["comfort"], 0, 1);
      const states = parseStates(c["states"]);
      const m = c["motion"];
      const motion =
        m !== null && typeof m === "object"
          ? {
              breath: num((m as Record<string, unknown>)["breath"], 0, 1) ?? 0,
              breathHz: num((m as Record<string, unknown>)["breathHz"], 0.1, 1.5) ?? STILL.breathHz,
              tremble: num((m as Record<string, unknown>)["tremble"], 0, 1) ?? 0,
              arch: num((m as Record<string, unknown>)["arch"], 0, 1) ?? 0,
            }
          : null;
      return mood && intensity !== null
        ? {
            kind: "mood",
            mood,
            intensity,
            ...(look ? { look } : {}),
            ...(arousal === null ? {} : { arousal }),
            ...(comfort === null ? {} : { comfort }),
            ...(states === null ? {} : { states }),
            ...(motion === null ? {} : { motion }),
          }
        : null;
    }
    case "gesture": {
      const gesture = str(c["gesture"], 32);
      return gesture ? { kind: "gesture", gesture } : null;
    }
    case "turn": {
      const t = decodeTurn(c);
      return typeof t === "string" ? null : { kind: "turn", ...t };
    }
    case "walk": {
      const w = decodeWalk(c);
      return typeof w === "string" ? null : { kind: "walk", ...w };
    }
    case "toward": {
      const to = decodeTarget(c["to"]);
      return to === null ? null : { kind: "toward", to };
    }
    case "pose": {
      const pose = c["pose"];
      return pose === "auto" || (typeof pose === "string" && Object.hasOwn(POSTURES, pose))
        ? { kind: "pose", pose: pose as PostureName | "auto" }
        : null;
    }
    case "act":
      return isAct(c["act"]) ? { kind: "act", act: c["act"] } : null;
    case "perform": {
      const id = str(c["id"], 60);
      const p = decodePerform(c["perform"]);
      const bones = new Set<string>(POSE_BONES);
      const pose = (v: unknown): Partial<Record<PoseBone, Euler>> =>
        Object.fromEntries(
          Object.entries((v ?? {}) as Record<string, unknown>).flatMap(([b, r]) =>
            bones.has(b) &&
            Array.isArray(r) &&
            r.length === 3 &&
            r.every((x) => num(x, -Math.PI, Math.PI) !== null)
              ? [[b, r as unknown as Euler]]
              : [],
          ),
        );
      const base = pose(c["bones"]);
      const keys = (Array.isArray(c["keys"]) ? c["keys"] : []).slice(0, 32).flatMap((k) => {
        const at = num((k as { atMs?: unknown } | null)?.atMs, 0, 20_000);
        return at === null ? [] : [{ atMs: at, bones: pose((k as { bones?: unknown }).bones) }];
      });
      return id && p.ok
        ? {
            kind: "perform",
            id,
            perform: p.perform,
            ...(Object.keys(base).length === 0 ? {} : { bones: base }),
            ...(keys.length < 2 ? {} : { keys }),
            ...(Array.isArray(c["keep"])
              ? {
                  keep: (["look", "face"] as const).filter((k) =>
                    (c["keep"] as ReadonlyArray<unknown>).includes(k),
                  ),
                }
              : {}),
          }
        : null;
    }
    case "hold": {
      const h = decodeHold(c["systems"]);
      return h.ok ? { kind: "hold", systems: h.hold } : null;
    }
    case "baked": {
      const entry = str(c["entry"], 64);
      const id = str(c["id"], 64);
      return entry && id ? { kind: "baked", entry, id } : null;
    }
    case "clip": {
      const id = str(c["id"], 40);
      const bones = new Set<string>([...POSE_BONES, ...FINGER_KEYS]);
      const angle = (v: unknown) => num(v, -Math.PI, Math.PI);
      const frames = (Array.isArray(c["frames"]) ? c["frames"] : []).slice(0, 3600).map((f) =>
        Object.fromEntries(
          Object.entries((f ?? {}) as Record<string, unknown>).flatMap(([b, r]) => {
            const e = Array.isArray(r) && r.length === 3 ? r.map(angle) : null;
            return bones.has(b) && e !== null && e.every((x) => x !== null)
              ? [[b, e as unknown as Euler]]
              : [];
          }),
        ),
      );
      return id && frames.length > 0
        ? {
            kind: "clip",
            id,
            fps: num(c["fps"], 1, 60) ?? 30,
            loop: c["loop"] === true,
            grounded: c["grounded"] === true,
            frames,
            ...(num(c["ms"], 80, 5000) === null ? {} : { ms: num(c["ms"], 80, 5000)! }),
            ...(num(c["lapseMs"], 200, 5000) === null
              ? {}
              : { lapseMs: num(c["lapseMs"], 200, 5000)! }),
          }
        : null;
    }
    case "free":
      return { kind: "free" };
    case "sense": {
      const d = decodeSensePack(c["pack"]);
      return d.ok ? { kind: "sense", pack: d.pack } : null;
    }
    case "zones": {
      // every region a pack sends is kept; past the safety bound the rest are counted, never silently lost
      const all = Array.isArray(c["zones"]) ? c["zones"] : [];
      const zones = all.slice(0, MAX_ZONES).flatMap((z) => {
        const r = (z ?? {}) as Record<string, unknown>;
        const id = str(r["id"], 40);
        const bone = str(r["bone"], 40);
        const radius = num(r["radius"], 0.01, 0.3);
        return id && bone && radius !== null ? [{ id, bone, radius }] : [];
      });
      return {
        kind: "zones",
        zones,
        ...(all.length > MAX_ZONES ? { dropped: all.length - MAX_ZONES } : {}),
      };
    }
    case "expressions": {
      const m = c["map"];
      if (m === null || typeof m !== "object") return null;
      const map = Object.fromEntries(
        Object.entries(m as Record<string, unknown>)
          .slice(0, 64)
          .flatMap(([target, use]) => {
            const list = (Array.isArray(use) ? use : []).slice(0, 8).flatMap((u) => {
              const r = (u ?? {}) as Record<string, unknown>;
              const name = str(r["name"], 64);
              const weight = num(r["weight"], 0, 1);
              return name && weight !== null ? [{ name, weight }] : [];
            });
            return str(target, 32) && list.length > 0 ? [[target, list]] : [];
          }),
      );
      return { kind: "expressions", map };
    }
    case "outfit": {
      const pieces = new Set<string>(OUTFIT_PIECES);
      const off = Array.isArray(c["off"])
        ? c["off"].filter((p): p is OutfitPiece => typeof p === "string" && pieces.has(p))
        : null;
      return off === null ? null : { kind: "outfit", off: [...new Set(off)] };
    }
    case "prop": {
      const id = str(c["id"], 64);
      const url = c["url"] === undefined ? undefined : str(c["url"], 500);
      const bone =
        typeof c["bone"] === "string" && BONES.has(c["bone"]) ? (c["bone"] as BodyBone) : undefined;
      if (!id || url === null || (url !== undefined && !sameOrigin(url))) return null;
      const intensity = num(c["intensity"], 0, 1);
      const speed = num(c["speed"], 0, 3);
      return {
        kind: "prop",
        id,
        ...(url ? { url } : {}),
        ...(bone ? { bone } : {}),
        ...(typeof c["on"] === "boolean" ? { on: c["on"] } : {}),
        ...(intensity === null ? {} : { intensity }),
        ...(speed === null ? {} : { speed }),
      };
    }
    case "hand": {
      const part = c["part"];
      const motion = c["motion"];
      if (typeof part !== "string" || !REGION_ID.test(part)) return null;
      const p = c["pull"];
      const pull =
        Array.isArray(p) &&
        p.length === 3 &&
        p.every((v) => typeof v === "number" && Math.abs(v) <= 0.3)
          ? ([p[0], p[1], p[2]] as const)
          : null;
      if (!(HAND_MOTIONS as ReadonlyArray<unknown>).includes(motion)) return null;
      return {
        kind: "hand",
        part,
        motion: motion as HandMotion,
        pressure: num(c["pressure"], 0, 1) ?? 0.4,
        ms: num(c["ms"], 150, 10_000) ?? 1500,
        ...(pull === null ? {} : { pull }),
      };
    }
    case "gaze": {
      const x = num(c["x"], -1, 1);
      const y = num(c["y"], -1, 1);
      return x === null || y === null
        ? null
        : { kind: "gaze", x, y, ms: num(c["ms"], 100, 20_000) ?? 2500 };
    }
    case "face": {
      const w = c["weights"];
      if (w === null || typeof w !== "object") return null;
      const weights: Weights = Object.fromEntries(
        Object.entries(w as Record<string, unknown>).flatMap(([k, v]) => {
          const n = num(v, 0, 1);
          return FACE_PRESET_NAMES.has(k) && n !== null ? [[k, n]] : [];
        }),
      );
      return { kind: "face", weights, ms: num(c["ms"], 100, 20_000) ?? 3000 };
    }
    case "morphs": {
      const w = c["weights"];
      if (w === null || typeof w !== "object") return null;
      const weights = Object.fromEntries(
        Object.entries(w as Record<string, unknown>)
          .slice(0, 64)
          .flatMap(([k, v]) => {
            const n = num(v, 0, 1);
            return k.length > 0 && k.length <= 64 && n !== null ? [[k, n]] : [];
          }),
      );
      return { kind: "morphs", weights };
    }
    case "seq": {
      // one level deep: a step's cues are plain cues, never another sequence
      // a move's steps or a whole scene (bodyScene): up to 64 beats over ten minutes
      const steps = (Array.isArray(c["steps"]) ? c["steps"] : []).slice(0, 64).flatMap((s) => {
        const r = (s ?? {}) as Record<string, unknown>;
        const atMs = num(r["atMs"], 0, 600_000);
        const cues = (Array.isArray(r["cues"]) ? r["cues"] : [])
          .slice(0, 12)
          .map(parseCue)
          .filter((x): x is BodyCue => x !== null && x.kind !== "seq");
        return atMs === null ? [] : [{ atMs, cues }];
      });
      return steps.length === 0 ? null : { kind: "seq", steps };
    }
    case "level": {
      const value = num(c["value"], 0, 1);
      const viseme =
        typeof c["viseme"] === "string" && VISEMES.has(c["viseme"])
          ? (c["viseme"] as Viseme)
          : undefined;
      return value === null ? null : { kind: "level", value, ...(viseme ? { viseme } : {}) };
    }
    case "speak": {
      const track = (Array.isArray(c["track"]) ? c["track"] : [])
        .slice(0, 4000)
        .flatMap((s): VisemeSegment[] => {
          const r = (s ?? {}) as Record<string, unknown>;
          const at = num(r["at"], 0, 600_000);
          const end = num(r["end"], 0, 600_000);
          const v = r["viseme"];
          return at !== null && end !== null && end >= at && typeof v === "string" && VISEMES.has(v)
            ? [{ at, end, viseme: v as Viseme }]
            : [];
        });
      const effects = (Array.isArray(c["effects"]) ? c["effects"] : [])
        .slice(0, 50)
        .flatMap((e) => {
          const r = (e ?? {}) as Record<string, unknown>;
          const atMs = num(r["atMs"], 0, 600_000);
          const face = str(r["face"], 32);
          const gesture = str(r["gesture"], 32);
          const act = isAct(r["act"]) ? r["act"] : null;
          return atMs === null || (!face && !gesture && !act)
            ? []
            : [
                {
                  atMs,
                  ...(face ? { face } : {}),
                  ...(gesture ? { gesture } : {}),
                  ...(act ? { act } : {}),
                },
              ];
        });
      return { kind: "speak", track, effects };
    }
    default:
      return null;
  }
};

/** Nominal length of each unit kind when no audio times it (ms): vowels carry, stops are brief, pauses breathe. */
const NOMINAL: Readonly<Record<string, number>> = {
  V: 110,
  G: 60,
  H: 160,
  N: 70,
  B: 70,
  F: 80,
  C: 55,
  P: 40,
};

/**
 * A line's mouth track without audio alignment: the text's visemes at nominal lengths, stretched to the sentence's
 * measured duration when the vessel knows it, and pinned to the aligner's word starts where it has them.
 */
export const textTrack = (
  text: string,
  timing: {
    readonly durationMs?: number;
    readonly wordMs?: ReadonlyArray<number | undefined>;
  } = {},
  /** Filled with each word's start (ms), when given. */
  wordAt?: number[],
): VisemeSegment[] => {
  const units = speechUnits(text);
  const nominal = units.map((u) =>
    u.kind === "P" ? (u.skip ?? 0) * 25 + NOMINAL["P"]! : NOMINAL[u.kind]!,
  );
  const total = nominal.reduce((a, b) => a + b, 0);
  const scale = timing.durationMs !== undefined && total > 0 ? timing.durationMs / total : 1;
  const out: VisemeSegment[] = [];
  let at = 0;
  let lastWord = -1;
  for (const [i, u] of units.entries()) {
    // a word the aligner heard starts where it heard it
    const pinned =
      u.word !== undefined && u.word !== lastWord ? timing.wordMs?.[u.word] : undefined;
    if (pinned !== undefined && pinned >= at) at = pinned;
    if (u.word !== undefined && u.word !== lastWord && wordAt) wordAt[u.word] = Math.round(at);
    if (u.word !== undefined) lastWord = u.word;
    const end = at + nominal[i]! * scale;
    out.push({ at: Math.round(at), end: Math.round(end), viseme: u.viseme });
    at = end;
  }
  return out;
};

/**
 * One spoken line as cues: the mood as it arrives, the gesture, and the speech with its G7 effects placed on their
 * words (`fireAtMs` on a timeline that starts now, so `atMs` is ms after the cue).
 */
export const lineCues = (line: {
  readonly persona?: string;
  readonly text: string;
  readonly mood: string;
  readonly intensity: number;
  readonly gesture?: string;
  readonly look?: string;
  readonly durationMs?: number;
  readonly wordMs?: ReadonlyArray<number | undefined>;
  readonly effects?: ReadonlyArray<{
    readonly when: EffectWhen;
    readonly face?: string;
    readonly gesture?: string;
    readonly act?: Act;
  }>;
}): BodyCue[] => {
  const wordAt: number[] = [];
  const track = textTrack(line.text, line, wordAt);
  const durationMs = track.at(-1)?.end ?? 0;
  const timeline = {
    nowMs: 0,
    endMs: durationMs,
    sentences: [
      { startMs: 0, durationMs, text: line.text, ...(line.wordMs ? { wordMs: line.wordMs } : {}) },
    ],
  };
  const effects = (line.effects ?? []).flatMap((e) => {
    const atMs = fireAtMs(e.when, timeline);
    return atMs === null
      ? []
      : [
          {
            atMs,
            ...(e.face ? { face: e.face } : {}),
            ...(e.gesture ? { gesture: e.gesture } : {}),
            ...(e.act ? { act: e.act } : {}),
          },
        ];
  });
  // her hands and head keep time with the words, clear of any gesture the line's effects already place
  const words = line.text.match(/[^\s]+/g) ?? [];
  const beats = talkBeats(words.map((text, i) => ({ text, atMs: wordAt[i] ?? 0 }))).filter(
    (b) =>
      !effects.some(
        (e) => (e.gesture !== undefined || e.act !== undefined) && Math.abs(e.atMs - b.atMs) < 700,
      ),
  );
  return [
    ...(line.persona ? [{ kind: "speaker", persona: line.persona } as const] : []),
    {
      kind: "mood",
      mood: line.mood,
      intensity: line.intensity,
      ...(line.look ? { look: line.look } : {}),
    },
    ...(line.gesture && line.gesture !== "none"
      ? [{ kind: "gesture", gesture: line.gesture } as const]
      : []),
    {
      kind: "speak",
      track,
      effects: [...effects, ...beats].toSorted((a, b) => a.atMs - b.atMs),
    },
  ];
};

const EARS_DOWN = new Set([
  "sad",
  "hurt",
  "crying",
  "lonely",
  "concerned",
  "worried",
  "nervous",
  "sulky",
  "putout",
  "pout",
  "sleepy",
  "asleep",
  "embarrassed",
  "shy",
]);
const EARS_BACK = new Set(["angry", "annoyed", "frustrated", "grumpy"]);
const WAGS = new Set([
  "happy",
  "delighted",
  "laughing",
  "giggle",
  "excited",
  "playful",
  "love",
  "proud",
  "amazed",
]);

/**
 * Ears and tail on a kemonomimi model, from her affect: ears perk when she is curious or surprised, droop when low,
 * pin back when cross or ill at ease; the tail wags with joy and arousal, flicks when cross, hangs when low. Pitch is
 * radians (negative is flattened back); a wag is a short burst after the mood arrives, never a continuous loop.
 */
export const beastkin = (input: {
  readonly mood: string;
  readonly intensity: number;
  readonly arousal?: number;
  readonly comfort?: number;
  readonly motion?: Motion;
}): {
  readonly earPitch: number;
  /** Radians of a fast ear twitch while she trembles. */
  readonly earQuiver: number;
  readonly tailHz: number;
  readonly tailAmp: number;
  /** Positive hangs the tail, negative lifts it (an arch raises it stiff). */
  readonly tailDroop: number;
} => {
  const k = Math.max(0, Math.min(1, input.intensity));
  const arousal = input.arousal ?? 0;
  const uneasy = 1 - (input.comfort ?? 1);
  let earPitch = 0;
  if (["curious", "surprised", "amazed", "attentive", "excited"].includes(input.mood))
    earPitch = 0.25 * k;
  if (EARS_DOWN.has(input.mood)) earPitch = -0.5 * k;
  if (EARS_BACK.has(input.mood)) earPitch = -0.9 * k;
  // ill at ease pins the ears whatever the mood says
  if (uneasy > 0.3) earPitch = Math.min(earPitch, -0.9 * uneasy);
  const arch = input.motion?.arch ?? 0;
  // arching back flattens the ears whatever else shows
  if (arch > 0.3) earPitch = Math.min(earPitch, -0.8 * arch);
  const wag = WAGS.has(input.mood) ? k : 0;
  const cross = EARS_BACK.has(input.mood) ? k : 0;
  return {
    earPitch,
    earQuiver: 0.03 * (input.motion?.tremble ?? 0),
    tailHz: cross > 0 ? 3 : 1.2 + 1.8 * Math.max(wag, arousal),
    tailAmp: Math.max(0.35 * wag, 0.25 * arousal, 0.15 * cross) * (1 - uneasy) * (1 - 0.7 * arch),
    tailDroop: (EARS_DOWN.has(input.mood) ? 0.5 * k : 0) - 0.6 * arch,
  };
};
