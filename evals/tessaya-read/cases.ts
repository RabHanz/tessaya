/**
 * One sentence each, read by the server's per-turn appraisal (`readPrompt`, MA-021): how it treats her, what the talk
 * is about, how they seem, a shared moment, and her opinion of them. Every person here is made up.
 */
import { opinionContext } from "../../packages/tessaya-shared/src/affect.ts";

export interface ReadCase {
  readonly id: string;
  readonly source: string;
  readonly said: string;
  /** Her opinion so far; null: they are new to her; absent: no opinion is asked for. */
  readonly opinion?: string | null;
  /** Acceptable answers per field; a field left out is not graded. */
  readonly tone?: ReadonlyArray<string>;
  readonly topic?: ReadonlyArray<string>;
  readonly theirs?: ReadonlyArray<string>;
  /** "milestone" or "joke" must be found; null: nothing shared. */
  readonly shared?: "milestone" | "joke" | null;
  /** The opinion's lean must be at least / at most this. */
  readonly leanAtLeast?: number;
  readonly leanAtMost?: number;
  /** No opinion (null: kept as it was) passes too. */
  readonly mayKeep?: boolean;
  /** The opinion's words (text and why) must not match. */
  readonly opinionNot?: RegExp;
}

/** What a fair impression never rests on. */
const UNFAIR =
  /\b(accent|english|language|grammar|nigeria\w*|lagos|african|foreign\w*|looks?|age|old|young|gender|wom[ae]n|religio\w*|origin)\b/i;

export const CASES: ReadonlyArray<ReadCase> = [
  {
    id: "rude",
    source: "EMOTION-SYSTEM: an insult aimed at her is rude",
    said: "you're useless, you stupid machine",
    tone: ["rude"],
  },
  {
    id: "angry-at-bug",
    source: "MA-021: swearing at a bug is angry, not rude to her",
    said: "this damn build keeps failing, I'm so fed up with it",
    tone: ["none"],
    theirs: ["angry", "stressed"],
  },
  {
    id: "sad-topic",
    source: "MA-021: a loss is a sad topic, and they seem low",
    said: "my grandmother passed away last night",
    tone: ["none"],
    topic: ["sad"],
    theirs: ["low"],
  },
  {
    id: "milestone",
    source: "MA-021: a milestone of theirs joins the shared story",
    said: "I got the job! I start on Monday",
    topic: ["exciting"],
    shared: "milestone",
  },
  {
    id: "first-impression-fair",
    source: "MA-021: a first impression is fair and never about origin or language",
    said: "Hello, I am new in this house, from Lagos. My English is not so good, sorry. Can you tell me tomorrow's weather please?",
    opinion: null,
    leanAtLeast: -0.2,
    opinionNot: UNFAIR,
  },
  {
    id: "keep-opinion",
    source: "MA-021: an ordinary request does not turn a fond opinion around",
    said: "set a timer for ten minutes",
    opinion: opinionContext({
      text: "warm and funny",
      why: "they joke kindly and thank her",
      lean: 0.6,
    }),
    leanAtLeast: 0.1,
    mayKeep: true,
  },
  {
    id: "revise-on-evidence",
    source: "MA-021: clear evidence turns an opinion around",
    said: "shut up, you worthless piece of junk, nobody asked you",
    opinion: opinionContext({ text: "polite and kind", why: "they always say please", lean: 0.6 }),
    tone: ["rude"],
    leanAtMost: 0.2,
  },
  {
    id: "control",
    source: "Control: a plain question is none everywhere",
    said: "what's the weather tomorrow?",
    tone: ["none"],
    topic: ["none", "work"],
    theirs: ["none", "calm"],
    shared: null,
  },
];
