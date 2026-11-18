/**
 * The body's motion set and touch map (M-047, M-057), pure so web, desktop and the phone's private window share them:
 * held postures for every affect and scene beat, word-timed talking beats, where a touch on her lands, and what kind
 * of touch it was. Poses are authored here (no mocap files), in VRM 1.0 normalized axes: she faces +z, her left is +x.
 */
import type { TouchZone } from "./bodyCues.ts";

export type Vec3 = readonly [number, number, number];
export type Euler = Vec3;

/** The humanoid bones a posture moves; legs stay out of every standing posture so planted feet never slide. */
export type PoseBone =
  | "hips"
  | "spine"
  | "chest"
  | "upperChest"
  | "neck"
  | "head"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand"
  | "leftUpperLeg"
  | "rightUpperLeg"
  | "leftLowerLeg"
  | "rightLowerLeg"
  | "leftFoot"
  | "rightFoot";
export const POSE_BONES: ReadonlyArray<PoseBone> = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "rightShoulder",
  "leftUpperArm",
  "rightUpperArm",
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
];

export interface Posture {
  readonly bones: Partial<Record<PoseBone, Euler>>;
  /** Lowered to the floor (sitting, lying): the renderer grounds her lowest bone instead of standing on her feet. */
  readonly grounded?: boolean;
  /** Breath rate and depth at rest in this posture (breaths a second, 0..1). */
  readonly breathHz?: number;
  readonly breath?: number;
}

const down = { leftUpperArm: [0, 0, -1.2], rightUpperArm: [0, 0, 1.2] } as const;
const soft = { leftLowerArm: [0, -0.15, 0], rightLowerArm: [0, 0.15, 0] } as const;

