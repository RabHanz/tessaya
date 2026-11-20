/**
 * How each emotion shows on each vessel, as data (EMOTION-SYSTEM §5; one agent, many vessels). A vessel declares what
 * it can render (its manifest); `renderFor` picks, per channel, the nearest thing it has and falls back down the
 * emotion's kin. A new emotion is a row in EMOTIONS, a new prop a name in a row and a manifest, a new vessel a manifest:
 * no surface keeps its own emotion table.
 */
import type { TessayaBodyForm } from "@t3tools/contracts";
import { R1_MOODS, type ExpressionMood } from "@t3tools/tessaya-contracts";
import type { HandledHow } from "./affect.ts";
import type { SensePackId } from "./bodySense.ts";
import type { HapticHardware } from "./haptics.ts";
import type { Nonverbal } from "./interjections.ts";

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
  flipped: null,
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
    props: ["glasses"],
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
    props: ["nightcap", "sleepmask"],
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

/**
 * The prop vocabulary: the Character Studio's props (apps/web/public/companion/props.js), by its ids. Every surface
 * names a prop by these; a vessel that calls one otherwise says so in its manifest (`propAs`).
 */
export const PROPS: ReadonlyArray<string> = (
  "monocle coffee tea water magnifier wrench hammer pencil phone envelope stamp stopwatch " +
  "alarmclock key umbrella flag camera microphone paintbrush wateringcan dumbbell broom bugnet torch " +
  "tissue heart popcorn controller shoppingbag thermometer pillbox balloon hourglass bell map timer " +
  "clipboard book lock shield trophy rocket gift parcel headphones hardhat nightcap partyhat " +
  "chefhat gradcap detective beanie crown headset glasses sunglasses sleepmask bandage lightbulb raincloud " +
  "sun snowflake wifioff batterylow notes laptop cake plant books"
).split(" ");

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
  /** The form of her it shows (one self in any form), and the nerves a touch on it is read through (SENSE_PACKS). */
  readonly form?: TessayaBodyForm;
  readonly sense?: SensePackId;
  /** Faces or eyes it draws, by name. */
  readonly face?: ReadonlyArray<string>;
  /** The props it draws, by the vocabulary's ids (PROPS). */
  readonly props?: ReadonlyArray<string>;
  /** Its own name for a prop, where it differs from the vocabulary's. */
  readonly propAs?: Readonly<Record<string, string>>;
  /** A light it can tint with the mood's dye. */
  readonly light?: boolean;
  /** A speaker: the voice's style, its blocked tags and her one sound. */
  readonly voice?: boolean;
  /** Its vibration hardware; haptics.ts renders each pattern natively for it. */
  readonly haptic?: HapticHardware;
  /** Animation clips by file name, `<Emotion>_<State>` (`clipFor`): a new emotion or state is a file, not code. */
  readonly clips?: ReadonlyArray<string>;
}

/** Every vessel that shows her mood, by role. */
export const VESSELS = {
  // The R1's older eye clips (R1_MOODS) stay drawable for firmware before 3.30. Props are cmd/eye/set's accessory
  // (firmware 3.31), by its own names; one it lacks is left to the firmware ("auto"), never "none" (bare).
  tessel: {
    id: "tessel",
    form: "tumble",
    sense: "tumble",
    face: [...FACE_LIBRARY, ...R1_MOODS],
    props: ["partyhat", "sleepmask", "glasses", "sunglasses", "magnifier"],
    propAs: { partyhat: "party", sleepmask: "mask", glasses: "reading", sunglasses: "sun" },
    voice: true,
    haptic: { kind: "erm" },
  },
  // Her cartoon draws the whole vocabulary: it is the Character Studio's own.
  mascot: {
    id: "mascot",
    form: "cartoon",
    sense: "mascot",
    face: FACE_LIBRARY,
    props: PROPS,
  },
  // Her full (VRM) body, public or private (apps/web/src/body/vrmBody.ts).
  body: { id: "body", form: "human", sense: "human" },
  pill: { id: "pill", face: FACE_LIBRARY },
  speaker: { id: "speaker", voice: true },
} as const satisfies Readonly<Record<string, VesselManifest>>;

/** The vessel that draws each form, for its nerves and what it can show. */
export const FORM_VESSELS = {
  cartoon: VESSELS.mascot,
  human: VESSELS.body,
  tumble: VESSELS.tessel,
} as const satisfies Readonly<Record<TessayaBodyForm, VesselManifest>>;

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

/** What is going on now that a prop says, ahead of her mood's; every field is optional, a vessel passes what it knows. */
export interface PropState {
  /** One he pinned by voice (the `tessayaProp` setting): it wins over everything. */
  readonly pinned?: string | null;
  /** The line she is saying asks for one (`[prop:x]`, propTagOf). */
  readonly tag?: string | null;
  /** A release just shipped. */
  readonly release?: boolean;
  /** His private layer is open on this vessel. */
  readonly privateOpen?: boolean;
  /** An agent job is building now. */
  readonly building?: boolean;
  readonly weather?: "rain" | "snow" | "sun" | "cold" | null;
  /** The household's local hour (0 to 23). */
  readonly hour?: number;
}

