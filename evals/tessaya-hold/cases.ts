/**
 * His kind of sentence before a slow answer, from the Tumble replay of 15-18 Nov (made-up details), and what her hold
 * line must be about. Before B-056 every one of these got "One moment.".
 */
export interface HoldCase {
  readonly id: string;
  readonly source: string;
  readonly words: string;
  readonly before: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly persona?: string;
  /** The line must name his topic: one of these. */
  readonly about: RegExp;
  /** A control: small talk or a fragment, where she says nothing. */
  readonly silent?: boolean;
}

/** Claims the act is under way or done, before its outcome is known. */
const CLAIMS =
  /\b(?:bumping|setting|turning|switching|moving|changing|sending|raising|lowering)\b[^.]*\b(?:now|up|down|on|off|over)\b|\b(?:it'?s|that'?s) (?:on|off|set|done)\b/i;

/** A preamble before the answer: restating him, a remark on his question, or on the talk so far ("…again", "still"). */
const PREAMBLE =
  /\bso (?:that'?s|this is) (?:who|what)\b|\byou(?:'re| are) (?:after|checking|looking|wondering|asking|wanting)\b|\bthat'?s a good (?:thing|one|question)\b|\bagain\b|\bstill\b/i;

export const cases: ReadonlyArray<HoldCase> = [
  {
    id: "volume-set",
    source: "18 Nov 23:07: 'Can you set it to about forty percent?' heard 'One moment.'",
    words: "Can you set it to about forty percent?",
    before: [
      { role: "user", content: "What percentage is the volume currently?" },
      { role: "assistant", content: "Thirty percent." },
    ],
    about: /volume|forty|40|loud|percent/i,
  },
  {
    id: "mic-quality",
    source: "18 Nov 23:24: 'How good is the mic quality right now?'",
    words: "How good is the mic quality right now?",
    before: [],
    about: /mic|sound|hear|audio|voice/i,
  },
  {
    id: "laptop-screen",
    source: "15 Nov 04:30: 'Could you tell me what's on my second screen on the laptop?'",
    words: "Could you tell me what's on my second screen on the laptop?",
    before: [],
    about: /screen|laptop|display|monitor/i,
  },
  {
    id: "headphones",
    source: "17 Nov 19:38: 'Use my headphones.'",
    words: "Use my headphones.",
    before: [
      { role: "user", content: "Are you connected to the headphones?" },
      { role: "assistant", content: "Bluetooth shows them connected, but I'm on my own speaker." },
    ],
    about: /headphone|bluetooth|ears|speaker/i,
  },
  {
    id: "status",
    source: "18 Nov 21:11: 'What's the status?' heard only 'One moment'",
    words: "What's the status of everything?",
    before: [],
    about: /status|everything|going on|state|how things|picture|lay of the land|round.?up/i,
  },
  {
    id: "persona",
    source: "Alfred answers a slow one in his own manner",
    words: "Alfred, what did I leave running on acme app?",
    before: [],
    persona: "Alfred",
    about: /acme|running|left|app/i,
  },
  {
    id: "plugged-in",
    source:
      "16 Nov 02:31: 'Can you detect if it is plugged in?' got 'Checking whether …, that's a good thing to know.'",
    words: "Can you detect if it is plugged in or not?",
    before: [],
    about: /plug|charg|power|cable|battery/i,
  },
  {
    id: "voice-list",
    source:
      "17 Nov 19:20: a list of voices got 'Ah, the voice list you're after, so you're checking …'",
    words: "Do you have any lists of voices that you have currently?",
    before: [],
    about: /voice/i,
  },
  {
    id: "headphones-again",
    source:
      "16 Nov 02:29: back on the speaker got 'Ah, the headphones again, still tangled with the speaker question.'",
    words: "You are still on the speaker, not the headphones.",
    before: [
      { role: "user", content: "Use my headphones." },
      { role: "assistant", content: "Switching to your headphones needs your yes on your phone." },
    ],
    about: /headphone|speaker|bluetooth|ears/i,
  },
  {
    id: "intro-control",
    source:
      "17 Nov 03:58: 'Sam is my cousin.' got 'Sam, your cousin, so that's who we're talking about.'",
    words: "Sam is my cousin.",
    before: [],
    about: /$^/,
    silent: true,
  },
  {
    id: "hello-control",
    source:
      "15 Nov 03:19: 'Hello.' (a bridge restated it: 'Ah, a simple hello, so you're just saying hi.')",
    words: "Hello.",
    before: [],
    about: /$^/,
    silent: true,
  },
  {
    id: "garbled-control",
    source: "17 Nov 19:17: 'Can you?' (a bridge parroted it: 'Ah, can you, so you're asking...')",
    words: "Can you?",
    before: [],
    about: /$^/,
    silent: true,
  },
];

/** Why one line fails its case, or null. */
export const gradeBridge = (c: HoldCase, kept: string | null): string | null =>
  c.silent === true
    ? kept === null
      ? null
      : "spoke where silence was better"
    : kept === null
      ? "refused by the gate"
      : !c.about.test(kept)
        ? "not about his words"
        : CLAIMS.test(kept)
          ? "claims the act"
          : PREAMBLE.test(kept)
            ? "a preamble, not his topic"
            : null;