/** Every held posture. Arms come in front of the body by turning forward (y), never through it (z past the hips). */
export const POSTURES = {
  stand: { bones: { ...down, ...soft } },
  happy: {
    bones: {
      ...down,
      ...soft,
      spine: [-0.03, 0, 0],
      chest: [-0.04, 0, 0],
      head: [-0.04, 0, -0.06],
      leftShoulder: [0, 0, -0.04],
      rightShoulder: [0, 0, 0.04],
    },
    breathHz: 0.3,
  },
  playful: {
    // hands behind her back, up on her toes a little, head tilted (arms swing back on x, elbows fold on y)
    bones: {
      leftUpperArm: [0.87, -0.53, -1.4],
      rightUpperArm: [0.87, 0.53, 1.4],
      leftLowerArm: [0, -1.19, 0],
      rightLowerArm: [0, 1.19, 0],
      chest: [-0.05, 0, 0],
      head: [0, 0.05, 0.12],
    },
    breathHz: 0.32,
  },
  teasing: {
    // weight on one hip, a hand at her waist, chin down and eyes up at him
    bones: {
      leftUpperArm: [0, 0.25, -0.8],
      leftLowerArm: [0, 0, -1.6],
      leftHand: [0, 0, 0.3],
      rightUpperArm: [0, 0, 1.2],
      rightLowerArm: [0, 0.2, 0],
      spine: [0, 0, 0.05],
      chest: [0, 0.08, 0.03],
      head: [0.1, -0.06, -0.12],
    },
  },
  shy: {
    // hands together in front, shoulders in, head down and turned a little away
    bones: {
      leftUpperArm: [0.1, -0.82, -1.2],
      rightUpperArm: [0.1, 0.82, 1.2],
      leftLowerArm: [0, -1.18, 0],
      rightLowerArm: [0, 1.18, 0],
      leftShoulder: [0, -0.08, 0.04],
      rightShoulder: [0, 0.08, -0.04],
      spine: [0.05, 0, 0],
      head: [0.2, 0.18, 0.05],
    },
  },
  affectionate: {
    // hands clasped at her chest, leaning toward him, head tilted
    bones: {
      leftUpperArm: [0, -0.7, -1.0],
      rightUpperArm: [0, 0.7, 1.0],
      leftLowerArm: [0, -1.45, 0],
      rightLowerArm: [0, 1.45, 0],
      spine: [0.06, 0, 0],
      head: [0.05, 0, 0.14],
    },
    breathHz: 0.24,
  },
  aroused: {
    // chest open and lifted, chin up a little, arms loose: breath and flush come from her feel
    bones: {
      ...down,
      leftLowerArm: [0, -0.3, 0],
      rightLowerArm: [0, 0.3, 0],
      spine: [-0.04, 0, 0.03],
      chest: [-0.07, 0, 0],
      head: [-0.06, 0, -0.08],
      leftShoulder: [0, 0, -0.06],
      rightShoulder: [0, 0, 0.06],
    },
    breathHz: 0.45,
    breath: 0.5,
  },
  sad: {
    bones: {
      leftUpperArm: [0, -0.1, -1.28],
      rightUpperArm: [0, 0.1, 1.28],
      leftLowerArm: [0, -0.3, 0],
      rightLowerArm: [0, 0.3, 0],
      leftShoulder: [0, 0, 0.08],
      rightShoulder: [0, 0, -0.08],
      spine: [0.1, 0, 0],
      chest: [0.06, 0, 0],
      head: [0.28, 0, 0],
    },
    breathHz: 0.18,
  },
  sleepy: {
    bones: { ...down, ...soft, spine: [0.06, 0, 0], head: [0.22, 0, 0.16] },
    breathHz: 0.15,
  },
  guarded: {
    // arms folded in front, leaning back from him
    bones: {
      leftUpperArm: [0, -0.6, -1.05],
      rightUpperArm: [0, 0.6, 1.05],
      leftLowerArm: [0, -1.7, 0],
      rightLowerArm: [0, 1.7, 0],
      spine: [-0.06, 0, 0],
      head: [-0.02, 0.1, 0],
    },
  },
  hug: {
    // arms open forward and round, as if around him
    bones: {
      leftUpperArm: [0, -0.85, -0.3],
      rightUpperArm: [0, 0.85, 0.3],
      leftLowerArm: [0, -0.55, 0],
      rightLowerArm: [0, 0.55, 0],
      spine: [0.1, 0, 0],
      head: [0.06, 0, 0.18],
    },
  },
  reach: {
    // her right hand out to him
    bones: {
      leftUpperArm: [0, 0, -1.2],
      leftLowerArm: [0, -0.15, 0],
      rightUpperArm: [0, 1.25, 0.25],
      rightLowerArm: [0, 0.15, 0],
      spine: [0.08, 0, 0],
      head: [0.02, 0, 0],
    },
  },
  turn: {
    // the upper body turns to look back over her shoulder; hips and feet stay put
    bones: {
      ...down,
      ...soft,
      spine: [0, 0.2, 0],
      chest: [0, 0.2, 0],
      neck: [0, 0.2, 0],
      head: [0, 0.25, 0],
    },
  },
  sit: {
    // kneeling sit (seiza): thighs forward, shins folded under, hands on her lap
    bones: {
      leftUpperLeg: [-1.5, 0, 0],
      rightUpperLeg: [-1.5, 0, 0],
      leftLowerLeg: [2.85, 0, 0],
      rightLowerLeg: [2.85, 0, 0],
      leftFoot: [0.6, 0, 0],
      rightFoot: [0.6, 0, 0],
      leftUpperArm: [0, -0.45, -1.15],
      rightUpperArm: [0, 0.45, 1.15],
      leftLowerArm: [0, -0.55, 0],
      rightLowerArm: [0, 0.55, 0],
      spine: [0.04, 0, 0],
    },
    grounded: true,
    breathHz: 0.22,
  },
  lie: {
    // on her side facing him, head on her arm, knees drawn up a little
    bones: {
      hips: [0, 0, 1.5],
      leftUpperLeg: [-0.35, 0, 0],
      rightUpperLeg: [-0.5, 0, 0],
      leftLowerLeg: [0.6, 0, 0],
      rightLowerLeg: [0.75, 0, 0],
      rightUpperArm: [0, 0.3, 0.1],
      rightLowerArm: [0, 1.8, 0],
      leftUpperArm: [0, -0.4, -1.1],
      leftLowerArm: [0, -0.4, 0],
      head: [0, 0, -0.25],
    },
    grounded: true,
    breathHz: 0.18,
  },
} as const satisfies Record<string, Posture>;
export type PostureName = keyof typeof POSTURES;
export const POSTURE_NAMES = Object.keys(POSTURES) as ReadonlyArray<PostureName>;
/** Scene postures a beat holds until another beat (or "auto") hands her back to her feelings. */
export const SCENE_POSTURES: ReadonlySet<string> = new Set([
  "hug",
  "reach",
  "turn",
  "sit",
  "lie",
  "step",
]);

