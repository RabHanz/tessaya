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
/** Words that start a sentence or continue one in lower case; names and nouns are never touched. */
const FUNCTION_WORDS = new Set(
  (
    "a an the and but or so nor yet if then than that this these those which who whom whose what " +
    "when where while because although though since unless until as of in on at to for from by with " +
    "about into over after before between through during without within we you he she it they my " +
    "your his her its our their me him us them is are was were be been am do does did have has had " +
    "will would can could should may might must not no yes please thanks thank also just really " +
    "very maybe actually basically however therefore anyway okay ok"
  ).split(" "),
);

const firstWord = (text: string): string => /^[\p{L}][\p{L}'’]*/u.exec(text)?.[0] ?? "";

const startsWithI = (word: string): boolean => /^I(?:['’](?:m|ll|ve|d))?$/.test(word);

const isAcronym = (word: string): boolean => word.length > 1 && word === word.toUpperCase();

const capitalised = (text: string): string =>
  text.replace(/^(\P{L}*)(\p{L})/u, (_, p, c) => p + c.toUpperCase());

const lowered = (text: string): string => {
  const word = firstWord(text);
  if (word === "" || startsWithI(word) || isAcronym(word)) return text;
  if (!FUNCTION_WORDS.has(word.toLowerCase())) return text;
  return text.replace(/^(\P{L}*)(\p{L})/u, (_, p, c) => p + c.toLowerCase());
};

type Edge =
  | "start" // empty field, or a new line
  | "sentence" // after . ! ? (and any closing quote or bracket)
  | "clause" // after , ; :
  | "open" // after ( [ { " or a dash: the words hug it
  | "word"; // after a letter, digit, or other closing mark

const edgeBefore = (before: string): { readonly edge: Edge; readonly spaced: boolean } => {
  if (before.trim().length === 0) return { edge: "start", spaced: true };
  if (/\n\s*$/.test(before)) return { edge: "start", spaced: true };
  const spaced = /[ \t]$/.test(before);
  const trimmed = before.replace(/[ \t]+$/, "");
  const stripped = trimmed.replace(/["'”’)\]}]+$/, "");
  const last = stripped.at(-1) ?? "";
  if (/[.!?…]/.test(last) && !ABBREVIATIONS.test(stripped)) return { edge: "sentence", spaced };
  if (/[,;:]/.test(trimmed.at(-1) ?? "")) return { edge: "clause", spaced };
  if (/[([{"“‘\-–—/]/.test(trimmed.at(-1) ?? "")) return { edge: "open", spaced };
  return { edge: "word", spaced };
};

export const fitInsertion = (context: CaretContext, inserted: string): string => {
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
      text = lowered(text);
      lead = spaced ? "" : " ";
      break;
    case "open":
      break;
    case "word":
      if (hugsPunctuation) {
        if (spaced) text = ` ${text}`.trimStart();
        break;
      }
      text = lowered(text);
      lead = spaced ? "" : " ";
      break;
  }
  // Mid-text: keep a space between the insertion and the word that follows it.
  const next = context.after[0] ?? "";
  const trail = next !== "" && /[\p{L}\p{N}"“([{]/u.test(next) ? " " : "";
  return `${lead}${text}${trail}`;
};

/**
 * With the words around the caret unknown (the app did not say in time), a finished sentence ends with a space, so
 * text already after the caret does not run into it ("…name here.Hello World", 0.1.75).
 */
export const fitWithoutContext = (inserted: string): string =>
  /[.!?…]["'”’)\]]*$/.test(inserted) ? `${inserted} ` : inserted;

/** What Baton last inserted, as the fallback when an app does not expose its text. */
export const contextFromLastInsert = (
  last: { readonly text: string; readonly at: number; readonly sameWindow: boolean } | null,
  now: number,
  maxAgeMs = 120_000,
): CaretContext | null =>
  last !== null && last.sameWindow && now - last.at <= maxAgeMs
    ? { before: last.text, after: "" }
    : null;
