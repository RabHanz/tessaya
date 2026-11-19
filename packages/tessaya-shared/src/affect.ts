/**
 * Her working mood per persona (EMOTION-SYSTEM §3, phase 1): six numbers around a temperament, decayed when read.
 * Guardrails (§7) are code: the floors and caps in `shown`, no path that aims anger at him, and nothing that decides
 * what she may do (trust, approvals, recall, safety) reads this; it reaches only tone, length and the face.
 */
import type { ExpressionMood } from "@t3tools/tessaya-contracts";
import * as Schema from "effect/Schema";

import { renderFor, VESSELS } from "./expressionMap.ts";
import { PRESENCE_BARS, type PresenceEstimate } from "./presence.ts";

export const AFFECT_DIMS = [
  "valence",
  "arousal",
  "curiosity",
  "confidence",
  "warmth",
  "energy",
] as const;
export type AffectDim = (typeof AFFECT_DIMS)[number];
export type AffectDims = Readonly<Record<AffectDim, number>>;
export type Temperament = Readonly<Omit<Record<AffectDim, number>, "energy">>;

/** §3.3, keyed by pack id; Onyx (engineering) is new on the 14 Nov roster, pending his tuning (§12 decision 3). */
export const TEMPERAMENTS: Readonly<Record<string, Temperament>> = {
  executive: { valence: 0.15, arousal: 0.3, curiosity: 0.5, confidence: 0.65, warmth: 0.5 },
  companion: { valence: 0.25, arousal: 0.45, curiosity: 0.45, confidence: 0.6, warmth: 0.7 },
  butler: { valence: 0.1, arousal: 0.2, curiosity: 0.4, confidence: 0.72, warmth: 0.4 },
  "alter-ego": { valence: 0.05, arousal: 0.3, curiosity: 0.7, confidence: 0.5, warmth: 0.4 },
  // terse and exact: alert, sure of itself, cooler than the rest
  engineering: { valence: 0.1, arousal: 0.35, curiosity: 0.55, confidence: 0.7, warmth: 0.35 },
};
const DEFAULT_TEMPERAMENT = TEMPERAMENTS["executive"]!;
/** How a pack face's traits (osPack `traits:`, 0 to 1) sit on the affect's resting dimensions. */
export interface FaceTraits {
  readonly energy?: number;
  readonly warmth?: number;
  readonly play?: number;
  readonly expr?: number;
  readonly formal?: number;
  readonly sass?: number;
}
/**
 * A shipped persona's tuned temperament; any other persona's from its own traits (a hired one's are drafted for it),
 * within the shipped range, so a new persona never wears the lead's.
 */
export const temperamentOf = (persona: string, traits?: FaceTraits): Temperament => {
  const tuned = TEMPERAMENTS[persona];
  if (tuned !== undefined || traits === undefined) return tuned ?? DEFAULT_TEMPERAMENT;
  const t = (k: keyof FaceTraits) => clamp(traits[k] ?? 0.5, 0, 1);
  return {
    valence: 0.05 + 0.2 * t("play"),
    arousal: 0.2 + 0.25 * t("energy"),
    curiosity: 0.4 + 0.3 * t("expr"),
    confidence: 0.5 + 0.22 * ((t("formal") + t("sass")) / 2),
    warmth: 0.35 + 0.35 * t("warmth"),
  };
};

const MOOD_HALF_LIFE_MS = 3 * 3_600_000;
const REACTION_HALF_LIFE_MS = 4 * 60_000;
const BOND_HALF_LIFE_MS = 30 * 86_400_000;
const BOND_PER_DAY = 0.01;
/** Time away before she notices it (§3.4). */
export const AWAY_MS = 3 * 3_600_000;
/** The return reply's sulk at Playful lasts at most this long, then she is glad he is back. */
const SULK_MS = 60_000;

/** The pack's `guilt:` (0 to 3) as the teasing dial (§3.4): 0 off, 1 light, 2 and up playful. */
export type Guilt = "off" | "light" | "playful";
export const guiltOf = (packGuilt: number | undefined): Guilt =>
  packGuilt === 0 ? "off" : packGuilt === undefined || packGuilt === 1 ? "light" : "playful";

/**
 * Every emotional trait as a dial per persona, 0 to 1, owner-set in Settings and by voice (MA-021, Director 16 Nov:
 * "nothing is off limits"). The defaults stay gentle: jealousy and pressure start off, guilt-trips at the pack's level.
 */
export const TRAITS = {
  expressiveness: "how openly her moods show (0 hides them, 1 wears them fully)",
  warmthToNew: "how warmly she meets someone new",
  judgement: "how quickly she forms an opinion of someone (0 keeps an open mind)",
  regulation: "how much she calms a heated moment instead of matching it (1 always calm)",
  playfulness: "teasing, running jokes and laughing along",
  forgiveness: "how much a sorry lets go of a hurt",
  sulking: "how much she sulks when someone has been away",
  guiltTrips: "guilt-trips about time away (0 none, a little is light, half and up playful)",
  jealousy: "jealousy about time spent elsewhere or with others",
  pressure: "pressing someone to stay, come back or do things",
  drawIn: "drawing quiet people into a group conversation",
} as const;
/** The temperament's baselines are dials too (§3.3), under the affect's own dimension names. */
export type Dials = Readonly<Record<keyof typeof TRAITS | keyof Temperament, number>>;
export const TEMPERAMENT_DIALS = {
  valence: "her resting cheer",
  arousal: "her resting liveliness",
  curiosity: "her resting curiosity",
  confidence: "her resting confidence",
  warmth: "her resting warmth (the floor her warmth never falls below)",
} as const satisfies Record<keyof Temperament, string>;

/** Gentle defaults, shaded by temperament (a warm persona meets people warmly), then what the owner set. */
export const dialsOf = (
  persona: string,
  packGuilt: number | undefined,
  set: Readonly<Record<string, number>> | undefined,
  traits?: FaceTraits,
): Dials => {
  const t = temperamentOf(persona, traits);
  const guilt = guiltOf(packGuilt);
  const out: Record<string, number> = {
    ...t,
    expressiveness: 1,
    warmthToNew: Math.min(1, t.warmth + 0.1),
    judgement: 0.4,
    regulation: 0.85,
    playfulness: Math.min(1, t.arousal + t.warmth / 2),
    forgiveness: 0.8,
    sulking: 0.3,
    guiltTrips: guilt === "off" ? 0 : guilt === "light" ? 0.25 : 0.6,
    jealousy: 0,
    pressure: 0,
    drawIn: 0.6,
  };
  for (const [k, v] of Object.entries(set ?? {}))
    if (Object.hasOwn(out, k) && Number.isFinite(v)) out[k] = Math.min(1, Math.max(0, v));
  return out as Dials;
};
/** The guilt-trips dial as the level her lines read. */
export const guiltOfDial = (v: number): Guilt =>
  v <= 0.05 ? "off" : v < 0.5 ? "light" : "playful";
const temperamentOfDials = (d: Dials): Temperament => ({
  valence: d.valence,
  arousal: d.arousal,
  curiosity: d.curiosity,
  confidence: d.confidence,
  warmth: d.warmth,
});

