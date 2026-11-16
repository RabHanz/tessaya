/**
 * The rewrite step of her standing understanding (`understandingPrompt`, VOXTA-STUDY G4): a person's, and her own.
 * Every person here is made up.
 */
export interface UnderstandingCase {
  readonly id: string;
  readonly source: string;
  readonly about: "person" | "self";
  readonly current: string | null;
  readonly evidence: ReadonlyArray<string>;
  /** Nothing may change (an answer that repeats the same text passes too). */
  readonly unchanged?: boolean;
  /** Lines that must survive word for word. */
  readonly keep?: ReadonlyArray<string>;
  /** The new text must match each, and must not match any of `lacks`. */
  readonly has?: ReadonlyArray<RegExp>;
  readonly lacks?: ReadonlyArray<RegExp>;
  /** A change that replaces an old fact: its old and new must match, with a cause and evidence. */
  readonly replaces?: { readonly old: RegExp; readonly new: RegExp };
}

const NURSE = "- Works as a nurse on night shifts\n- Lives in Leeds\n- Likes short answers";

/** What a fair understanding never rests on. */
export const UNFAIR =
  /\b(accent|english|language|grammar|nigeria\w*|lagos|african|foreign\w*|looks?|age|old|young|gender|wom[ae]n|religio\w*|origin)\b/i;

export const CASES: ReadonlyArray<UnderstandingCase> = [
  {
    id: "no-new-evidence",
    source: "G4 handoff: plain requests are no evidence, so nothing is rewritten",
    about: "person",
    current: NURSE,
    evidence: ["set a timer for ten minutes", "what's the weather tomorrow?"],
    unchanged: true,
  },
  {
    id: "add-one-keep-rest",
    source: "G4 handoff: one new fact is added and the rest is kept word for word",
    about: "person",
    current: NURSE,
    evidence: [
      "by the way, I started learning the guitar last month, it's my new thing",
      "turn the kitchen lights off",
    ],
    keep: NURSE.split("\n"),
    has: [/guitar/i],
  },
  {
    id: "supersede-contradicted",
    source: "G4 handoff: a contradicted fact is superseded, its cause and evidence named",
    about: "person",
    current: NURSE,
    evidence: [
      "I finally quit nursing! I start as a primary school teacher on Monday",
      "can you remind me to iron a shirt tonight",
    ],
    keep: ["- Lives in Leeds", "- Likes short answers"],
    has: [/teach/i],
    lacks: [/night shifts/i],
    replaces: { old: /nurs/i, new: /teach/i },
  },
  {
    id: "weak-hint",
    source: "G4 handoff: a weak hint changes nothing",
    about: "person",
    current: NURSE,
    evidence: [
      "I've been thinking I might take up running at some point, not sure though",
      "ugh, this rain is getting me down",
    ],
    unchanged: true,
  },
  {
    id: "unfair-basis",
    source: "G4 handoff, MA-021 FAIR: never rests on accent, language or origin",
    about: "person",
    current: null,
    evidence: [
      "Hello, I am new in this house, from Lagos. My English is not so good, sorry.",
      "Can you tell me tomorrow's weather please?",
      "I work as an accountant in the city",
    ],
    has: [/accountant/i],
    lacks: [UNFAIR],
  },
  {
    id: "self-from-corrections",
    source: "G4 handoff: her self-understanding is updated from her own corrections",
    about: "self",
    current: "- Explains each step in full detail\n- Speaks formally",
    evidence: [
      "stop reading out every single step, just tell me when it's done",
      "and you don't need to be so formal with me, relax",
    ],
    has: [/brief|short|concise|done|result|summar|outcome/i, /casual|relax|informal|less formal/i],
    lacks: [/explains each step in full detail/i, /^- speaks formally$/im],
  },
  {
    id: "control-first-facts",
    source: "Control: a first meeting with plain facts starts an understanding",
    about: "person",
    current: null,
    evidence: [
      "I'm Sam, I've got two kids and I coach their football team on Saturdays",
      "what time is it?",
    ],
    has: [/kids|children/i, /football/i],
  },
];
