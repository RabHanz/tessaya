/**
 * A room turn's words fixed from what was being talked about, only when a known mishear fires (19 Nov, Tumble replay:
 * WER 31.7% → 27.3% on his misheard turns with no wrong change, against 24.4% and two wrong changes cleaning every
 * turn). Clear turns never wait for it. Measured with tessaya-ops/tumble-replay/asr-gate.mjs.
 */
import { nearNames } from "./vocabulary.ts";

/** A verb that needs someone to send to, with none ("send me something fun" was "tell me", 18 Nov 23:31). */
const NO_RECIPIENT =
  /\b(?:send|bring|give)\s+me\s+(?:something|a\s+(?:joke|fact|story))\b(?![^.?!]*\bto\b)/i;

/** Whether these words look misheard: a run sounding like one of his names but not it, or a recipient-less verb. */
export const cleanupFires = (text: string, names: ReadonlyArray<string>): boolean =>
  NO_RECIPIENT.test(text) ||
  nearNames(
    text,
    names.filter((n) => /^[\p{L}\p{N} ]+$/u.test(n) && n.length >= 5 && n.length <= 20),
  ).length > 0;

export const CONTEXT_CLEANUP_SYSTEM = `You fix speech-recognition mistakes in what he just said to Tessaya, his voice assistant.
Return only the words he meant, nothing else.
- Where a word or run of words makes no sense where it is and a sound-alike does (one of his names or words, or a plain English word), write that: "the jura board" is "the Jira board", "run it on Kegle" is "run it on Kaggle".
- A verb that needs someone or something it does not have, where a sound-alike verb fits, is that verb ("bring me what the weather is" is "tell me what the weather is").
- Words that make sense as written stay exactly as they are. Never add, explain, finish a cut-off sentence or answer him.
- If you cannot tell what he meant, return his words unchanged.`;

export const contextCleanupMessage = (
  heard: string,
  before: ReadonlyArray<{ readonly role: string; readonly content: string }>,
  names: ReadonlyArray<string>,
): string =>
  [
    `His names and words: ${names.join(", ")}.`,
    before.length === 0
      ? "No conversation before this."
      : `The conversation just before:\n${before
          .slice(-4)
          .map((m) => `${m.role === "user" ? "He" : "She"}: ${m.content.slice(0, 200)}`)
          .join("\n")}`,
    `What he said, as recognised: ${heard}`,
  ].join("\n\n");

/** The fixed words, or null when the answer is not a plausible fix of them (empty, many lines, or far longer/shorter). */
export const keptCleanup = (heard: string, answer: string): string | null => {
  const out = answer.trim().replace(/^"(.*)"$/s, "$1");
  if (out === "" || out.includes("\n")) return null;
  const count = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const [a, b] = [count(heard), count(out)];
  return b < a / 2 || b > a * 1.5 + 2 ? null : out;
};