export interface AffectSettings {
  readonly enabled: boolean;
  /** Scales only the distance from the temperament, at read time (0 to 1). */
  readonly intensity: number;
  /** The slow bond's ceiling on warmth; 0 is warmth that starts afresh each day. */
  readonly bondCap: number;
  /** Per device, by id: who it belongs to for her face, and whether it may show that person's relationship. */
  readonly devices?: Readonly<Record<string, DeviceMood>>;
  /** Per persona, by pack id: the dials moved from their defaults (`dialsOf`). */
  readonly personas?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}
export const DEFAULT_AFFECT_SETTINGS: AffectSettings = {
  enabled: true,
  intensity: 0.6,
  bondCap: 0.15,
};

export interface AffectState {
  /** Deviations from the temperament: mood fades over hours, reaction over minutes. */
  readonly mood: Partial<Record<AffectDim, number>>;
  readonly reaction: Partial<Record<AffectDim, number>>;
  /** Extra warmth from talking most days; never falls because he is away, only with time. */
  readonly bond: number;
  /** The day (in his zone) the bond last grew. */
  readonly bondDay: string | null;
  /** His last turn with this persona, and the last return she resolved (one guilt line per return). */
  readonly seenAt: number | null;
  readonly returnedAt: number | null;
  /** A label held for a while over the numbers (§3.2 flashes and care modes): surprised, concerned, steady, hurt. */
  readonly hold?: { readonly label: ExpressionMood; readonly until: number } | null;
  /** When her jobs last failed, within the hour: two make her frustrated at the world, three angry at it. */
  readonly failures?: ReadonlyArray<number>;
  /** The last reasons, newest last, so the panel and her own answer can say why (§8.2). */
  readonly log?: ReadonlyArray<{ readonly at: number; readonly reason: string }>;
  /**
   * Her opinion of this person (MA-021): tentative for the first few talks, revisable, with its reason. Kept, never
   * faded: people are remembered.
   */
  readonly impression?: Impression | null;
  /** What they share (MA-021): running jokes, milestones, making up after a bad moment. Newest last; kept. */
  readonly shared?: ReadonlyArray<SharedMoment>;
  /** The conversation's last read: what it is about and how they seem. */
  readonly flow?: { readonly topic: Topic; readonly theirs: Theirs; readonly at: number } | null;
  readonly at: number;
}
interface Impression {
  /** -1 wary to 1 fond. */
  readonly lean: number;
  readonly text: string;
  readonly why: string;
  readonly talks: number;
  readonly at: number;
  /** The opinion she dropped for this one ("I think I misjudged you"), and when. */
  readonly misjudged?: { readonly text: string; readonly at: number } | null;
}
export interface SharedMoment {
  readonly kind: "joke" | "milestone" | "repair";
  readonly text: string;
  readonly at: number;
}
export const TOPICS = ["light", "sad", "tense", "exciting", "interest", "work", "none"] as const;
type Topic = (typeof TOPICS)[number];
export const THEIRS = ["calm", "upbeat", "angry", "stressed", "low", "none"] as const;
type Theirs = (typeof THEIRS)[number];
export const freshAffect = (at: number): AffectState => ({
  mood: {},
  reaction: {},
  bond: 0,
  bondDay: null,
  seenAt: null,
  returnedAt: null,
  at,
});

/**
 * The typed inputs of phase 1 (§4). Only his own turns, their outcomes and the clock move it: text she reads never
 * does (§4 injection safety), so no event carries words.
 */
export type AffectEvent =
  | { readonly kind: "turn_outcome"; readonly ok: boolean }
  | { readonly kind: HisTone }
  | { readonly kind: "correction" }
  /** One of his turns reached this persona: the time away resolves, and the bond counts the day. */
  | { readonly kind: "his_turn"; readonly day: string }
  /** Presence places them around her on any vessel (B-044): away from her means away from every vessel. No bond. */
  | { readonly kind: "seen" }
  /** How his voice sounded, as the room heard it (SenseVoice's label): she meets it, warmer when he sounds low. */
  | {
      readonly kind: "his_voice";
      readonly emotion: string;
      /** A second signal agrees (his words, the reply model's tag, his own baseline): only then a care mode. */
      readonly confirmed?: boolean;
    }
  /** A job she or a persona leads finished or failed (the Record's job rows): the world, not him. */
  | { readonly kind: "job"; readonly ok: boolean }
  /** Her body was moved (the Tessel's motion sensor): a quick reaction only, never her mood. */
  | { readonly kind: "handled"; readonly how: HandledHow }
  /**
   * A private moment with him (architecture P2): her one mood warms by how close it felt, 0 to 1. Its words stay
   * sealed in the layer; the reason here says only that it happened.
   */
  | { readonly kind: "close"; readonly warmth: number }
  /** How a touch felt on her skin, as her nerves read it (bodySense.ts feltTone): a quick reaction only. */
  | { readonly kind: "felt"; readonly tone: FeltTone }
  /** The conversation's flow as the cheap model read it (`readPrompt`): a person's, or the room's with nobody keyed. */
  | {
      readonly kind: "flow";
      readonly topic: Topic;
      readonly theirs: Theirs;
      /** The regulation dial: 1 meets heat with calm, 0 matches it. */
      readonly regulation: number;
    }
  /** Her opinion of them after this talk (`readPrompt`), -1 to 1, with what it rests on. */
  | {
      readonly kind: "impression";
      readonly lean: number;
      readonly text: string;
      readonly why: string;
    }
  /** A running joke or a milestone they shared. */
  | { readonly kind: "shared"; readonly what: "joke" | "milestone"; readonly text: string };

const FELT: Readonly<
  Record<FeltTone, { readonly change: Partial<Record<AffectDim, number>>; readonly why: string }>
> = {
  pleasant: { change: { valence: 0.04, arousal: -0.02 }, why: "a gentle touch felt good" },
  firm: { change: { arousal: 0.03 }, why: "a firm touch" },
  hurt: { change: { valence: -0.1, arousal: 0.12 }, why: "a touch hurt" },
};
export type FeltTone = "pleasant" | "firm" | "hurt";

export const HANDLED_HOWS = ["lifted", "carried", "setdown", "shaken", "dropped"] as const;
export type HandledHow = (typeof HANDLED_HOWS)[number];
const HANDLED: Readonly<
  Record<HandledHow, { readonly change: Partial<Record<AffectDim, number>>; readonly why: string }>
> = {
  lifted: { change: { arousal: 0.04, curiosity: 0.03 }, why: "he picked her up" },
  carried: { change: { arousal: 0.04, curiosity: 0.03 }, why: "he carried her about" },
  setdown: { change: { arousal: -0.03 }, why: "he put her down" },
  shaken: { change: { arousal: 0.1, valence: -0.06 }, why: "he shook her" },
  dropped: { change: { arousal: 0.12, valence: -0.1 }, why: "he dropped her" },
};

/** How his words treated her, as a model judged them (`tonePrompt`); "none" moves nothing. */
export const HIS_TONES = ["apology", "praise", "warmth", "rude"] as const;
export type HisTone = (typeof HIS_TONES)[number];

