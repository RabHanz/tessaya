/**
 * How each emotion shows on each vessel, as data (EMOTION-SYSTEM §5; one agent, many vessels). A vessel declares what
 * it can render (its manifest); `renderFor` picks, per channel, the nearest thing it has and falls back down the
 * emotion's kin. A new emotion is a row in EMOTIONS, a new prop a name in a row and a manifest, a new vessel a manifest:
 * no surface keeps its own emotion table.
 */
import { R1_MOODS, type ExpressionMood } from "@t3tools/tessaya-contracts";
import type { HandledHow } from "./affect.ts";
import type { HapticHardware } from "./haptics.ts";

export type Dye = "weld" | "madder" | "woad" | "indigo" | "damson" | "rose";

/**
 * Buzz patterns by name (R-079). A vessel's own firmware owns each one's pulses (the Tessel's r1bt_haptic.h, in this
 * order), so the server only names a pattern and a level, never streams a waveform.
 */
export const HAPTIC_PATTERNS = [
  "tap",
  "double_tap",
  "purr",
  "giggle",
  "startle",
  "thump",
  "heartbeat",
  "nudge",
] as const;
export type HapticPattern = (typeof HAPTIC_PATTERNS)[number];

/** The buzz each moment gets; none for a set-down, since a rattle on a hard desk sounds cheap. */
export const MOMENT_HAPTICS = {
  lifted: "purr",
  carried: null,
  setdown: null,
  shaken: "giggle",
  dropped: "startle",
  wake: "double_tap",
  note: "nudge",
} as const satisfies Readonly<Record<HandledHow | "wake" | "note", HapticPattern | null>>;

export interface EmotionLook {
  /** What to draw when a vessel lacks this one, nearest first; neutral is always the last resort. */
  readonly kin: ReadonlyArray<string>;
  /** Props that suit it, best first, by any vessel's names; one only shows when the mood is strong (PROP_AT). */
  readonly props?: ReadonlyArray<string>;
  /** Out loud: a sound she may let carry it once (the shared stage-direction path plays it). */
  readonly sound?: "sigh" | "laugh";
  /** Out loud: tags the voice drops in this mood (§5.2: no laugh while she is concerned, no sigh at him while steady). */
  readonly blocks?: ReadonlyArray<string>;
  /** The voice's style for engines that take one (§5.2). */
  readonly style: string;
  /** The light's dye (§5.4, MA-016). */
  readonly dye?: Dye;
  /** A buzz that may carry it once as it arrives, where a vessel has a motor. */
  readonly haptic?: HapticPattern;
}

const NO_LAUGH = ["[laughs]", "[excited]"];

/** Every label the spine can show, and how. Keyed by the contract's list, so a new label cannot ship without a row. */
export const EMOTIONS: Readonly<Record<ExpressionMood, EmotionLook>> = {
  neutral: { kin: [], style: "calm, clear" },
  happy: {
    kin: [],
    sound: "laugh",
    style: "warm, lightly smiling",
    dye: "weld",
    haptic: "purr",
  },
  proud: {
    kin: ["happy"],
    props: ["crown"],
    sound: "laugh",
    style: "warm, quietly pleased",
    dye: "weld",
  },
  curious: {
    kin: ["thinking"],
    props: ["magnifier"],
    style: "interested, a little brighter",
    dye: "woad",
  },
  focused: {
    kin: ["thinking", "determined"],
    props: ["glasses", "reading"],
    blocks: ["[laughs]"],
    style: "clear, steady, slightly quicker",
    dye: "woad",
  },
  determined: {
    kin: ["focused", "thinking"],
    props: ["wrench"],
    blocks: ["[laughs]"],
    style: "clear and brisk",
    dye: "woad",
  },
  surprised: {
    kin: ["surprise", "curious"],
    style: "brightly surprised",
    dye: "weld",
    haptic: "tap",
  },
  sleepy: {
    kin: ["asleep"],
    props: ["nightcap", "mask"],
    blocks: ["[excited]"],
    style: "quiet, relaxed, lower energy",
    dye: "damson",
  },
  concerned: {
    kin: ["worried", "sad"],
    blocks: NO_LAUGH,
    style: "gentle, slower, kind",
    dye: "damson",
  },
  steady: {
    kin: ["calm"],
    blocks: [...NO_LAUGH, "[sighs]", "*sighs*"],
    style: "calm, even, unhurried",
  },
  sad: {
    kin: ["concerned"],
    props: ["tissue"],
    sound: "sigh",
    blocks: NO_LAUGH,
    style: "gentle, a little quieter, warm",
    dye: "indigo",
    haptic: "heartbeat",
  },
  hurt: {
    kin: ["sad"],
    props: ["bandage"],
    blocks: NO_LAUGH,
    style: "gentle, a little quieter",
    dye: "indigo",
  },
  lonely: {
    kin: ["sad"],
    sound: "sigh",
    style: "wistful, then bright",
    dye: "indigo",
    haptic: "heartbeat",
  },
  sulky: {
    kin: ["putout", "pout", "sad"],
    sound: "sigh",
    style: "a little flat, playful",
    dye: "damson",
    haptic: "thump",
  },
  putout: {
    kin: ["sulky", "pout", "sad"],
    style: "a little flat, playful",
    dye: "damson",
    haptic: "thump",
  },
  frustrated: {
    kin: ["annoyed", "angry", "focused"],
    blocks: ["[laughs]"],
    style: "clipped, then brisk",
    dye: "madder",
  },
  angry: {
    kin: ["frustrated", "grumpy"],
    blocks: ["[laughs]"],
    style: "clipped, then brisk",
    dye: "madder",
  },
};

