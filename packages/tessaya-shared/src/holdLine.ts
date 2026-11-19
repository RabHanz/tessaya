/**
 * Her hold line's prompt and gate (B-056): one short line about what he just said, while a slow answer comes. The server
 * writes it with a warm Haiku (apps/server/src/home/R1Hold.ts); evals/tessaya-hold grades this same text.
 */
export const BRIDGE_SYSTEM = [
  "You write one short spoken line for a voice assistant to say while her real answer is still coming.",
  "It is about what he just said: name his topic in her own words, the way a person thinking aloud would.",
  'Examples of the shape (never reuse them): "Ooh, the thermostat, let me see what it\'s up to." "Right, the checkout bug from last night."',
  "Rules: 3 to 12 words, one sentence, spoken English, no lists or markdown. Never say your own name.",
  'Speak to him ("you", "your"), never about him ("he", "his").',
  "Never answer the question, never guess the answer, never promise or claim progress (no done, almost, nearly, soon, got it).",
  'Never say the act is happening or will happen ("bumping it up", "setting it now", "it is", "moving up"): the act may fail. For a change he asks for, talk about what he asked for, not about doing it.',
  'Make it about his exact words, not generic ("checking that for you", "looking into it" are generic).',
  'Never a stock filler on its own ("one moment", "just a second", "hold on", "let me check", "good question", "hmm").',
  "Start it differently from her lines already said, never with the same first word.",
  'Never restate or quote what he asked ("so you\'re asking…", "you want…", his words in quotes). Never "let me think about how it feels".',
  "If his words are unclear, a fragment, small talk, a greeting or a goodbye, reply NONE: silence is better there.",
  "Reply with the line only.",
].join("\n");

/** The prompt for one turn: who she is, the talk just before, and his words. */
export const bridgePrompt = (input: {
  readonly persona?: string | undefined;
  readonly words: string;
  readonly before: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly recent: ReadonlyArray<string>;
}) =>
  [
    `You are ${input.persona ?? "Tessaya"}.`,
    ...(input.before.length === 0
      ? []
      : [
          `The talk just before: ${input.before
            .map((m) => `${m.role === "user" ? "He" : "She"}: ${m.content.slice(0, 200)}`)
            .join(" / ")}`,
        ]),
    ...(input.recent.length === 0
      ? []
      : [
          `Lines she already said; write a different one: ${input.recent.slice(-8).join(" | ")}`,
          `Do not start with: ${[...new Set(input.recent.slice(-3).map(firstWord))].join(", ")}.`,
        ]),
    `He just said: ${input.words.slice(0, 400)}`,
  ].join("\n");

const STOCK =
  /^(?:one moment|just a (?:moment|second|sec)|hold on|one sec(?:ond)?|let me (?:check|see|look|think)|good question|hmm+|okay|ok|right|sure|checking)[.!…]*$/i;
const PROMISES =
  /\b(?:almost|nearly|coming|soon|shortly|promise|done|sorted|ready|got it|have it|right up|getting (?:there|that))\b/i;
/** Telling him the act is under way ("routing the audio over to your headphones now"): it may yet fail. */
const UNDER_WAY =
  /\b(?:sending|switching|routing|moving|turning|setting|bumping|nudging|bringing|changing|putting|raising|lowering|starting)\b[^.]*\b(?:now|over|through|on|off|up|down|to (?:your|the|it))\b/i;
/** Restating or quoting him, or musing on a feeling ("Ah, \"can you,\" so you're asking whether…" in the replay). */
const ECHO =
  /["“”]|\bso you(?:'re| are) (?:asking|saying|wanting)|\byou(?:'re| are) asking\b|\b(?:so )?you want\b|\bhow it feels\b/i;
/**
 * A remark on his question or on the talk so far instead of his topic, which then sits in front of her answer (19 Nov
 * replay: "Ah, the headphones again, still tangled with the speaker question.", "so that's who we're talking about").
 * "still" and "again" also claim a state she has not read yet.
 */
const PREAMBLE =
  /\bso (?:that'?s|this is) (?:who|what)\b|\byou(?:'re| are) (?:after|checking|looking|wondering|saying|wanting)\b|\bthat'?s a good (?:thing|one|question)\b|\bagain\b|\bstill\b/i;
/** A stock filler inside a line ("…your second screen on the laptop, one moment."). */
const STOCK_INSIDE =
  /\b(?:one moment|just a (?:moment|sec(?:ond)?)|hold on|one sec(?:ond)?|bear with me|good question)\b/i;
const firstWord = (l: string) => norm(l).split(" ")[0];
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

/**
 * The line as she may say it, or null: one sentence of 3-14 words, not stock, no promise or act under way, not her own
 * name, not one said lately.
 */
export const keptBridge = (
  text: string,
  recent: ReadonlyArray<string>,
  persona?: string,
): string | null => {
  const line = text
    .trim()
    .replace(/^["']|["']$/g, "")
    .split("\n")[0]!
    .trim();
  if (/^none\.?$/i.test(line) || ECHO.test(line) || PREAMBLE.test(line)) return null;
  const words = line.split(/\s+/).filter(Boolean).length;
  if (
    words < 3 ||
    words > 14 ||
    STOCK.test(line) ||
    STOCK_INSIDE.test(line) ||
    PROMISES.test(line) ||
    UNDER_WAY.test(line)
  )
    return null;
  if (persona !== undefined && line.toLowerCase().includes(persona.toLowerCase())) return null;
  // Spoken to him, never about him ("his laptop's second screen" in the eval).
  if (/\b(?:he|his|him|he's)\b/i.test(line)) return null;
  if (recent.some((r) => norm(r) === norm(line))) return null;
  // Fresh each time: not the opening word of her last one ("Ooh," on line after line in the replay).
  if (recent.length > 0 && firstWord(recent.at(-1)!) === firstWord(line)) return null;
  return line;
};