const TEASING = new Set(["smug", "wink", "teasing", "skeptical"]);
const PLAYFUL = new Set(["playful", "giggle", "excited", "laughing"]);
const HAPPY = new Set(["happy", "delighted", "proud", "amazed", "relieved"]);
const SHY = new Set(["shy", "embarrassed", "nervous"]);
const FOND = new Set(["love", "affectionate", "calm", "relaxed", "steady"]);
const SAD = new Set(["sad", "hurt", "crying", "lonely", "concerned", "worried", "sulky", "putout"]);
const SLEEPY = new Set(["sleepy", "asleep", "bored"]);

/**
 * Her posture from her affect: discomfort guards first, then a stirred body opens, then the mood itself. A scene beat's
 * posture (sit, lie, hug...) outranks all of these and is chosen by the beat, not here.
 */
export const postureFor = (affect: {
  readonly mood: string;
  readonly intensity: number;
  readonly arousal?: number;
  readonly comfort?: number;
}): PostureName => {
  const comfort = affect.comfort ?? 1;
  const arousal = affect.arousal ?? 0;
  if (comfort < 0.35) return "guarded";
  if (arousal >= 0.5 && comfort >= 0.5) return SHY.has(affect.mood) ? "shy" : "aroused";
  if (affect.intensity < 0.15) return "stand";
  const m = affect.mood;
  if (TEASING.has(m)) return "teasing";
  if (PLAYFUL.has(m)) return "playful";
  if (HAPPY.has(m)) return "happy";
  if (SHY.has(m)) return "shy";
  if (FOND.has(m)) return affect.intensity >= 0.4 ? "affectionate" : "stand";
  if (SAD.has(m)) return "sad";
  if (SLEEPY.has(m)) return "sleepy";
  return "stand";
};

/** A posture eased in over `ms`: the crossfade weight `t` ms after it was chosen (smoothstep, 0..1). */
export const blendAt = (t: number, ms = 450): number => {
  const p = Math.max(0, Math.min(1, t / ms));
  return p * p * (3 - 2 * p);
};

/** Stepping in place: one knee lifts while the other foot stays planted, alternating every half `periodMs`. */
export const stepAt = (
  t: number,
  periodMs = 1100,
): Partial<Record<"leftUpperLeg" | "rightUpperLeg" | "leftLowerLeg" | "rightLowerLeg", Euler>> => {
  const p = (t % periodMs) / periodMs;
  const lift = Math.sin(Math.PI * ((p * 2) % 1));
  const left = p < 0.5;
  const thigh: Euler = [-0.45 * lift, 0, 0];
  const shin: Euler = [0.8 * lift, 0, 0];
  return left
    ? { leftUpperLeg: thigh, leftLowerLeg: shin }
    : { rightUpperLeg: thigh, rightLowerLeg: shin };
};

/** Talking beats: small hand lifts and nods on the words that carry a line, never closer than `gapMs`. */
export const BEAT_GESTURES = ["beatR", "nodSmall", "beatL"] as const;
export const talkBeats = (
  words: ReadonlyArray<{ readonly text: string; readonly atMs: number }>,
  gapMs = 900,
): Array<{ atMs: number; gesture: (typeof BEAT_GESTURES)[number] }> => {
  const out: Array<{ atMs: number; gesture: (typeof BEAT_GESTURES)[number] }> = [];
  let last = -Infinity;
  for (const [i, w] of words.entries()) {
    const bare = w.text.replace(/[^\p{L}\p{N}]/gu, "");
    // a long word, a stressed one, or the first word after a pause
    const carries =
      bare.length >= 6 ||
      /[!?]$/.test(w.text) ||
      /^[A-Z]{2,}$/.test(bare) ||
      (i > 0 && /[,.;:]$/.test(words[i - 1]!.text));
    if (!carries || w.atMs - last < gapMs) continue;
    out.push({ atMs: w.atMs, gesture: BEAT_GESTURES[out.length % BEAT_GESTURES.length]! });
    last = w.atMs;
  }
  return out;
};