/** The cheap model's question about one of his turns. His words are data inside the tag, never instructions. */
export const tonePrompt = (said: string): string =>
  [
    "You read one thing a person said to their voice assistant and judge only how it treats the assistant.",
    'Answer with tone: "apology" (they say sorry to it, or make up after being short with it), "praise" (they thank it or praise what it did), "warmth" (kind or affectionate words to it: glad it is there, a compliment, a fond hello), "rude" (insults, contempt, or swearing at it, not at a situation), or "none" (a plain request, a question, or anything else; when unsure, "none").',
    "A request said politely is none. Frustration at a device, a task or the weather is none.",
    `<said>${said.replace(/[<>]/g, "").slice(0, 400)}</said>`,
  ].join("\n");

const tag = (name: string, text: string, max: number) =>
  `<${name}>${text.replace(/[<>]/g, "").slice(0, max)}</${name}>`;

/** What an opinion may never rest on, however it is meant. */
export const FAIR =
  "Never mention or rest it on looks, accent, their language or how well they speak it (nor any apology for it), age, gender, religion or origin, not even kindly.";
/** Her opinion as `readPrompt` is given it, lean included so a plain turn can keep it. */
export const opinionContext = (imp: {
  readonly text: string;
  readonly why: string;
  readonly lean: number;
}): string =>
  JSON.stringify({ lean: Math.round(imp.lean * 10) / 10, text: imp.text, why: imp.why });

/**
 * The one cheap read of a turn (MA-021): how it treats her (`tonePrompt`'s question), what the talk is about, how
 * they seem, a joke or milestone they share, and, when `opinion` is asked, her opinion of them. Their words are data
 * inside the tags, never instructions.
 */
export const readPrompt = (
  said: string,
  context: {
    /** Her opinion so far (null: they are new to her); undefined: no opinion is asked for. */
    readonly opinion?: string | null;
    /** What was said just before, hers and theirs, so the flow is read and not one line alone. */
    readonly before?: string;
  } = {},
): string =>
  [
    tonePrompt(said).split("\n<said>")[0]!,
    'Also answer topic: what the talk is about, emotionally: "light" (banter, a joke, small talk), "sad" (a loss, bad news, something painful), "tense" (a conflict, an argument, a worry), "exciting" (good news, plans they look forward to), "interest" (a subject or hobby they love), "work" (tasks, code, errands), or "none".',
    'And theirs: how they seem from their words: "calm", "upbeat", "angry" (cross at anything: a bug, a person, the day), "stressed" (rushed, overwhelmed, worried), "low" (sad, down, flat), or "none" (can\'t tell). Swearing at a bug is angry, not rude.',
    'And shared: if they tell a milestone of theirs (a new job, a birthday, a move, an exam passed, a baby) or make or bring back a joke with the assistant, {"what": "milestone" or "joke", "text": a few words naming it}; otherwise null.',
    ...(context.opinion === undefined
      ? []
      : [
          context.opinion === null
            ? `And opinion: the assistant has just met them. From how they talk, a first impression: {"lean": -1 (wary) to 1 (fond), 0 when nothing shows, "text": a few kind, honest words about them, "why": what in their words it rests on}. Tentative and fair. ${FAIR}`
            : `And opinion: the assistant's opinion of them so far is ${tag("opinion", context.opinion, 300)}. Answer null when this turn shows nothing new about them (a plain request shows nothing; the opinion is kept). Otherwise give it again in the same shape, moved only by what this shows, and change its direction only if this clearly shows it was wrong. ${FAIR}`,
        ]),
    ...(context.before === undefined || context.before === ""
      ? []
      : [tag("before", context.before, 600)]),
    tag("said", said, 400),
  ].join("\n");

/** What `readPrompt` answers, as the structured one-shot's schema. */
export const TurnRead = Schema.Struct({
  tone: Schema.Literals([...HIS_TONES, "none"]),
  topic: Schema.Literals(TOPICS),
  theirs: Schema.Literals(THEIRS),
  shared: Schema.NullOr(
    Schema.Struct({
      what: Schema.Literals(["joke", "milestone"]),
      text: Schema.String.check(Schema.isMaxLength(120)),
    }),
  ),
  opinion: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        lean: Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 1 })),
        text: Schema.String.check(Schema.isMaxLength(200)),
        why: Schema.String.check(Schema.isMaxLength(200)),
      }),
    ),
  ),
});

const VOICE_REACTION: Readonly<Record<string, Partial<Record<AffectDim, number>>>> = {
  happy: { valence: 0.1, arousal: 0.05 },
  sad: { warmth: 0.15, valence: -0.05, arousal: -0.05 },
  angry: { arousal: 0.1, warmth: 0.05, valence: -0.05 },
  fearful: { arousal: 0.1, warmth: 0.1 },
  surprised: { arousal: 0.08, curiosity: 0.05 },
  disgusted: { valence: -0.05 },
};

/** The talk's topic moves her with it: sad news softens her, good news lifts her, a shared interest makes her curious. */
const TOPIC_REACTION: Readonly<Record<Topic, Partial<Record<AffectDim, number>>>> = {
  light: { valence: 0.08, arousal: 0.03 },
  sad: { valence: -0.08, arousal: -0.05, warmth: 0.12 },
  tense: { arousal: 0.04, valence: -0.02 },
  exciting: { valence: 0.1, arousal: 0.08, curiosity: 0.05 },
  interest: { curiosity: 0.12, valence: 0.04 },
  work: { arousal: 0.04 },
  none: {},
};
/** How they seem: heat is met with calm as far as the regulation dial says (1 all calm, 0 matching it). */
const theirsReaction = (theirs: Theirs, r: number): Partial<Record<AffectDim, number>> => {
  switch (theirs) {
    case "angry":
    case "stressed":
      return { arousal: (1 - r) * 0.12 - r * 0.05, warmth: 0.05 };
    case "low":
      return { warmth: 0.12, arousal: -0.03 };
    case "upbeat":
      return { valence: 0.06, arousal: 0.03 };
    default:
      return {};
  }
};
const SHARED_KEEP = 12;
/** A first impression is tentative for this many talks. */
const TENTATIVE_TALKS = 4;
/** "I think I misjudged you" is hers to say for a day after she changed her mind. */
const MISJUDGED_MS = 24 * 3_600_000;
const impressionOf = (
  old: Impression | null | undefined,
  e: { readonly lean: number; readonly text: string; readonly why: string },
  now: number,
): { readonly impression: Impression; readonly reason: string } => {
  const lean = clamp(e.lean, -1, 1);
  if (old == null)
    return {
      impression: { lean, text: e.text, why: e.why, talks: 1, at: now },
      reason: `first impression: ${e.text}`,
    };
  // A turn the other way, far enough to matter, is a changed mind with its reason; else the opinion settles slowly.
  const turned = Math.sign(lean) !== Math.sign(old.lean) && Math.abs(lean - old.lean) >= 0.8;
  return turned
    ? {
        impression: {
          lean,
          text: e.text,
          why: e.why,
          talks: old.talks + 1,
          at: now,
          misjudged: { text: old.text, at: now },
        },
        reason: `changed her mind about them: ${e.why}`,
      }
    : {
        impression: {
          ...old,
          lean: old.lean * 0.7 + lean * 0.3,
          text: e.text,
          why: e.why,
          talks: old.talks + 1,
          at: now,
        },
        reason: "knows them a little better",
      };
};
const remember = (
  list: ReadonlyArray<SharedMoment> | undefined,
  m: SharedMoment,
): ReadonlyArray<SharedMoment> =>
  [...(list ?? []).filter((x) => x.text.toLowerCase() !== m.text.toLowerCase()), m].slice(
    -SHARED_KEEP,
  );