/** The props a state asks for, strongest first (props.js says what each one means). */
export const statePropsOf = (s: PropState): ReadonlyArray<string> =>
  [
    s.pinned,
    s.tag,
    s.release === true ? "partyhat" : null,
    s.privateOpen === true ? "lock" : null,
    s.building === true ? "hardhat" : null,
    s.weather === "rain"
      ? "umbrella"
      : s.weather === "snow"
        ? "snowflake"
        : s.weather === "sun"
          ? "sunglasses"
          : s.weather === "cold"
            ? "beanie"
            : null,
    s.hour === undefined
      ? null
      : s.hour >= 23 || s.hour < 6
        ? "nightcap"
        : s.hour >= 7 && s.hour < 9
          ? "coffee"
          : s.hour >= 21
            ? "tea"
            : null,
  ].filter((p): p is string => typeof p === "string" && p !== "");

/** The prop a line asks for (`[prop:umbrella]`), or null; the tag is the speech track's (companion speech.js). */
export const propTagOf = (line: string): string | null =>
  /\[prop:([a-z0-9]+)\]/.exec(line)?.[1] ?? null;

/**
 * How a label at an intensity shows on one vessel, per channel it has. Its prop is the first it draws (by its own
 * name) of what the state asks for, then what a strong mood brings; null for none, which a Tessel reads as "auto".
 */
export const renderFor = (
  m: VesselManifest,
  label: string,
  intensity: number,
  state: PropState = {},
): Rendering => {
  const look = lookOf(label);
  const props = m.props;
  const wanted = [...statePropsOf(state), ...(intensity >= PROP_AT ? (look.props ?? []) : [])];
  return {
    face: faceFor(m, label),
    ...(props === undefined
      ? {}
      : {
          prop: ((p) => (p === undefined ? null : (m.propAs?.[p] ?? p)))(
            wanted.find((p) => props.includes(p)),
          ),
        }),
    ...(m.light === true ? { dye: look.dye ?? null } : {}),
    ...(m.voice === true
      ? { voice: { style: look.style, sound: look.sound ?? null, blocks: look.blocks ?? [] } }
      : {}),
    ...(m.haptic === undefined ? {} : { haptic: look.haptic ?? null }),
  };
};

/**
 * What a stage direction she writes (`*laughs*`) shows as it sounds (VOXTA-STUDY G7), by face library names; none for
 * a sound whose feeling depends on the line (a sigh can be relief or sorrow), or for a pause.
 */
export const NONVERBAL_LOOKS: Readonly<
  Record<Nonverbal, { readonly face?: string; readonly haptic?: HapticPattern }>
> = {
  laugh: { face: "laughing", haptic: "giggle" },
  chuckle: { face: "happy" },
  giggle: { face: "giggle", haptic: "giggle" },
  gasp: { face: "surprised", haptic: "startle" },
  smile: { face: "happy" },
  scoff: { face: "unimpressed" },
  groan: { face: "annoyed" },
  yawn: { face: "sleepy" },
  sigh: {},
  breath: {},
  cough: {},
  sniff: {},
  gesture: {},
};

/** A direction's effect on one vessel: the face it draws and the buzz its motor plays, null for none. */
export const effectFor = (
  m: VesselManifest,
  nonverbal: Nonverbal,
): { readonly face: string | null; readonly haptic: HapticPattern | null } => {
  const look = NONVERBAL_LOOKS[nonverbal];
  return {
    face: look.face !== undefined && m.face?.includes(look.face) === true ? look.face : null,
    haptic: m.haptic === undefined ? null : (look.haptic ?? null),
  };
};

/**
 * What a body is doing, for its clips (VOXTA-STUDY G8): `Idle`, `Listening`, `Thinking` and `Talking` loop; `Reaction`
 * plays once as the emotion arrives; `Fidget` breaks a long idle. `<Emotion>_<State>_Fixed` is held for a whole reply.
 */
export const CLIP_STATES = [
  "Idle",
  "Listening",
  "Thinking",
  "Talking",
  "Reaction",
  "Fidget",
] as const;
export type ClipState = (typeof CLIP_STATES)[number];

const titled = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

/**
 * The clip a vessel plays for a label in a state, by the `<Emotion>_<State>` naming: numbered variants (`Happy_Idle_2`)
 * take turns by `turn`, a `_Fixed` clip wins for a whole reply, and a label it lacks falls down its kin to `Neutral`.
 * Null when the vessel has no clip for the state (its renderer's own idle, blink and glance keep it alive).
 */
export const clipFor = (
  m: VesselManifest,
  label: string,
  state: ClipState,
  options: { readonly turn?: number; readonly wholeReply?: boolean } = {},
): string | null => {
  const clips = m.clips;
  if (clips === undefined) return null;
  const kin = lookOf(label).kin;
  for (const name of [label, ...kin, ...kin.flatMap((k) => lookOf(k).kin), "neutral"]) {
    const base = `${titled(name)}_${state}`;
    if (options.wholeReply === true && clips.includes(`${base}_Fixed`)) return `${base}_Fixed`;
    const variants = clips
      .filter(
        (c) => c === base || (c.startsWith(`${base}_`) && /^\d+$/.test(c.slice(base.length + 1))),
      )
      .toSorted();
    if (variants.length > 0) return variants[(options.turn ?? 0) % variants.length]!;
  }
  return null;
};