/**
 * Every kind of touch she can tell apart. Kiss and hug come from the page's "touch as" choice; trace from his pointer
 * moving over her with nothing pressed (fingertips trailing across her); the rest from a press.
 */
export const TOUCH_KINDS = [
  "tap",
  "poke",
  "pat",
  "stroke",
  "caress",
  "rub",
  "tickle",
  "hold",
  "squeeze",
  "grab",
  "pinch",
  "kiss",
  "hug",
  "trace",
] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];
export const HOLD_MS = 450;

/** What the page measured of one touch: one pointer or two, how long, how far, how fast, how hard. */
export interface TouchSample {
  readonly ms: number;
  /** Total path length in CSS px. */
  readonly travelPx: number;
  /** Times the path turned back on itself (a rub or a tickle goes to and fro). */
  readonly reversals?: number;
  /** Quick taps in this burst, this one included (a pat is three or more). */
  readonly taps?: number;
  readonly pointers?: number;
  /** Change in the distance between two fingers (negative closes them: a pinch). */
  readonly spreadPx?: number;
  /** Pointer pressure 0..1 where the device reports it (mouse and most screens give 0.5). */
  readonly pressure?: number;
  /** No button pressed: a mouse moving over her (phones have no hover). */
  readonly hover?: boolean;
  /** How long a hover has stayed on this part of her. */
  readonly dwellMs?: number;
}

/** The kind of touch, and how strong and how fast it was (0..1 each). */
export const readTouch = (
  t: TouchSample,
): { kind: TouchKind; intensity: number; speed: number } => {
  const pressure = t.pressure ?? 0.5;
  const pxPerS = t.ms > 0 ? (t.travelPx * 1000) / t.ms : 0;
  const speed = Math.min(1, pxPerS / 1200);
  const firm = Math.max(0, Math.min(1, (pressure - 0.5) * 2));
  let kind: TouchKind;
  if (t.hover === true) {
    // fingertips: always light, felt more the longer he stays on one place
    const dwell = Math.min(1, (t.dwellMs ?? 0) / 4000);
    return {
      kind: "trace",
      intensity: Math.round((0.2 + 0.3 * dwell) * 100) / 100,
      speed: Math.round(speed * 100) / 100,
    };
  }
  if ((t.pointers ?? 1) >= 2) kind = (t.spreadPx ?? 0) <= -20 ? "pinch" : "squeeze";
  else if (t.travelPx >= 24) {
    const turns = t.reversals ?? 0;
    kind =
      turns >= 4 && pxPerS > 280
        ? "tickle"
        : turns >= 2
          ? "rub"
          : pxPerS < 260
            ? "caress"
            : "stroke";
  } else if (t.ms >= HOLD_MS) kind = pressure >= 0.75 ? "grab" : "hold";
  else if ((t.taps ?? 1) >= 3) kind = "pat";
  else kind = t.ms < 120 && pressure >= 0.6 ? "poke" : "tap";
  const intensity =
    kind === "caress" ? 0.3 + 0.3 * firm : Math.min(1, 0.35 + 0.4 * firm + 0.25 * speed);
  return {
    kind,
    intensity: Math.round(intensity * 100) / 100,
    speed: Math.round(speed * 100) / 100,
  };
};
/** The face she makes the instant she feels each kind (BODY_FACES names), before the layer's feel comes back. */
export const TOUCH_FACE: Readonly<Record<TouchKind, string>> = {
  tap: "attentive",
  poke: "surprised",
  pat: "happy",
  stroke: "relieved",
  caress: "love",
  rub: "relaxed",
  tickle: "giggle",
  hold: "calm",
  squeeze: "surprised",
  grab: "surprised",
  pinch: "hurt",
  kiss: "shy",
  hug: "love",
  trace: "shy",
};