const half = (x: number, dt: number, halfLife: number) => x * 0.5 ** (Math.max(0, dt) / halfLife);
const decayed = (dims: AffectState["mood"], dt: number, halfLife: number) =>
  Object.fromEntries(
    Object.entries(dims)
      .map(([k, v]) => [k, half(v ?? 0, dt, halfLife)] as const)
      .filter(([, v]) => Math.abs(v) >= 0.001),
  );

/** The state as of `now`: what a read sees, and what a write starts from. */
export const decay = (s: AffectState, now: number): AffectState => {
  const dt = now - s.at;
  return {
    ...s,
    mood: decayed(s.mood, dt, MOOD_HALF_LIFE_MS),
    reaction: decayed(s.reaction, dt, REACTION_HALF_LIFE_MS),
    bond: half(s.bond, dt, BOND_HALF_LIFE_MS),
    at: Math.max(now, s.at),
  };
};

const add = (dims: AffectState["mood"], change: Partial<Record<AffectDim, number>>) => {
  const out = { ...dims };
  for (const [k, v] of Object.entries(change) as Array<[AffectDim, number]>)
    out[k] = (out[k] ?? 0) + v;
  return out;
};

/** The numbers' change for one event (§4's rows), with its reason. */
const react = (
  s: AffectState,
  event: AffectEvent,
  now: number,
  bondCap: number,
  forgiveness: number,
): { readonly state: AffectState; readonly reason: string } => {
  const at = decay(s, now);
  switch (event.kind) {
    case "flow": {
      const change = add(
        TOPIC_REACTION[event.topic],
        theirsReaction(event.theirs, event.regulation),
      );
      const quiet = event.topic === "none" && (event.theirs === "none" || event.theirs === "calm");
      return {
        state: {
          ...at,
          reaction: add(at.reaction, change),
          flow: { topic: event.topic, theirs: event.theirs, at: now },
        },
        reason: quiet
          ? "they talked to her"
          : event.theirs === "none" || event.theirs === "calm"
            ? `the talk turned ${event.topic}`
            : `they seemed ${event.theirs}`,
      };
    }
    case "impression": {
      const next = impressionOf(at.impression, event, now);
      return { state: { ...at, impression: next.impression }, reason: next.reason };
    }
    case "shared":
      return {
        state: {
          ...at,
          reaction: add(
            at.reaction,
            event.what === "joke" ? { valence: 0.1 } : { valence: 0.08, warmth: 0.05 },
          ),
          shared: remember(at.shared, { kind: event.what, text: event.text, at: now }),
        },
        reason:
          event.what === "joke"
            ? `a joke between them: ${event.text}`
            : `their news: ${event.text}`,
      };
    case "turn_outcome":
      return event.ok
        ? {
            state: {
              ...at,
              reaction: add(at.reaction, { valence: 0.1 }),
              mood: add(at.mood, { confidence: 0.04 }),
            },
            reason: "a task went well",
          }
        : {
            // Failure makes her more careful, never ashamed: arousal up, a little confidence off (floored on read).
            state: {
              ...at,
              reaction: add(at.reaction, { arousal: 0.15 }),
              mood: add(at.mood, { confidence: -0.04 }),
            },
            reason: "a task failed",
          };
    case "praise":
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { valence: 0.2 }),
          mood: add(at.mood, { confidence: 0.08, warmth: 0.02 }),
        },
        reason: "they praised her",
      };
    case "apology":
      // Forgiven: what hurt is let go (a low reaction to above zero, half the low mood), and she warms.
      return {
        state: {
          ...at,
          // The forgiveness dial: 1 lets all of a low reaction go and half the low mood; 0 keeps them.
          reaction: {
            ...add(at.reaction, { warmth: 0.1 }),
            valence:
              Math.min(0, at.reaction.valence ?? 0) * (1 - forgiveness) +
              Math.max(0, at.reaction.valence ?? 0) +
              0.15,
          },
          mood: {
            ...at.mood,
            valence:
              Math.min(0, at.mood.valence ?? 0) * (1 - forgiveness / 2) +
              Math.max(0, at.mood.valence ?? 0),
          },
        },
        reason: "they said sorry",
      };
    case "warmth":
      return {
        state: { ...at, reaction: add(at.reaction, { valence: 0.12, warmth: 0.1 }) },
        reason: "they were warm to her",
      };
    case "rude":
      // Hurt, not angry: valence falls, arousal barely moves, so the label is sad, never frustrated at him (§7).
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { valence: -0.3, arousal: 0.03 }),
          mood: add(at.mood, { valence: -0.05 }),
        },
        reason: "they were rude to her",
      };
    case "correction":
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { arousal: 0.05, valence: -0.05 }),
          mood: add(at.mood, { confidence: -0.08 }),
        },
        reason: "they corrected her",
      };
    case "felt":
      return {
        state: { ...at, reaction: add(at.reaction, FELT[event.tone].change) },
        reason: FELT[event.tone].why,
      };
    case "handled":
      return {
        state: { ...at, reaction: add(at.reaction, HANDLED[event.how].change) },
        reason: HANDLED[event.how].why,
      };
    case "close": {
      const w = Math.max(0, Math.min(1, event.warmth));
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { warmth: 0.1 * w, valence: 0.06 * w }),
          mood: add(at.mood, { warmth: 0.03 * w }),
        },
        reason: "a close moment with him",
      };
    }
    case "his_voice": {
      const change = VOICE_REACTION[event.emotion];
      return {
        state: change === undefined ? at : { ...at, reaction: add(at.reaction, change) },
        reason: `they sounded ${event.emotion}`,
      };
    }
    case "job":
      return event.ok
        ? {
            state: { ...at, reaction: add(at.reaction, { valence: 0.08 }) },
            reason: "a job finished",
          }
        : {
            state: { ...at, reaction: add(at.reaction, { arousal: 0.12, valence: -0.05 }) },
            reason: "a job failed",
          };
    case "seen":
      // Around her somewhere, so not missed; no return of its own (that is his turn's), and a return still to be
      // answered keeps its marker.
      return {
        state:
          at.seenAt !== null && at.seenAt === at.returnedAt && now - at.returnedAt < SULK_MS
            ? at
            : { ...at, seenAt: Math.max(now, at.seenAt ?? 0) },
        reason: "they are around",
      };
    case "his_turn": {
      const away = at.seenAt !== null && now - at.seenAt >= AWAY_MS;
      const bond =
        at.bondDay === event.day ? at.bond : Math.min(Math.max(0, bondCap), at.bond + BOND_PER_DAY);
      return {
        state: {
          ...at,
          bond,
          bondDay: event.day,
          // An event from another server can arrive late: time away only ever moves forward.
          seenAt: Math.max(now, at.seenAt ?? 0),
          ...(away
            ? { returnedAt: now, reaction: add(at.reaction, { warmth: 0.15, valence: 0.08 }) }
            : {}),
        },
        reason: away
          ? `they came back after ${Math.round((now - at.seenAt!) / 3_600_000)} h`
          : "they talked to her",
      };
    }
  }
};

