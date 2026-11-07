/**
 * Which model answers a chat turn. Simple turns (the time, what needs him, a yes) go to the fast
 * model, most to the middle one, and planning or a chain of actions to the strongest. The persona's
 * own model is the ceiling: a turn never runs above it. Rules, not a model call: deciding must cost
 * nothing, or the fast path is not fast.
 */
import type { Brain } from "./osPack.ts";

export type TurnTier = "fast" | "default" | "deep";

export interface TurnChoice {
  readonly tier: TurnTier;
  readonly brain: Brain;
  /** In a few words, for the turn log. */
  readonly why: string;
}

/** The model a tier asks for. Effort for the strongest is the persona's own. */
const TIER_MODEL: Readonly<Record<TurnTier, string>> = {
  fast: "haiku",
  default: "sonnet",
  deep: "opus",
};
const RANK: Readonly<Record<string, number>> = { haiku: 0, sonnet: 1, opus: 2 };
const TIERS: ReadonlyArray<TurnTier> = ["fast", "default", "deep"];

/** A yes, a no or a thanks: the turn before it decides how much thought it needs. */
const REPLY_ONLY =
  /^(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|right|fine|alright|thanks|thank you|cheers|great|perfect|cool|nice|lovely|got it|go ahead|go on|do it|do that|please|please do|sounds good|that's fine|not now|never mind|cancel|hang on|wait)(?: (?:please|then|thanks|thank you|go ahead|do it|mate))*$/;
const CLOCK =
  /\b(?:what(?:'s| is) the (?:time|date|day)|what time is it|what day is (?:it|today)|what(?:'s| is) today(?:'s date)?|what's the date)\b/;
/** Questions one read-only tool answers. */
const STATUS =
  /\b(?:what needs (?:me|my)|needs me|needs my (?:attention|approval|eyes)|anything stuck|is anything (?:stuck|broken|waiting)|what(?:'s| is) (?:every(?:one|body)|the team) (?:working on|doing)|what happened (?:overnight|today|while i was away)|how(?:'s| is) (?:it|everything|the \w+) going|any (?:news|updates?))\b/;
const GREETING =
  /^(?:hi|hello|hey|morning|good (?:morning|afternoon|evening|night)|how are you(?: doing| today)?|you there|are you there)$/;
const QUESTION_START =
  /^(?:what|what's|whats|who|who's|when|where|which|how many|how much|how old|how far|how long|is|are|was|does|do|did|can you tell me)\b/;
/** Doing something, or looking at the screen: never the fast model. */
const ACTION =
  /\b(?:approve|reject|merge|deploy|kill|transfer|roll back|rollback|cancel|type|click|press|open|close|save|send|tell|ask|start|stop|make|create|write|draft|edit|change|move|delete|remove|fix|run|book|buy|pay|install|remind|schedule|set|turn|switch|fill|copy|paste|reply|email|message|post|split|screen|monitor|window|see|look|showing|teach)\b/;
/** Planning, research or a judgement call. */
const DEEP =
  /\b(?:plan|planning|figure out|work out|think through|break (?:it|this|that) down|strategy|strategi[sz]e|organi[sz]e|prioriti[sz]e|take on a job|job|split (?:it|the|this)|for me|step by step|research|investigate|compare|review|refactor|migrate|debug|should i|what do you think|your (?:advice|opinion|view)|pros and cons|trade.?offs?|decide|weigh up)\b/;
/** Two actions in one breath: a chain of tool calls. */
const CHAIN =
  /\b(?:and then|then|and (?:save|send|close|open|press|click|type|tell|email|post|reply))\b/;

const words = (text: string): number => text.split(" ").filter(Boolean).length;

const plain = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The tier this sentence needs on its own, and why. */
export const tierOfSentence = (said: string): { readonly tier: TurnTier; readonly why: string } => {
  // "look, what needs me" opens with a word that is not an action, set off by its comma.
  const t = plain(said.replace(/^\s*(?:look|listen|so|well|right|okay|ok),\s*/i, ""));
  if (words(t) > 30) return { tier: "deep", why: "long request" };
  if (DEEP.test(t)) return { tier: "deep", why: "planning or judgement" };
  // "Then start dictating" carries on from the last turn: a "then" that opens it chains nothing.
  if (ACTION.test(t) && CHAIN.test(t.replace(/^(?:and |so |okay |ok )?then /, "")))
    return { tier: "deep", why: "several steps" };
  // Before the fast checks: "what needs me? approve the first one" is an action, not a status question.
  if (ACTION.test(t)) return { tier: "default", why: "an action" };
  if (CLOCK.test(t)) return { tier: "fast", why: "time or date" };
  if (STATUS.test(t)) return { tier: "fast", why: "status" };
  if (GREETING.test(t)) return { tier: "fast", why: "greeting" };
  if (REPLY_ONLY.test(t)) return { tier: "fast", why: "short reply" };
  if (QUESTION_START.test(t) && words(t) <= 8 && !ACTION.test(t))
    return { tier: "fast", why: "short question" };
  return { tier: "default", why: "default" };
};

/** A model or effort he picked himself (voice, tray, settings, a tool): it holds until he says "back to normal". */
export type ManualModel = "haiku" | "sonnet" | "opus";
export type ManualEffort = "low" | "medium" | "high";
export interface ManualBrain {
  readonly model: ManualModel | null;
  readonly effort: ManualEffort | null;
}
export const AUTOMATIC: ManualBrain = { model: null, effort: null };
export const isAutomatic = (manual: ManualBrain): boolean =>
  manual.model === null && manual.effort === null;

const USE_MODEL =
  /^(?:please )?(?:use|switch to|change to|go to|move to|try) (?:the )?(haiku|sonnet|opus)(?: model)?(?: please| from now on| for now| instead)?$/;
const HARDER =
  /^(?:think (?:harder|more|deeper|longer)|take (?:more|your) time|try harder)(?: please)?$/;
const FASTER = /^(?:go faster|be (?:quicker|faster)|speed up)(?: please)?$/;
const NORMAL =
  /^(?:go )?(?:back to normal|back to automatic|automatic model|reset the model|pick the model yourself|choose the model yourself)(?: please)?$/;

/** The choice a sentence makes when all it does is change how he is answered, or null for any other sentence. */
export const modelCommand = (
  said: string,
  current: ManualBrain,
  /** A paired device's or an agent's words: they never change his setting. */
  outside = false,
): ManualBrain | null => {
  if (outside) return null;
  const t = plain(said);
  const named = USE_MODEL.exec(t)?.[1] as ManualModel | undefined;
  if (named !== undefined) return { model: named, effort: current.effort };
  if (HARDER.test(t)) return { model: current.model ?? "opus", effort: "high" };
  if (FASTER.test(t)) return { model: "haiku", effort: "low" };
  if (NORMAL.test(t)) return AUTOMATIC;
  return null;
};

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
/** For the tray, settings and his ears: "Automatic", "Opus", "Opus, high effort", "High effort". */
export const manualLabel = (manual: ManualBrain): string =>
  isAutomatic(manual)
    ? "Automatic"
    : [
        manual.model === null ? null : title(manual.model),
        manual.effort === null
          ? null
          : manual.model === null
            ? `${title(manual.effort)} effort`
            : `${manual.effort} effort`,
      ]
        .filter((part) => part !== null)
        .join(", ");

/** The persona's own model as a tier, or null for a model these rules do not know (kept as it is). */
const ceilingOf = (brain: Brain): TurnTier | null => {
  const name = Object.keys(RANK).find((alias) => brain.model.toLowerCase().includes(alias));
  return name === undefined ? null : TIERS[RANK[name]!]!;
};

const brainFor = (tier: TurnTier, ceiling: Brain): Brain =>
  tier === "deep"
    ? ceiling
    : { model: TIER_MODEL[tier], effort: tier === "fast" ? "low" : "medium" };

/**
 * The model for this turn, at most the persona's own. A bare yes or thanks right after a turn keeps
 * that turn's tier, so "go ahead" to a plan is carried out by the model that made it.
 */
export const chooseTurnBrain = (
  said: string,
  ceiling: Brain,
  previous: TurnTier | null = null,
  manual: ManualBrain = AUTOMATIC,
): TurnChoice => {
  const auto = autoTurnBrain(said, ceiling, previous);
  // His own choice wins over the rules and the persona's ceiling: he asked for it.
  if (isAutomatic(manual)) return auto;
  return {
    tier: auto.tier,
    // A chosen model at automatic effort runs at the one effort `tierBrains` warms it at.
    brain:
      manual.model === null
        ? { model: auto.brain.model, effort: manual.effort ?? auto.brain.effort }
        : { model: manual.model, effort: manual.effort ?? "medium" },
    why: `his choice (${manualLabel(manual)})`,
  };
};

const autoTurnBrain = (said: string, ceiling: Brain, previous: TurnTier | null): TurnChoice => {
  const top = ceilingOf(ceiling);
  if (top === null) return { tier: "deep", brain: ceiling, why: "persona's own model" };
  const own = tierOfSentence(said);
  const picked =
    previous !== null && own.why === "short reply"
      ? // A yes to a quick answer may start real work: it is never carried on the fast model.
        { tier: previous === "fast" ? "default" : previous, why: "answers the last turn" }
      : own;
  const tier = TIERS[Math.min(TIERS.indexOf(picked.tier), TIERS.indexOf(top))]!;
  return {
    tier,
    brain: tier === top ? ceiling : brainFor(tier, ceiling),
    why: tier === picked.tier ? picked.why : `${picked.why}, capped at the persona's model`,
  };
};

/**
 * Every model a persona's turns can land on, so each can be kept warm, `first` first: that one is warmed at
 * once and the rest after its first answer, so a wake never starts three sessions together.
 */
export const tierBrains = (
  ceiling: Brain,
  manual: ManualBrain = AUTOMATIC,
  first: TurnTier = "default",
): ReadonlyArray<Brain> => {
  if (manual.model !== null) return [{ model: manual.model, effort: manual.effort ?? "medium" }];
  const top = ceilingOf(ceiling);
  const all =
    top === null
      ? [{ tier: "deep" as TurnTier, brain: ceiling }]
      : TIERS.slice(0, TIERS.indexOf(top) + 1).map((tier) => ({
          tier,
          brain: tier === top ? ceiling : brainFor(tier, ceiling),
        }));
  const own = (brain: Brain) =>
    manual.effort === null ? brain : { model: brain.model, effort: manual.effort };
  const lead = all.find((b) => b.tier === first) ?? all.at(-1)!;
  return [lead, ...all.filter((b) => b !== lead)].map((b) => own(b.brain));
};

/** A bare yes or thanks this soon after a turn has finished answers it, on the same model. */
export const TIER_CARRY_MS = 2 * 60_000;

/** The last turn's tier, timed from when its answer settled: a long plan's "go ahead" comes after it ends, not after it began. */
export const createTierMemory = (now: () => number = Date.now) => {
  let last: { readonly tier: TurnTier; readonly at: number } | null = null;
  return {
    previous: (): TurnTier | null =>
      last !== null && now() - last.at < TIER_CARRY_MS ? last.tier : null,
    /** A device's or agent's turn is not his: his next yes does not answer it. */
    settled: (tier: TurnTier, outside = false) => {
      if (!outside) last = { tier, at: now() };
    },
  };
};