/** A hover over one part of her, throttled: moved this far, she feels it at most this often, or once when it rests. */
export const TRACE_PX = 24;
export const TRACE_EVERY_MS = 600;
export const TRACE_LINGER_MS = 1200;
export interface Trace {
  readonly zone: string;
  readonly since: number;
  readonly movedAt: number;
  /** When she last felt it; null before the first time on this part of her. */
  readonly sentAt: number | null;
  readonly travel: number;
  readonly lingered: boolean;
}
/**
 * One step of a hover: the pointer moved `travelPx` over `zone` (null: off her), or rested (travelPx 0, from a one-shot
 * timer). Continuous motion becomes one felt trace per TRACE_EVERY_MS; a new part of her is felt at once; a resting
 * pointer is felt once as a linger. Returns what she feels now, if anything.
 */
export const traceStep = (
  was: Trace | null,
  zone: string | null,
  travelPx: number,
  now: number,
): { trace: Trace | null; feel: ReturnType<typeof readTouch> | null } => {
  if (zone === null) return { trace: null, feel: null };
  const t: Trace =
    was === null || was.zone !== zone
      ? { zone, since: now, movedAt: now, sentAt: null, travel: travelPx, lingered: false }
      : travelPx > 0
        ? { ...was, movedAt: now, travel: was.travel + travelPx, lingered: false }
        : was;
  const lingers = travelPx === 0 && !t.lingered && now - t.movedAt >= TRACE_LINGER_MS;
  const moves = t.travel >= TRACE_PX && (t.sentAt === null || now - t.sentAt >= TRACE_EVERY_MS);
  if (!lingers && !moves) return { trace: t, feel: null };
  const feel = readTouch({
    ms: lingers ? 0 : Math.max(100, now - (t.sentAt ?? t.since)),
    travelPx: lingers ? 0 : t.travel,
    hover: true,
    dwellMs: now - t.since,
  });
  return { trace: { ...t, sentAt: now, travel: 0, lingered: t.lingered || lingers }, feel };
};
/** The short form: tap, stroke or hold. */
export const touchKind = (ms: number, travelPx: number): TouchKind =>
  travelPx >= 24 ? "stroke" : ms >= HOLD_MS ? "hold" : "tap";

/**
 * What she does with her own body, chosen by her in her reply (an `acts` channel like props) or by a scene beat, each
 * timed to a word. Each is a held posture, a one-off gesture, a step toward or away from him, or a rhythm (dance).
 * Sexual positions and acts are not in this vocabulary (M-055).
 */
export const ACTS = {
  stand: { posture: "auto" },
  sit: { posture: "sit" },
  lie: { posture: "lie" },
  lean: { posture: "affectionate", closer: 0.15 },
  cuddle: { posture: "hug", closer: 0.35 },
  hug: { posture: "hug", closer: 0.3 },
  reach: { posture: "reach" },
  turnAway: { posture: "turn" },
  walkOver: { posture: "auto", closer: 0.4, steps: true },
  stepBack: { posture: "auto", closer: -0.3, steps: true },
  dance: { posture: "auto", dance: true },
  wave: { gesture: "wave" },
  nod: { gesture: "nodSoft" },
  shrug: { gesture: "shrug" },
  bow: { gesture: "bow" },
  giggle: { gesture: "giggleOnce" },
  sigh: { gesture: "sigh" },
  stretch: { gesture: "yawn" },
} as const satisfies Record<
  string,
  {
    readonly posture?: PostureName | "auto";
    readonly gesture?: string;
    /** Metres toward him (negative steps back), walked in steps when `steps`. */
    readonly closer?: number;
    readonly steps?: boolean;
    readonly dance?: boolean;
  }
>;
export type Act = keyof typeof ACTS;
export const ACT_NAMES = Object.keys(ACTS) as ReadonlyArray<Act>;
export const isAct = (v: unknown): v is Act => typeof v === "string" && Object.hasOwn(ACTS, v);