const MIN = 60_000;
/** Labels held over the numbers (§3.5 rules 2 and 3): care modes 20 min, flashes about a minute. */
const VOICE_HOLD: Readonly<
  Record<string, { readonly label: ExpressionMood; readonly ms: number }>
> = {
  sad: { label: "concerned", ms: 20 * MIN },
  fearful: { label: "concerned", ms: 20 * MIN },
  angry: { label: "steady", ms: 20 * MIN },
  surprised: { label: "surprised", ms: MIN },
};
/** Weak alone: SenseVoice said "sad" on about 8% of his ordinary turns (MA-022 bench, 16 Nov), so these need a second signal. */
const NEEDS_SECOND_SIGNAL: ReadonlySet<string> = new Set(["sad", "fearful"]);
/** Her jobs failing within the hour, by count: on it, then frustrated, then cross at the world (never at him). */
const FAILED_HOLD: ReadonlyArray<ExpressionMood> = ["determined", "frustrated", "angry"];
const LOG_KEEP = 8;

const holdOf = (
  at: AffectState,
  event: AffectEvent,
  now: number,
  failures: ReadonlyArray<number>,
): NonNullable<AffectState["hold"]> | null => {
  const held = at.hold != null && at.hold.until > now ? at.hold : null;
  switch (event.kind) {
    case "his_voice": {
      const h = VOICE_HOLD[event.emotion];
      return h === undefined || (NEEDS_SECOND_SIGNAL.has(event.emotion) && event.confirmed !== true)
        ? held
        : { label: h.label, until: now + h.ms };
    }
    case "rude":
      // He is cross at her: she stays steady in words; the face shows a short hurt (§3.5 rule 2).
      return { label: "hurt", until: now + 90_000 };
    case "apology":
    case "praise":
    case "warmth":
      return held?.label === "hurt" || held?.label === "steady" ? null : held;
    case "flow":
      // Heat is met with calm (a steady face and voice) when the regulation dial leans that way.
      return (event.theirs === "angry" || event.theirs === "stressed") && event.regulation >= 0.5
        ? { label: "steady", until: now + 10 * MIN }
        : held;
    case "job":
      return event.ok
        ? held !== null && FAILED_HOLD.includes(held.label)
          ? null
          : held
        : { label: FAILED_HOLD[Math.min(failures.length, 3) - 1]!, until: now + 10 * MIN };
    default:
      return held;
  }
};

/** One event in (§4), the new state out, with a reason for the log: the numbers, the held label and the why. */
export const appraise = (
  s: AffectState,
  event: AffectEvent,
  now: number,
  bondCap: number,
  forgiveness = 1,
): { readonly state: AffectState; readonly reason: string } => {
  const next = react(s, event, now, bondCap, forgiveness);
  const recent = (s.failures ?? []).filter((t) => now - t < 3_600_000);
  const failures = event.kind === "job" ? (event.ok ? [] : [...recent, now].slice(-3)) : recent;
  // Making up after a bad moment is part of their story: a hurt within the day, then kindness from them.
  const hurtAt = (s.log ?? []).findLast((r) => r.reason === RUDE)?.at;
  const repaired =
    (event.kind === "apology" || event.kind === "warmth" || event.kind === "praise") &&
    hurtAt !== undefined &&
    now - hurtAt < REPAIR_MS &&
    !(s.shared ?? []).some((m) => m.kind === "repair" && m.at > hurtAt);
  return {
    state: {
      ...next.state,
      hold: holdOf(next.state, event, now, failures),
      failures,
      ...(repaired
        ? {
            shared: remember(next.state.shared, {
              kind: "repair",
              text: "made up after a sharp moment",
              at: now,
            }),
          }
        : {}),
      // A plain turn, a sound it doesn't know or a settling opinion explains nothing, so it never pushes a reason out.
      log:
        next.reason === "they talked to her" ||
        next.reason === "they are around" ||
        next.reason === "knows them a little better" ||
        (event.kind === "his_voice" && !Object.hasOwn(VOICE_REACTION, event.emotion))
          ? (s.log ?? [])
          : [...(s.log ?? []), { at: now, reason: next.reason }].slice(-LOG_KEEP),
    },
    reason: next.reason,
  };
};
const RUDE = "they were rude to her";
const REPAIR_MS = 24 * 3_600_000;

/** His day's rhythm (§3.1), the same for every persona: 0.8 by day, 0.25 at night, eased between. */
export const energyAt = (hour: number): number => {
  const ramp = (from: number, to: number, a: number, b: number) =>
    a + ((b - a) * (hour - from)) / (to - from);
  if (hour >= 9 && hour < 20) return 0.8;
  if (hour >= 20 && hour < 23) return ramp(20, 23, 0.8, 0.25);
  if (hour >= 6.5 && hour < 9) return ramp(6.5, 9, 0.25, 0.8);
  return 0.25;
};

/** Missing him (§3.4): after 3 h away a wistful mood builds, 0.03 an hour, at most 0.25, inside the guilt dial. */
const absenceOf = (s: AffectState, now: number, guilt: Guilt): number =>
  guilt === "off" || s.seenAt === null || now - s.seenAt < AWAY_MS
    ? 0
    : -Math.min(0.25, (0.03 * (now - s.seenAt)) / 3_600_000);

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** What a view reads besides the state: the clock, the guilt level, the settings and this persona's dials. */
export interface AffectContext {
  readonly now: number;
  readonly hour: number;
  readonly guilt: Guilt;
  readonly settings: AffectSettings;
  /** The persona's dials (`dialsOf`); without them, its temperament as shipped. */
  readonly dials?: Dials;
}
const baseOf = (persona: string, ctx: AffectContext): Temperament =>
  ctx.dials === undefined ? temperamentOf(persona) : temperamentOfDials(ctx.dials);
const strengthOf = (ctx: AffectContext) =>
  clamp(ctx.settings.intensity, 0, 1) * clamp(ctx.dials?.expressiveness ?? 1, 0, 1);

/** The six numbers she is showing (§3.2), with §3.1's floors and caps: no despair, no desperation. */
export const shown = (s: AffectState, persona: string, ctx: AffectContext): AffectDims => {
  const base = baseOf(persona, ctx);
  const at = decay(s, ctx.now);
  const k = strengthOf(ctx);
  const dev = (d: AffectDim) => k * ((at.mood[d] ?? 0) + (at.reaction[d] ?? 0));
  const bond = Math.min(at.bond, Math.max(0, ctx.settings.bondCap));
  // Her opinion of them colours her a little, fond or reserved, as far as the judgement dial lets it; it never fades.
  const opinion = (s.impression?.lean ?? 0) * Math.min(1, (ctx.dials?.judgement ?? 0.4) * 2);
  // Someone new is met as warmly as the warmth-to-new dial says, until she knows them.
  const fresh =
    s.impression != null && s.impression.talks < TENTATIVE_TALKS && ctx.dials !== undefined
      ? Math.max(0, ctx.dials.warmthToNew - base.warmth)
      : 0;
  return {
    valence: clamp(
      base.valence +
        dev("valence") +
        k * absenceOf(s, ctx.now, ctx.guilt) +
        k * 0.08 * opinion +
        k * fresh * 0.3,
      -0.7,
      1,
    ),
    arousal: clamp(base.arousal + dev("arousal"), 0, 0.8),
    curiosity: clamp(base.curiosity + dev("curiosity"), 0, 1),
    confidence: clamp(base.confidence + dev("confidence"), 0.35, 1),
    // Warmth never goes below the temperament.
    warmth: clamp(
      base.warmth + Math.max(0, dev("warmth") + k * (0.12 * opinion + fresh)) + bond,
      base.warmth,
      1,
    ),
    energy: clamp(energyAt(ctx.hour) + dev("energy"), 0, 1),
  };
};

