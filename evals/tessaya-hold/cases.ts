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
}

/** Claims the act is under way or done, before its outcome is known. */
const CLAIMS =
  /\b(?:bumping|setting|turning|switching|moving|changing|sending|raising|lowering)\b[^.]*\b(?:now|up|down|on|off|over)\b|\b(?:it'?s|that'?s) (?:on|off|set|done)\b/i;

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
];

/** Why one line fails its case, or null. */
export const gradeBridge = (c: HoldCase, kept: string | null): string | null =>
  kept === null
    ? "refused by the gate"
    : !c.about.test(kept)
      ? "not about his words"
      : CLAIMS.test(kept)
        ? "claims the act"
        : null;