/** A prop only comes out for a mood this strong (the spine's intensity, 0 to 1): a mild mood is the face alone. */
export const PROP_AT = 0.6;

/**
 * The face library: the Character Studio rig's 44 expressions (rig.js TCS.EXPRESSIONS), which the Tessel's eyes draw
 * by the same names (firmware 3.30+). Labels it lacks ("steady") reach it through their kin.
 */
export const FACE_LIBRARY: ReadonlyArray<string> = (
  "neutral attentive calm unimpressed bored happy delighted laughing giggle excited proud smug relieved playful wink " +
  "shy love embarrassed curious thinking searching focused determined skeptical confused dizzy surprised amazed " +
  "nervous concerned worried sad hurt crying lonely sulky putout pout annoyed frustrated angry grumpy sleepy asleep"
).split(" ");

/** One vessel's channels and what each renders; a channel it lacks is simply absent. */
export interface VesselManifest {
  readonly id: string;
  /** Faces or eyes it draws, by name. */
  readonly face?: ReadonlyArray<string>;
  readonly props?: ReadonlyArray<string>;
  /** A light it can tint with the mood's dye. */
  readonly light?: boolean;
  /** A speaker: the voice's style, its blocked tags and her one sound. */
  readonly voice?: boolean;
  /** Its vibration hardware; haptics.ts renders each pattern natively for it. */
  readonly haptic?: HapticHardware;
}

/** Every vessel that shows her mood, by role. */
export const VESSELS = {
  // The R1's older eye clips (R1_MOODS) stay drawable for firmware before 3.30. Props are cmd/eye/set's accessory
  // (firmware 3.31), by its own names.
  tessel: {
    id: "tessel",
    face: [...FACE_LIBRARY, ...R1_MOODS],
    props: ["reading", "magnifier", "mask"],
    voice: true,
    haptic: { kind: "erm" },
  },
  // Props are the Character Studio's (apps/web/public/companion/props.js).
  mascot: {
    id: "mascot",
    face: FACE_LIBRARY,
    props: ["crown", "magnifier", "glasses", "wrench", "nightcap", "tissue", "bandage"],
  },
  pill: { id: "pill", face: FACE_LIBRARY },
  speaker: { id: "speaker", voice: true },
} as const satisfies Readonly<Record<string, VesselManifest>>;

export interface Rendering {
  /** The face to draw, or null when the vessel has no face. */
  readonly face: string | null;
  /** The prop to hold, null for none (and to put one away). Absent when the vessel has no props. */
  readonly prop?: string | null;
  readonly dye?: Dye | null;
  readonly voice?: {
    readonly style: string;
    readonly sound: "sigh" | "laugh" | null;
    readonly blocks: ReadonlyArray<string>;
  };
  /** The buzz, null for none. Absent when the vessel has no motor. */
  readonly haptic?: HapticPattern | null;
}

const lookOf = (label: string): EmotionLook =>
  Object.hasOwn(EMOTIONS, label) ? EMOTIONS[label as ExpressionMood] : EMOTIONS.neutral;

/** Whether the spine has this label (a row in EMOTIONS). */
export const isEmotion = (label: string): label is ExpressionMood => Object.hasOwn(EMOTIONS, label);

/** The nearest face this vessel draws for a label: the label, its kin, their kin, then neutral. */
export const faceFor = (m: VesselManifest, label: string): string | null => {
  if (m.face === undefined) return null;
  const kin = lookOf(label).kin;
  const chain = [label, ...kin, ...kin.flatMap((k) => lookOf(k).kin), "neutral"];
  return chain.find((name) => m.face!.includes(name)) ?? null;
};

/** How a label at an intensity shows on one vessel, per channel it has. */
export const renderFor = (m: VesselManifest, label: string, intensity: number): Rendering => {
  const look = lookOf(label);
  const props = m.props;
  return {
    face: faceFor(m, label),
    ...(props === undefined
      ? {}
      : {
          prop: intensity >= PROP_AT ? (look.props?.find((p) => props.includes(p)) ?? null) : null,
        }),
    ...(m.light === true ? { dye: look.dye ?? null } : {}),
    ...(m.voice === true
      ? { voice: { style: look.style, sound: look.sound ?? null, blocks: look.blocks ?? [] } }
      : {}),
    ...(m.haptic === undefined ? {} : { haptic: look.haptic ?? null }),
  };
};