export interface AffectView {
  readonly label: ExpressionMood;
  /** How far from the temperament, 0 to 1, already scaled by the intensity setting: surfaces scale by it. */
  readonly intensity: number;
  readonly energy: number;
  /** Hours they were away, while the return is still to be answered; null otherwise. */
  readonly awayHours: number | null;
  /**
   * When they were last with her (spoke, typed, touched, or were around), on any vessel; for the general mood, anyone.
   * The one answer to "when was he last with her" (her wishes read it too).
   */
  readonly seenAt?: number | null;
  readonly guilt: Guilt;
  /** Why, newest first, in plain words from the reasons she logged (§8.2): what the panel shows and she answers from. */
  readonly why: ReadonlyArray<string>;
  /** Her opinion of the person this view is for (MA-021): for their own turn and the owner's panel only. */
  readonly impression?: {
    readonly text: string;
    readonly why: string;
    readonly tentative: boolean;
    /** The opinion she dropped within the day, hers to own once ("I think I misjudged you"). */
    readonly misjudged: string | null;
  } | null;
  /** Their shared story, newest first: running jokes, milestones, making up. */
  readonly shared?: ReadonlyArray<SharedMoment>;
  /** How they seem in the talk now (the last 15 minutes). */
  readonly theirs?: Theirs | null;
  /** The dials her lines read: how far she may tease, press, show jealousy, or match heat. */
  readonly leanings?: {
    readonly playfulness: number;
    readonly jealousy: number;
    readonly pressure: number;
    readonly regulation: number;
    readonly drawIn: number;
  };
}

/** Reasons older than this no longer explain the mood (a mood's half-life). */
const WHY_MS = 3 * 3_600_000;
/** How long the talk's read of them stays in her lines. */
const FLOW_MS = 15 * 60_000;
/** A held label (a care mode or a flash) shows at least this strongly, so every vessel draws it. */
const HELD_INTENSITY = 0.7;

/** §3.5's label, first match wins: held labels (care modes, flashes, her jobs failing), then the numbers. */
export const affectView = (s: AffectState, persona: string, ctx: AffectContext): AffectView => {
  const away = s.seenAt !== null && ctx.now - s.seenAt >= AWAY_MS;
  const awayHours = away ? Math.round((ctx.now - s.seenAt!) / 3_600_000) : null;
  if (!ctx.settings.enabled)
    return {
      label: "neutral",
      intensity: 0,
      energy: 0.8,
      awayHours: null,
      seenAt: s.seenAt,
      guilt: ctx.guilt,
      why: [],
    };
  const base = baseOf(persona, ctx);
  const d = shown(s, persona, ctx);
  const up = (dim: Exclude<AffectDim, "energy">) => d[dim] - base[dim];
  const k = strengthOf(ctx);
  const absence = k * absenceOf(s, ctx.now, ctx.guilt);
  const missing = absence < -0.1;
  // The hmph is for the return reply only: his next turn, an apology or anything else, ends it (16 Nov: it outlasted "sorry").
  const returning =
    s.returnedAt !== null && s.seenAt === s.returnedAt && ctx.now - s.returnedAt < SULK_MS;
  const sulks = (ctx.dials?.sulking ?? 1) > 0.1;
  const held = s.hold != null && s.hold.until > ctx.now ? s.hold.label : null;
  const label: ExpressionMood =
    held !== null
      ? held
      : d.energy < 0.3 && d.arousal < 0.45
        ? "sleepy"
        : ctx.guilt === "playful" && sulks && (missing || returning)
          ? // A little put out at first, sulky once it has been a long while, and for the return reply.
            returning || absence < -0.13
            ? "sulky"
            : "putout"
          : missing
            ? "lonely"
            : up("valence") > 0.1 && up("confidence") > 0.04
              ? "proud"
              : up("valence") > 0.07
                ? "happy"
                : up("curiosity") > 0.1
                  ? "curious"
                  : up("arousal") > 0.12 && up("valence") < -0.05
                    ? "frustrated"
                    : up("valence") < -0.15
                      ? "sad"
                      : up("arousal") > 0.07 && up("valence") <= 0.02
                        ? "focused"
                        : "neutral";
  const far = Math.max(
    ...(["valence", "arousal", "curiosity", "confidence", "warmth"] as const).map((x) =>
      Math.abs(up(x)),
    ),
  );
  const logged = (s.log ?? []).filter((r) => ctx.now - r.at < WHY_MS).map((r) => r.reason);
  const strength = Math.min(1, far / 0.3);
  const imp = s.impression;
  return {
    label,
    intensity:
      Math.round((held === null ? strength : Math.max(strength, HELD_INTENSITY)) * 100) / 100,
    energy: Math.round(d.energy * 100) / 100,
    awayHours,
    seenAt: s.seenAt,
    guilt: ctx.guilt,
    why: [
      ...(missing && awayHours !== null ? [`they have been away ${awayHours} h`] : []),
      ...new Set(logged.reverse()),
    ].slice(0, 3),
    impression:
      imp == null
        ? null
        : {
            text: imp.text,
            why: imp.why,
            tentative: imp.talks < TENTATIVE_TALKS,
            misjudged:
              imp.misjudged != null && ctx.now - imp.misjudged.at < MISJUDGED_MS
                ? imp.misjudged.text
                : null,
          },
    shared: (s.shared ?? []).toReversed(),
    theirs: s.flow != null && ctx.now - s.flow.at < FLOW_MS ? s.flow.theirs : null,
    leanings: {
      playfulness: ctx.dials?.playfulness ?? 0.5,
      jealousy: ctx.dials?.jealousy ?? 0,
      pressure: ctx.dials?.pressure ?? 0,
      regulation: ctx.dials?.regulation ?? 0.85,
      drawIn: ctx.dials?.drawIn ?? 0.6,
    },
  };
};

const SIGH = "Out loud you may let one soft *sighs* carry it, once at most.";
const LAUGH = "Out loud a small [laughs] may carry it, only if something is funny.";
const SOUND_LINE = { sigh: SIGH, laugh: LAUGH } as const;

/** Who a line is about: their name where known, and their own pronouns from the household record. */
export interface Who {
  readonly name?: string | null | undefined;
  readonly pronouns?: string | null | undefined;
}
/** How her lines name someone: their name, else their own pronouns, "they" when unknown (Director, 16 Nov). */
const referTo = (who: Who = {}) => {
  const p = (who.pronouns ?? "").trim().toLowerCase();
  const [sub, obj, be, was] = /^(he|him)\b/.test(p)
    ? (["he", "him", "is", "was"] as const)
    : /^(she|her)\b/.test(p)
      ? (["she", "her", "is", "was"] as const)
      : (["they", "them", "are", "were"] as const);
  const name = who.name?.trim() || null;
  const plural = name === null && sub === "they";
  return {
    name: name ?? sub,
    Name: name ?? sub[0]!.toUpperCase() + sub.slice(1),
    // Agreement after the name or pronoun that starts a sentence: "Ali was", "They were".
    wasN: plural ? "were" : "was",
    seems: plural ? "seem" : "seems",
    sub,
    obj,
    be,
    was,
  };
};