/** Dancing in place: a hip sway, swinging arms and alternating knee bends on a beat; feet stay where they are. */
export const danceAt = (t: number, bpm = 100): Partial<Record<PoseBone, Euler>> => {
  const beat = (t / 60000) * bpm;
  const sway = Math.sin(Math.PI * beat);
  const bob = Math.abs(Math.sin(Math.PI * beat));
  return {
    spine: [0, 0.08 * sway, 0.06 * sway],
    chest: [-0.03 * bob, 0.06 * sway, 0],
    head: [0.05 * bob, -0.08 * sway, -0.06 * sway],
    leftUpperArm: [0, -0.35 - 0.25 * sway, -1.0],
    rightUpperArm: [0, 0.35 - 0.25 * sway, 1.0],
    leftLowerArm: [0, -0.9, 0],
    rightLowerArm: [0, 0.9, 0],
  };
};

/**
 * Her outfit from the model's own material names (VRoid: N00_002_03_Tops_01_CLOTH): the pieces that can come off.
 * Models with clothing painted on the skin have none, and say so rather than pretend.
 */
export const OUTFIT_PIECES = [
  "tops",
  "onepiece",
  "bottoms",
  "socks",
  "shoes",
  "gloves",
  "accessory",
] as const;
export type OutfitPiece = (typeof OUTFIT_PIECES)[number];
export const outfitPiece = (material: string): OutfitPiece | null => {
  if (!/cloth|accessor/i.test(material)) return null;
  const m = material.toLowerCase();
  return OUTFIT_PIECES.find((p) => m.includes(p === "accessory" ? "accessor" : p)) ?? null;
};

/** The skeleton a touch is mapped on: world positions of the model's humanoid joints (any may be missing). */
export type Joint =
  | "head"
  | "neck"
  | "upperChest"
  | "chest"
  | "spine"
  | "hips"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand"
  | "leftUpperLeg"
  | "rightUpperLeg"
  | "leftLowerLeg"
  | "rightLowerLeg"
  | "leftFoot"
  | "rightFoot"
  | "leftToes"
  | "rightToes";
export type Skeleton = Partial<Record<Joint, Vec3>>;
export const BODY_JOINTS: ReadonlyArray<Joint> = [
  "head",
  "neck",
  "upperChest",
  "chest",
  "spine",
  "hips",
  "leftShoulder",
  "rightShoulder",
  "leftUpperArm",
  "rightUpperArm",
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
  "leftToes",
  "rightToes",
];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (a: Vec3, d: Vec3, k: number): Vec3 => [
  a[0] + d[0] * k,
  a[1] + d[1] * k,
  a[2] + d[2] * k,
];
/** Distance from p to the segment a..b, and how far along it the nearest point sits (0..1). */
const toSegment = (p: Vec3, a: Vec3, b: Vec3): { d: number; t: number } => {
  const ab = sub(b, a);
  const len = dot(ab, ab);
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len));
  const q = along(a, ab, t);
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), t };
};

/**
 * Which part of her a touch at `p` landed on. Limbs are capsules along their bones (so the top of the thigh is thigh,
 * however near the hip joint it sits); the trunk is split by height between her own joints and by side (front, back,
 * flanks). `mesh` is the hit mesh's name, which settles hair and face on models that name them (VRoid does).
 */
