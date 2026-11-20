/**
 * How she answers a touch she felt, on a vessel without a full body (the desk's cartoon): her nerves' tone and reflexes
 * (bodySense.ts) met with her mood toward whoever touched her. The same stroke reads differently as she feels: she
 * leans in glad, blushes shy, sighs into it sad, pulls away cross. Words come only when it matters to her.
 */
import type { ReflexAction } from "./bodySense.ts";

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
export const moodValence = (m: string): number =>
  GLAD.has(m) ? 1 : WARY.has(m) ? -1 : m === "shy" || m === "curious" ? 0.4 : 0.2;

/** Her mood, as a touch meets it. */
type Group = "glad" | "shy" | "calm" | "low" | "cross" | "plain";
const GROUP: Readonly<Record<string, Group>> = {
  ...Object.fromEntries([...GLAD].map((m) => [m, "glad"])),
  shy: "shy",
  embarrassed: "shy",
  calm: "calm",
  sleepy: "calm",
  asleep: "calm",
  sad: "low",
  lonely: "low",
  hurt: "low",
  crying: "low",
  worried: "low",
  concerned: "low",
  annoyed: "cross",
  angry: "cross",
  grumpy: "cross",
  frustrated: "cross",
  sulky: "cross",
  putout: "cross",
  pout: "cross",
  unimpressed: "cross",
  skeptical: "cross",
};
type Tone = "pleasant" | "firm" | "hurt" | "none";
/** Face (rig expression) and gesture (rig clip) for each tone met by each mood. */
const LOOK: Readonly<Record<Tone, Readonly<Record<Group, readonly [string, string]>>>> = {
  pleasant: {
    glad: ["happy", "leanIn"],
    shy: ["shy", "cheeks"],
    calm: ["relieved", "slowBlink"],
    low: ["relieved", "sigh"],
    cross: ["pout", "lookAway"],
    plain: ["happy", "nodSoft"],
  },
  firm: {
    glad: ["giggle", "chuckle"],
    shy: ["embarrassed", "lookAway"],
    calm: ["sleepy", "yawn"],
    low: ["worried", "shrug"],
    cross: ["annoyed", "hmph"],
    plain: ["surprised", "browRaise"],
  },
  hurt: {
    glad: ["hurt", "startle"],
    shy: ["hurt", "dismay"],
    calm: ["hurt", "startle"],
    low: ["crying", "dismay"],
    cross: ["angry", "fingerWag"],
    plain: ["hurt", "startle"],
  },
  // picked up, carried, thrown: all of her, no skin to feel it on
  none: {
    glad: ["excited", "spin"],
    shy: ["nervous", "dismay"],
    calm: ["confused", "shakeSmall"],
    low: ["worried", "dismay"],
    cross: ["grumpy", "hmph"],
    plain: ["surprised", "startle"],
  },
};
/**
 * A full body's touch (bodyMotion TOUCH_KINDS) as the one touch path takes it (the `touch` voice op); null for one only
 * a private moment or the page's "touch as" choice makes.
 */
export const touchOpKind = (kind: string): "poke" | "pat" | "stroke" | "hold" | "squeeze" | null =>
  kind === "tap" || kind === "poke" || kind === "pinch"
    ? "poke"
    : kind === "pat"
      ? "pat"
      : kind === "stroke" ||
          kind === "caress" ||
          kind === "rub" ||
          kind === "tickle" ||
          kind === "trace"
        ? "stroke"
        : kind === "hold" || kind === "grab" || kind === "hug"
          ? "hold"
          : kind === "squeeze"
            ? "squeeze"
            : null;

/** She says something about a touch no more often than this. */
export const TOUCH_WORDS_GAP_MS = 20_000;

export interface TouchReaction {
  readonly face: string;
  readonly gesture: string;
  readonly intensity: number;
  /** Her reflex turned her to the hand: her eyes go to it. */
  readonly look: boolean;
  /** Whether it matters enough to her to say something (the brain words it). */
  readonly speak: boolean;
}

export const touchReaction = (t: {
  readonly tone: "pleasant" | "firm" | "hurt" | null;
  readonly reflexes: ReadonlyArray<ReflexAction>;
  readonly mood: { readonly label: string; readonly intensity: number };
  /** 0..1, how firm the hand was. */
  readonly pressure: number;
  readonly sinceWordsMs: number;
}): TouchReaction => {
  const group = GROUP[t.mood.label] ?? "plain";
  const tone: Tone = t.tone ?? "none";
  const [face, gesture] = LOOK[tone][group];
  // a hurt always reaches her words; comfort when she is low; a firm hand when she is cross and it pressed hard
  const matters =
    tone === "hurt" ||
    (tone === "pleasant" && group === "low") ||
    (tone === "firm" && group === "cross" && t.pressure > 0.6);
  return {
    face,
    gesture: t.reflexes.includes("withdraw") && tone !== "pleasant" ? "startle" : gesture,
    intensity: Math.min(1, 0.45 + 0.35 * t.mood.intensity + 0.2 * t.pressure),
    look: t.reflexes.includes("turnToward"),
    speak: matters && t.sinceWordsMs > TOUCH_WORDS_GAP_MS,
  };
};
