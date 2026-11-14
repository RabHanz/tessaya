/**
 * Makes dictated text fit the words already around the caret: the space after a sentence, no
 * double space, a capital after . ! ?, a lowercase continuation after a comma or mid-sentence.
 * Pure: the caller reads `before` and `after` from the app (UI Automation) or, where the app does
 * not expose them, from what Baton last inserted there.
 */

/** What sits around the caret. `after` may be empty; both empty means an empty field. */
export interface CaretContext {
  readonly before: string;
  readonly after: string;
}

const ABBREVIATIONS = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|no|approx)\.$/i;
/** Days and months keep their capital anywhere; "May" is far more often the verb mid-sentence. */
import { FIRST_NAMES } from "./vocabulary.ts";

const CALENDAR =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)$/i;

const firstWord = (text: string): string => /^[\p{L}][\p{L}'’]*/u.exec(text)?.[0] ?? "";

const startsWithI = (word: string): boolean => /^I(?:['’](?:m|ll|ve|d))?$/.test(word);

const isAcronym = (word: string): boolean => word.length > 1 && word === word.toUpperCase();

const capitalised = (text: string): string =>
  text.replace(/^(\P{L}*)(\p{L})/u, (_, p, c) => p + c.toUpperCase());

const startsWithName = (text: string, names: ReadonlyArray<string>): boolean => {
  const words = text.replace(/^\P{L}*/u, "");
  return names.some(
    (name) =>
      name !== "" &&
      words.slice(0, name.length).toLowerCase() === name.toLowerCase() &&
      !/[\p{L}\p{N}]/u.test(words[name.length] ?? ""),
  );
};

/** Mid-sentence, the capital the model gave its first word goes, unless the word is a name, "I" or an acronym. */
const lowered = (text: string, names: ReadonlyArray<string>): string => {
  const word = firstWord(text.replace(/^\P{L}*/u, ""));
  if (word === "" || startsWithI(word) || isAcronym(word) || /\p{Lu}/u.test(word.slice(1)))
    return text;
  if (CALENDAR.test(word) || FIRST_NAMES.has(word.toLowerCase()) || startsWithName(text, names))
    return text;
  return text.replace(/^(\P{L}*)(\p{L})/u, (_, p, c) => p + c.toLowerCase());
};

type Edge =
  | "start" // empty field, or a new line
  | "sentence" // after . ! ? (and any closing quote or bracket)
  | "clause" // after , ; :
  | "open" // after ( [ { " or a dash: the words hug it
  | "word" // after a letter or digit: mid-sentence
  | "after"; // after any other mark: a space, and his capitals kept

/** What editors put in a field that is not text: zero-width marks, a placeholder's object character, a BOM. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\ufffc]/g;

const edgeBefore = (raw: string): { readonly edge: Edge; readonly spaced: boolean } => {
  const before = raw.replace(INVISIBLE, "").replace(/\u00a0/g, " ");
  if (before.trim().length === 0) return { edge: "start", spaced: true };
  if (/[\r\n]\s*$/.test(before)) return { edge: "start", spaced: true };
  const spaced = /[ \t]$/.test(before);
  const trimmed = before.replace(/[ \t]+$/, "");
  const stripped = trimmed.replace(/["'”’)\]}]+$/, "");
  const last = stripped.at(-1) ?? "";
  if (/[.!?…]/.test(last) && !ABBREVIATIONS.test(stripped)) return { edge: "sentence", spaced };
  if (/[,;:]/.test(trimmed.at(-1) ?? "")) return { edge: "clause", spaced };
  if (/[([{"“‘\-–—/]/.test(trimmed.at(-1) ?? "")) return { edge: "open", spaced };
  // Mid-sentence only after a letter or digit; any other mark leaves his capitals as they are.
  return { edge: /[\p{L}\p{N}]$/u.test(trimmed) ? "word" : "after", spaced };
};

/** `names`: his words and names, which keep their capitals mid-sentence. */
export const fitInsertion = (
  context: CaretContext,
  inserted: string,
  names: ReadonlyArray<string> = [],
): string => {
  const words = inserted.trim();
  if (words.length === 0) return inserted;
  const { edge, spaced } = edgeBefore(context.before);
  const hugsPunctuation = /^[,.;:!?)\]}%]/.test(words);
  let text = words;
  let lead = "";
  switch (edge) {
    case "start":
      text = capitalised(text);
      break;
    case "sentence":
      text = capitalised(text);
      lead = spaced ? "" : " ";
      break;
    case "clause":
      text = lowered(text, names);
      lead = spaced ? "" : " ";
      break;
    case "open":
      break;
    case "after":
      lead = spaced ? "" : " ";
      break;
    case "word":
      if (hugsPunctuation) {
        if (spaced) text = ` ${text}`.trimStart();
        break;
      }
      text = lowered(text, names);
      lead = spaced ? "" : " ";
      break;
  }
  // Text after the caret that carries on the sentence (lower case, or its own punctuation) takes the model's stop off.
  if (
    /^[ \t]*(?:\p{Ll}|[,;:.!?])/u.test(context.after.replace(INVISIBLE, "")) &&
    /[^.]\.$/.test(text) &&
    !ABBREVIATIONS.test(text)
  )
    text = text.slice(0, -1);
  // Mid-text: keep a space between the insertion and the word that follows it.
  const next = context.after[0] ?? "";
  const trail = next !== "" && /[\p{L}\p{N}"“([{]/u.test(next) ? " " : "";
  return `${lead}${text}${trail}`;
};

/**
 * With the words around the caret unknown (the app did not say in time), the insertion ends with a space, so text
 * already after the caret never runs into it ("…name here.Hello World", 0.1.75; "…name hereHello World", 0.1.77).
 */
export const fitWithoutContext = (inserted: string): string =>
  /\s$/.test(inserted) || !/\S\s+\S/.test(inserted) ? inserted : `${inserted} `;

/**
 * A dictation of sentences whose last one the recogniser left open (it punctuates on the pause after it, which the end
 * of a dictation does not always give it) gets its full stop. A single phrase, or one ending on a comma, is left alone.
 */
export const closeLastSentence = (
  text: string,
  /** What follows the caret, or null when the app did not say: the stop is added only where the dictation ends. */
  after: string | null,
): string => {
  const trimmed = text.trimEnd();
  const last = trimmed.split(/\s+/).at(-1) ?? "";
  const ends = after === null || after === "" || /^\r?\n/.test(after) || /^\s*\p{Lu}/u.test(after);
  return ends &&
    /[.!?…]\s+\S/.test(trimmed) &&
    /[\p{L}\p{N}]$/u.test(trimmed) &&
    // A link, path, address or code: a stop would read as part of it.
    !/[/\\@_`]|\.\w|\(\)/.test(last)
    ? `${trimmed}.${text.slice(trimmed.length)}`
    : text;
};

/** What Baton last inserted, as the fallback when an app does not expose its text. */
export const contextFromLastInsert = (
  last: { readonly text: string; readonly at: number; readonly sameWindow: boolean } | null,
  now: number,
  maxAgeMs = 120_000,
): CaretContext | null =>
  last !== null && last.sameWindow && now - last.at <= maxAgeMs
    ? { before: last.text, after: "" }
    : null;