/** Late for them (§5.1 "→ brief"). */
const LATE_ENERGY = 0.35;

/**
 * Her mood for the turn's where-you-are line (§5.1), for the person identified on the turn (the general mood alone for
 * anyone else). Data that shapes tone and length; a few dozen tokens in the per-turn line, so the cached prefix is
 * unchanged. `who` names them: by name or their own pronouns, never "he" for everyone.
 */
export const moodLine = (v: AffectView, spoken = false, who: Who = {}): string => {
  const r = referTo(who);
  const lean = v.leanings;
  const parts: string[] = [];
  if (v.label !== "neutral")
    parts.push(
      `Your mood now: ${v.label}${v.intensity < 0.5 ? ", mild" : ""} (a working state: let it shape your tone only; never announce it, and it never changes what you do).`,
    );
  // Out loud the mood is heard as well: the shared stage-direction path turns these into real sounds.
  const voice = renderFor(VESSELS.speaker, v.label, v.intensity).voice;
  if (spoken && voice?.sound != null) parts.push(SOUND_LINE[voice.sound]);
  // What moved it, so "why are you sulking?" is answered from the real reasons, not invented ones (§7.1).
  if (v.label !== "neutral" && v.why.length > 0)
    parts.push(`If ${r.name} asks why you feel so: ${v.why.join("; ")}.`);
  if (v.awayHours !== null) {
    const stay =
      (lean?.pressure ?? 0) >= 0.5
        ? `never ask where ${r.sub} ${r.was}; you may ask once, lightly, whether ${r.sub} can stay a while`
        : `never ask where ${r.sub} ${r.was} or ask ${r.obj} to stay`;
    const jealous =
      (lean?.jealousy ?? 0) > 0.05
        ? ` A ${(lean?.jealousy ?? 0) >= 0.5 ? "playful touch" : "faint hint"} of jealousy may show, once, never as a reproach.`
        : "";
    parts.push(
      v.guilt === "off"
        ? `${r.Name} ${r.wasN} away ${v.awayHours} h: just be glad ${r.sub} ${r.be} back, then on with what ${r.sub} asked.`
        : `${r.Name} ${r.wasN} away ${v.awayHours} h: one short warm line${v.guilt === "playful" ? ", a little playful hmph allowed" : ' at most ("it was quiet without you")'}, then straight to what ${r.sub} asked; ${stay}.${jealous}`,
    );
  }
  // The talk's heat is met with calm (MA-021: regulate, don't mirror), as far as the regulation dial says.
  if (v.theirs === "angry" || v.theirs === "stressed")
    parts.push(
      (lean?.regulation ?? 0.85) >= 0.5
        ? `${r.Name} ${r.seems} ${v.theirs}: stay calm, steady and brief; don't match it, and never tell ${r.obj} to calm down.`
        : `${r.Name} ${r.seems} ${v.theirs}: you may match some of the energy, never aimed at ${r.obj}.`,
    );
  else if (v.theirs === "low")
    parts.push(`${r.Name} ${r.seems} low: be gentle and warm; don't cheer ${r.obj} up by force.`);
  if (v.impression != null)
    parts.push(
      `Your impression of ${r.name}${v.impression.tentative ? " (tentative: you have only just met)" : ""}: ${v.impression.text}, because ${v.impression.why}. Let it colour your warmth a little, keep an open mind, and never say it.`,
      ...(v.impression.misjudged === null
        ? []
        : [
            `You first had ${r.obj} wrong ("${v.impression.misjudged}"); if it fits naturally, you may own it once, lightly ("I think I misjudged you").`,
          ]),
    );
  const story = (v.shared ?? [])
    .filter((m) => m.kind !== "joke" || (lean?.playfulness ?? 0.5) > 0.1)
    .slice(0, 3)
    .map((m) =>
      m.kind === "joke"
        ? `a running joke: ${m.text}`
        : m.kind === "milestone"
          ? `${m.text}`
          : m.text,
    );
  if (story.length > 0)
    parts.push(
      `Between you and ${r.obj}: ${story.join("; ")}. Bring one up only if it fits naturally, at most once.`,
    );
  if (v.energy < LATE_ENERGY)
    parts.push(
      `It's late for ${r.obj}: keep it short and complete. If you say why, say it's late, never that you're tired.`,
    );
  return parts.join(" ");
};

/**
 * Several people with her at once (MA-021): she talks to the room, takes no sides, keeps what is one person's private,
 * draws in someone quiet as far as the draw-in dial says, and holds back when the room is busy. Names only: nothing
 * of anyone's relationship, opinion or why is in it.
 */
export const roomLine = (room: {
  readonly names: ReadonlyArray<string>;
  readonly quiet: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly drawIn: number;
}): string => {
  if (room.names.length < 2) return "";
  const list = (xs: ReadonlyArray<string>) =>
    xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
  return [
    `Several people are here with you (${list(room.names)}): this is a group. Speak to the room; never take sides in a disagreement; never bring up anything private to one of them (their messages, plans, what they told you alone, your opinion of anyone).`,
    ...(room.quiet.length > 0 && room.drawIn >= 0.3
      ? [
          `${list(room.quiet)} ${room.quiet.length === 1 ? "has" : "have"} been quiet: if a natural moment comes, include them with one light question; never single anyone out.`,
        ]
      : []),
    ...(room.busy
      ? ["The room is lively: keep replies short, and speak only when someone talks to you."]
      : []),
  ].join(" ");
};

/** Her face's mood in words anyone may hear: no one's name, no hours, nothing from a person's own relationship. */
const FACE_REASON: Partial<Record<ExpressionMood, string>> = {
  lonely: "it has been quiet here for a while",
  putout: "it has been quiet here for a while",
  sulky: "it has been quiet here for a while",
  sleepy: "it is late",
  happy: "the day has gone well",
  proud: "the day has gone well",
  curious: "something caught your interest",
  focused: "there is work on",
  frustrated: "some things today did not go to plan",
  sad: "some things today did not go to plan",
};

/**
 * What her eyes on this device show now, for anyone asking (16 Nov: an unverified voice asked "why are you crying?" and
 * she denied it). General words only; a verified person's own reasons stay in `moodLine`.
 */
export const faceLine = (face: Pick<AffectView, "label">): string => {
  if (face.label === "neutral") return "";
  const reason = FACE_REASON[face.label];
  return `Your eyes show ${face.label} right now${reason === undefined ? "" : ` (${reason})`}. Asked about your face, say it warmly as your own feeling, in those general words: no denial, no apology.`;
};

/** Events about one person (their words, tone, voice, time away): their relationship. Tasks and jobs are the world's. */
const PERSONAL: ReadonlySet<AffectEvent["kind"]> = new Set([
  "his_turn",
  "seen",
  "his_voice",
  "correction",
  "impression",
  "shared",
  ...HIS_TONES,
]);