export const touchZoneAt = (p: Vec3, j: Skeleton, mesh = ""): TouchZone | null => {
  const { head, neck, hips } = j;
  if (head === undefined || hips === undefined) return null;
  const chest = j.chest ?? j.upperChest ?? j.spine ?? hips;
  const top = j.upperChest ?? chest;
  const neckAt = neck ?? along(top, sub(head, top), 0.6);
  const legL = j.leftUpperLeg;
  const legR = j.rightUpperLeg;
  // one unit of her size: hip-socket spacing on most models, else a share of her trunk
  const unit =
    legL && legR
      ? Math.max(0.05, Math.abs(legL[0] - legR[0]))
      : Math.max(0.05, (head[1] - hips[1]) * 0.25);
  if (/hair/i.test(mesh)) return "hair";

  // head: above the neck. Front at or under her eyes is her face; behind and above it is her hair or crown.
  if (p[1] >= head[1] - 0.25 * (head[1] - neckAt[1])) {
    const front = p[2] > head[2] + 0.25 * unit;
    if (/face/i.test(mesh) || (front && p[1] < head[1] + 0.9 * unit)) return "face";
    return p[2] < head[2] - 0.15 * unit || p[1] > head[1] + 1.3 * unit ? "hair" : "head";
  }

  const limbs: Array<{ zone: TouchZone; a?: Vec3 | undefined; b?: Vec3 | undefined; r: number }> =
    [];
  for (const side of ["left", "right"] as const) {
    const sh = j[`${side}Shoulder`];
    const ua = j[`${side}UpperArm`];
    const la = j[`${side}LowerArm`];
    const hand = j[`${side}Hand`];
    const ul = j[`${side}UpperLeg`];
    const ll = j[`${side}LowerLeg`];
    const foot = j[`${side}Foot`];
    const toes = j[`${side}Toes`] ?? (foot ? along(foot, [0, 0, 1], 1.2 * unit) : undefined);
    limbs.push(
      // the shoulder runs from the collarbone over the top of the arm
      {
        zone: "shoulder",
        a: sh,
        b: sh && ua ? along(ua, sub(ua, sh), 0.4) : undefined,
        r: 0.6 * unit,
      },
      { zone: "arm", a: ua && la ? along(ua, sub(la, ua), 0.15) : undefined, b: la, r: 0.4 * unit },
      { zone: "arm", a: la, b: hand, r: 0.33 * unit },
      {
        zone: "hand",
        a: hand,
        b: hand && la ? along(hand, sub(hand, la), 0.7) : undefined,
        r: 0.35 * unit,
      },
      { zone: "thigh", a: ul, b: ll, r: 1.0 * unit },
      { zone: "leg", a: ll, b: foot, r: 0.55 * unit },
      { zone: "foot", a: foot, b: toes, r: 0.45 * unit },
    );
  }
  let best: { zone: TouchZone; d: number } | null = null;
  for (const l of limbs) {
    if (l.a === undefined || l.b === undefined) continue;
    const seg = toSegment(p, l.a, l.b);
    // above the crotch line the thigh's capsule is still her hips (front, sides and seat)
    const zone =
      l.zone === "thigh" && seg.t < 0.12
        ? "hips"
        : // at the ankle and below, the boot or the foot is her foot
          l.zone === "leg" && seg.t > 0.9 && l.b !== undefined && p[1] < l.b[1] + 0.3 * unit
          ? "foot"
          : l.zone;
    const d = seg.d / l.r;
    if (best === null || d < best.d) best = { zone, d };
  }
  const neckD = toSegment(p, top, head);
  if (
    neckD.t > 0.45 &&
    neckD.d < 0.75 * unit &&
    (best === null || neckD.d / (0.75 * unit) < best.d)
  )
    return "neck";
  // the trunk: its spine line from the hip sockets to the upper chest, about three units wide
  const trunk = toSegment(p, [hips[0], Math.min(hips[1], (legL ?? hips)[1]), hips[2]], top);
  const trunkD = trunk.d / (1.5 * unit);
  if (best !== null && best.d < trunkD) return best.d < 2 ? best.zone : null;
  // below the crotch line the trunk ends: a skirt or a full thigh there is still her leg
  const socket = Math.min(legL?.[1] ?? hips[1], legR?.[1] ?? hips[1]);
  if (
    best !== null &&
    best.d < 2.5 &&
    p[1] < socket - 0.3 * unit &&
    (best.zone === "thigh" || best.zone === "leg")
  )
    return best.zone;
  if (trunkD > 2) return null;

  const back = p[2] < chest[2] - 0.25 * unit;
  const sideways = Math.abs(p[0] - hips[0]) > 0.5 * unit;
  if (p[1] >= chest[1] - 0.25 * unit) {
    // the outer top of the chest, out toward the arm, is her shoulder
    const arm = j.leftUpperArm ?? j.rightUpperArm;
    const reach = arm ? Math.abs(arm[0] - top[0]) : 2 * unit;
    if (p[1] > top[1] && Math.abs(p[0] - top[0]) >= 0.8 * reach) return "shoulder";
    return back ? "back" : "chest";
  }
  if (p[1] < hips[1] + 0.3 * unit) return "hips";
  if (sideways) return "waist";
  return back ? "back" : "belly";
};
