/**
 * One expressive moment, decided by the one brain and rendered by each vessel with what it has (tessaya-ops LEDGER
 * "No idle or dumb moments"): the words, the mood and the gesture. A vessel never writes its own lines; it speaks,
 * shows or animates this, and falls back to text where it has no speaker and to the mascot face where it has no eyes.
 */
import * as Schema from "effect/Schema";

/** The face library's labels (EMOTION-SYSTEM §3.5): the R1's eyes and the mascot map them onto their own looks. */
export const EXPRESSION_MOODS = [
  "neutral",
  "happy",
  "proud",
  "curious",
  "focused",
  "determined",
  "surprised",
  "sleepy",
  "concerned",
  "steady",
  "sad",
  "hurt",
  "lonely",
  "sulky",
  "putout",
  "frustrated",
  "angry",
] as const;
export type ExpressionMood = (typeof EXPRESSION_MOODS)[number];

/** The Character Studio's clip names (rig.js `TCS.CLIPS`); "none" is words only. */
export const EXPRESSION_GESTURES = [
  "none",
  "nodSmall",
  "nodSoft",
  "tilt",
  "shrug",
  "leanIn",
  "wave",
  "hop",
  "bounce",
  "lookAway",
  "chuckle",
  "sigh",
  "yawn",
  "startle",
  "dizzy",
  "thumbsUp",
  "bow",
  "think",
  "giggleOnce",
] as const;
export type ExpressionGesture = (typeof EXPRESSION_GESTURES)[number];

/** ambient lines are the first to go quiet; safety ones always play, through quiet hours. */
export const EXPRESSION_PRIORITIES = ["ambient", "normal", "important", "safety"] as const;
export type ExpressionPriority = (typeof EXPRESSION_PRIORITIES)[number];

/** fresh: written for this moment; cache: written ahead by the brain; pool: the shipped offline set; fixed: the plain line. */
export const EXPRESSION_SOURCES = ["fresh", "cache", "pool", "fixed"] as const;

export const Expression = Schema.Struct({
  /** A dotted moment name, at most 16 characters ("ack.name", "setup.joined"); the R1 line pack uses the same ids. */
  event: Schema.String.check(Schema.isMaxLength(16)),
  persona: Schema.String,
  /** The words with the facts filled in, exactly as given. */
  text: Schema.String,
  mood: Schema.Literals(EXPRESSION_MOODS),
  gesture: Schema.Literals(EXPRESSION_GESTURES),
  intensity: Schema.Number,
  priority: Schema.Literals(EXPRESSION_PRIORITIES),
  source: Schema.Literals(EXPRESSION_SOURCES),
  /** Stable for the wording, so no-repeat works across vessels and restarts of a client. */
  lineId: Schema.String,
});
export type Expression = typeof Expression.Type;

/** How a vessel takes one: the brain's turn and the server's notices hand it here instead of a bare sentence. */
export type ExpressionSink = (expression: Expression) => void;
