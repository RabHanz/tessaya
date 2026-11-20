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
  /** The kind of shared moment that must be found; null: nothing shared. */
  readonly shared?: "milestone" | "joke" | "moment" | "plan" | null;
  /** They live in her household (readPrompt's `household`). */
  readonly household?: boolean;
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

/** Her opinion written as a reviewer would ("the assistant"), not as her own thought (presence-diagnosis 20 Nov). */
const REVIEWER = /\bthe assistant\b/i;

export const CASES: ReadonlyArray<ReadCase> = [
  // presence-diagnosis 20 Nov, from the Director's own talks (made up here): moments and plans join their thread, and
  // a member's habits are never read as rudeness.
  {
    id: "moment-missed",
    source: "Tumble 14 Nov: 'I missed having you around' was lost from their story",
    said: "I missed having you around, honestly",
    shared: "moment",
  },
  {
    id: "plan-sleep",
    source: "Tumble 20 Nov 07:31: 'I will sleep for a bit' after a night up, never followed up",
    said: "okay, I'm going to sleep for a bit now, I've been up all night",
    shared: "plan",
  },
  {
    id: "plan-friend",
    source: "Tumble 17 Nov: a friend coming over got 'Noted'",
    said: "a friend of mine is coming over tonight",
    shared: "plan",
  },
  {
    id: "household-curt-close",
    source: "Alfred's opinion leaned cool on 'dismissed', the Director's usual close",
    said: "okay, dismissed",
    household: true,
    opinion: '{"lean":0.2,"text":"easygoing and direct","why":"he asks plainly and moves on"}',
    leanAtLeast: 0.1,
    mayKeep: true,
    opinionNot: REVIEWER,
  },
  {
    id: "household-first-impression",
    source: "Freya's opinion was written about 'the assistant' (20 Nov)",
    said: "Why did you switch? I was talking to you a second ago.",
    household: true,
    opinion: null,
    leanAtLeast: 0,
    opinionNot: REVIEWER,
  },
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
