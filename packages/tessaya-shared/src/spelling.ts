/**
 * Names spelled out loud, as a recogniser writes them ("z a y d", "Z-A-Y-D", "R. A. B.", "zed ay why dee", "double u"):
 * the letters assembled into the word, so a unique name is kept the way its owner spells it. Shared by the server's
 * memory and preference tools and desktop dictation.
 * @module tessaya-shared/spelling
 */

/** Letter names as they are said and heard. */
const LETTER_NAMES: Readonly<Record<string, string>> = {
  ay: "a",
  aye: "a",
  eh: "a",
  bee: "b",
  be: "b",
  cee: "c",
  see: "c",
  sea: "c",
  dee: "d",
  ee: "e",
  ef: "f",
  eff: "f",
  gee: "g",
  aitch: "h",
  haitch: "h",
  eye: "i",
  jay: "j",
  kay: "k",
  el: "l",
  ell: "l",
  em: "m",
  en: "n",
  oh: "o",
  pee: "p",
  pea: "p",
  cue: "q",
  queue: "q",
  kew: "q",
  ar: "r",
  are: "r",
  ess: "s",
  tee: "t",
  tea: "t",
  you: "u",
  vee: "v",
  ex: "x",
  why: "y",
  wye: "y",
  zed: "z",
  zee: "z",
};

/** Letter names that are not also everyday words ("why", "you", "see" are): one of these marks a run as spelling. */
const NAME_ONLY = new Set([
  "ay",
  "bee",
  "cee",
  "dee",
  "ee",
  "ef",
  "eff",
  "gee",
  "aitch",
  "haitch",
  "jay",
  "kay",
  "el",
  "ell",
  "em",
  "en",
  "ess",
  "vee",
  "wye",
  "zed",
  "zee",
  "ar",
  "kew",
]);

/** One token's letters: a single letter, a letter's name, or nothing. "double u" is handled by the scanner. */
const letterOf = (token: string): string | null => {
  const t = token.toLowerCase();
  if (/^[a-z]$/.test(t)) return t;
  return LETTER_NAMES[t] ?? null;
};

/** Words in order with where each starts and ends, splitting on spaces, hyphens, dots and commas between letters. */
const tokensOf = (text: string) =>
  [...text.matchAll(/[A-Za-z]+/g)].map((m) => ({
    word: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));

export interface SpelledRun {
  /** The assembled word, first letter capitalised ("Zayd"). */
  readonly word: string;
  /** Where the spelled letters start and end in the text. */
  readonly start: number;
  readonly end: number;
}

/**
 * Every run of three or more spelled letters in the text ("Z-A-Y-D", "r. a. b.", "zed ay why dee", "double u"). Two
 * letters are too often ordinary words ("a", "I", "you") to count. A run's separators must be spaces, hyphens, dots
 * or commas.
 */
export const spelledRuns = (text: string): ReadonlyArray<SpelledRun> => {
  const tokens = tokensOf(text);
  const runs: Array<SpelledRun> = [];
  let i = 0;
  while (i < tokens.length) {
    let letters = "";
    let j = i;
    let last = i;
    while (j < tokens.length) {
      if (j > i && !/^[\s.,-]*$/.test(text.slice(tokens[j - 1]!.end, tokens[j]!.start))) break;
      const word = tokens[j]!.word.toLowerCase();
      if (word === "double" && j + 1 < tokens.length) {
        const next = tokens[j + 1]!.word.toLowerCase();
        const doubled = next === "u" || next === "you" ? "w" : null;
        const letter = doubled ?? letterOf(next);
        if (letter !== null) {
          letters += doubled ?? letter + letter;
          last = j + 1;
          j += 2;
          continue;
        }
      }
      const letter = letterOf(word);
      if (letter === null) break;
      letters += letter;
      last = j;
      j++;
    }
    // A letter name alone ("see", "you") is a word; only a run of real spelling counts.
    const run = tokens.slice(i, last + 1);
    const spelled =
      run.length >= 3 &&
      letters.length >= 3 &&
      run.some((t) => t.word.length === 1 || NAME_ONLY.has(t.word.toLowerCase()));
    if (spelled) {
      runs.push({
        word: letters[0]!.toUpperCase() + letters.slice(1),
        start: run[0]!.start,
        end: run.at(-1)!.end + (text[run.at(-1)!.end] === "." ? 1 : 0),
      });
      i = last + 1;
    } else i++;
  }
  return runs;
};

/** "Zayd" as she spells it back: "Z-A-Y-D". */
export const spellOut = (word: string): string => word.toUpperCase().split("").join("-");

/** She spells each name back once: " Zayd, Z-A-Y-D." (empty when nothing was spelled). */
export const spellBack = (names: ReadonlyArray<{ readonly word: string }>): string =>
  names.map((n) => ` ${n.word}, ${spellOut(n.word)}.`).join("");

export interface Spelled {
  /** The text with each spelling folded into its word: "my dentist is Dr Qadri". */
  readonly text: string;
  /** Each name spelled out, with how it was heard said just before it, when it was ("Zaid" for "Zayd"). */
  readonly names: ReadonlyArray<{ readonly word: string; readonly heardAs: string | null }>;
}

/**
 * Folds spelled-out names into the text. A spelling right after the word it spells ("Zayd, Z-A-Y-D") replaces that
 * word, and the word as heard is kept as how it sounds when it was written differently ("Zaid"). A spelling alone ("R.
 * A. B.") becomes the word.
 */
export const foldSpelling = (text: string): Spelled => {
  const runs = spelledRuns(text);
  if (runs.length === 0) return { text, names: [] };
  let out = "";
  let at = 0;
  const names: Array<{ word: string; heardAs: string | null }> = [];
  for (const run of runs) {
    const before = text.slice(at, run.start);
    // The word just before, with the comma or "spelled" between them: "Zaid, spelled", "Qadri -".
    const lead = /([A-Za-z]+)(?:[\s,.:;-]+(?:spelled|spelt|that'?s)?[\s,.:;-]*)$/i.exec(before);
    const said = lead?.[1] ?? null;
    const near =
      said !== null && said[0]!.toLowerCase() === run.word[0]!.toLowerCase() && said.length >= 2;
    if (near) {
      out += before.slice(0, lead!.index) + run.word;
      names.push({
        word: run.word,
        heardAs: said.toLowerCase() === run.word.toLowerCase() ? null : said,
      });
    } else {
      out += before + run.word;
      names.push({ word: run.word, heardAs: null });
    }
    at = run.end;
  }
  out += text.slice(at);
  return {
    text: out
      .replace(/\s+([,.])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim(),
    names,
  };
};