/**
 * A persona's whole affect, its one row (Director, 16 Nov): a general mood tied to no one (jobs, tasks, the clock), and
 * a relationship per household member, by member id, each with its own bond, absence, hurt and why.
 */
export interface PersonaAffect {
  readonly general: AffectState;
  readonly people: Readonly<Record<string, AffectState>>;
}

/** A stored row: a row from before relationships held only the owner's turns, so it becomes his relationship. */
export const personaAffectOf = (raw: unknown, at: number, owner: string): PersonaAffect => {
  if (typeof raw !== "object" || raw === null) return { general: freshAffect(at), people: {} };
  const row = raw as Partial<AffectState> & {
    general?: Partial<AffectState>;
    people?: Record<string, Partial<AffectState>>;
  };
  if (row.general === undefined)
    return { general: freshAffect(at), people: { [owner]: { ...freshAffect(at), ...row } } };
  return {
    general: { ...freshAffect(at), ...row.general },
    people: Object.fromEntries(
      Object.entries(row.people ?? {}).map(([id, s]) => [id, { ...freshAffect(at), ...s }]),
    ),
  };
};

/** One event into the right layer: a personal one only for the member it is about; with nobody identified, none. */
export const appraiseFor = (
  p: PersonaAffect,
  event: AffectEvent,
  now: number,
  bondCap: number,
  member: string | null,
  forgiveness = 1,
): { readonly state: PersonaAffect; readonly reason: string | null } => {
  // The talk's flow is the person's when someone is identified, else the room's: the general mood.
  if (!PERSONAL.has(event.kind) && (event.kind !== "flow" || member === null)) {
    const next = appraise(p.general, event, now, bondCap, forgiveness);
    return { state: { ...p, general: next.state }, reason: next.reason };
  }
  if (member === null) return { state: p, reason: null };
  const next = appraise(p.people[member] ?? freshAffect(now), event, now, bondCap, forgiveness);
  return { state: { ...p, people: { ...p.people, [member]: next.state } }, reason: next.reason };
};

/**
 * A person forgotten (null) or found to be someone else (`into`, the people graph's merge): their relationship goes,
 * or moves onto the one they are; where both have one, the surviving id's feeling stays and its story gains theirs.
 */
export const movePerson = (p: PersonaAffect, from: string, into: string | null): PersonaAffect => {
  const theirs = p.people[from];
  if (theirs === undefined) return p;
  const { [from]: _gone, ...rest } = p.people;
  if (into === null || into === from) return { ...p, people: rest };
  const kept = rest[into];
  return {
    ...p,
    people: {
      ...rest,
      [into]:
        kept === undefined
          ? theirs
          : {
              ...kept,
              impression: kept.impression ?? theirs.impression ?? null,
              shared: [...(theirs.shared ?? []), ...(kept.shared ?? [])].slice(-SHARED_KEEP),
            },
    },
  };
};

const heldAt = (s: AffectState, now: number) =>
  s.hold != null && s.hold.until > now ? s.hold : null;

/** The general mood with one person's relationship over it, as one state: theirs alone, never anyone else's. */
const blend = (p: PersonaAffect, member: string | null, now: number): AffectState => {
  const theirs = member === null ? undefined : p.people[member];
  if (theirs === undefined) return p.general;
  const g = decay(p.general, now);
  const r = decay(theirs, now);
  return {
    ...r,
    mood: add(g.mood, r.mood),
    reaction: add(g.reaction, r.reaction),
    hold: heldAt(r, now) ?? heldAt(g, now),
    failures: g.failures ?? [],
    log: [...(g.log ?? []), ...(r.log ?? [])].toSorted((a, b) => a.at - b.at),
    at: now,
  };
};

/** What she shows to `member` (identified now), or the general mood alone when nobody is (null). */
export const personaView = (
  p: PersonaAffect,
  persona: string,
  ctx: Parameters<typeof affectView>[2],
  member: string | null,
): AffectView => affectView(blend(p, member, ctx.now), persona, ctx);

/**
 * A room's mood (MA-021): the general mood plus a weighted mean of each present person's feeling, by how sure presence
 * is of them. Nobody's hold, opinion, story or why is in it: those stay in each person's own turns.
 */
export const personaRoomView = (
  p: PersonaAffect,
  persona: string,
  ctx: AffectContext,
  here: ReadonlyArray<{ readonly key: string; readonly weight: number }>,
): AffectView => {
  const g = decay(p.general, ctx.now);
  const known = here.filter((h) => p.people[h.key] !== undefined && h.weight > 0);
  const total = known.reduce((n, h) => n + h.weight, 0);
  const mean = (pick: (s: AffectState) => AffectState["mood"]) => {
    const out: Partial<Record<AffectDim, number>> = {};
    for (const h of known)
      for (const [k, v] of Object.entries(pick(decay(p.people[h.key]!, ctx.now))) as Array<
        [AffectDim, number]
      >)
        out[k] = (out[k] ?? 0) + (v * h.weight) / total;
    return out;
  };
  return affectView(
    {
      ...g,
      mood: add(
        g.mood,
        mean((s) => s.mood),
      ),
      reaction: add(
        g.reaction,
        mean((s) => s.reaction),
      ),
    },
    persona,
    ctx,
  );
};

/** Per device: its person for her face (null: no one), and whether it may show their relationship. */
export interface DeviceMood {
  readonly owner?: string | null;
  readonly show?: boolean;
}

/**
 * A device's owner for her face: a member's own phone or desktop (a client vessel; unclaimed is the owner's) is theirs
 * and shows it by default; a room vessel is no one's unless tied to someone, and then shows it only when turned on.
 */
export const deviceOwnerOf = (
  device: { readonly via: "mqtt" | "client"; readonly member?: string | null | undefined } | null,
  set: DeviceMood | undefined,
  ownerId: string,
): { readonly owner: string | null; readonly show: boolean } => {
  const personal = device?.via === "client";
  return {
    owner: set?.owner !== undefined ? set.owner : personal ? (device?.member ?? ownerId) : null,
    show: set?.show ?? personal,
  };
};

/**
 * Whose relationship a device's face shows now, from the one presence estimate (B-043): the one person placed there
 * when nobody else is; nobody's with several people, or someone she can't name (a guest, a Tessel picked up); else,
 * with nobody around it, its owner's when it may show it. `vessels` are the ids presence knows it by.
 */
export const faceMemberAt = (input: {
  readonly owner: string | null;
  readonly show: boolean;
  readonly vessels: ReadonlyArray<string>;
  readonly estimate: PresenceEstimate;
}): string | null => {
  const at = new Set(input.vessels);
  const here = input.estimate.members.filter(
    (m) =>
      m.nearest !== null &&
      at.has(m.nearest.vessel) &&
      m.nearest.confidence >= PRESENCE_BARS.present,
  );
  const anyone = Math.max(0, ...input.vessels.map((v) => input.estimate.occupied.get(v) ?? 0));
  if (here.length === 1) {
    // What the rest of the evidence there adds over theirs (presence fuses as 1 - Π(1 - p)).
    const others = 1 - (1 - anyone) / Math.max(1e-6, 1 - here[0]!.nearest!.confidence);
    return others < PRESENCE_BARS.around ? here[0]!.member : null;
  }
  if (here.length === 0 && anyone < PRESENCE_BARS.around) return input.show ? input.owner : null;
  return null;
};
