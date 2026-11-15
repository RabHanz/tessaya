/**
 * The second check before a wake: the audio just before the wake model fired is recognised as speech,
 * and the wake word must be in what was heard. The model alone fires on TV, music and look-alike words;
 * the recogniser rarely hears "Sebastian" in those. Recognition spells a name in many ways, so the
 * match is by sound-alike spelling, not exact text.
 */

/**
 * The one list of how recognition mis-writes each name (lower case), for the wake check, the room, dictation and the
 * server's dictionary. `heard`: spellings nothing else has. `lead`: only as a sentence's first word ("…take the seat"
 * is close to "teseat"). `addressed`: names of their own ("Tessa"), the wake word only when spoken to.
 */
export const NAME_SOUNDALIKES: Readonly<
  Record<
    string,
    {
      readonly heard: ReadonlyArray<string>;
      readonly lead?: ReadonlyArray<string>;
      readonly addressed?: ReadonlyArray<string>;
    }
  >
> = {
  tessaya: {
    // Not "Tessa", "Tessie" or "Theresa" here: other names, and near misses the wake model is trained against.
    // "Teseya", "Teseah": the R1's mic (13 Nov). "Tisia" to "Tes Saya": Parakeet on his Wispr clips (DICT-WISPR).
    heard: [
      "tessaia",
      "tesaya",
      "tessa ya",
      "tesseya",
      "teh sayuh",
      "teseya",
      "teseah",
      "tesseah",
      "tisia",
      "tessia",
      "tesia",
      "tessay",
      "tayya",
      "te saya",
      "tes saya",
    ],
    // 0.1.72 (Microsoft David): "Tessiot", "Tessayot", "Tessiah".
    lead: ["teseat", "teseot", "tessiot", "tessayot", "tessiah"],
    // "Seya", "Casea": across the room on the R1's one mic (12 Nov); "Casey" the same (13 Nov), a name of its own.
    addressed: ["tessa", "seya", "casea", "casey"],
  },
  sebastian: { heard: ["bastian", "sebastien", "sabastian", "sebastiane"] },
  alfred: { heard: ["alfrid", "alfread", "al fred"] },
  freya: { heard: ["fraya", "freia", "fria", "fray uh", "frayer", "freyer"] },
  onyx: { heard: ["onix", "onyks", "onicks"] },
};

const table = (pick: "heard" | "lead" | "addressed") =>
  Object.fromEntries(
    Object.entries(NAME_SOUNDALIKES).map(([name, forms]) => [name, forms[pick] ?? []]),
  ) as Readonly<Record<string, ReadonlyArray<string>>>;
const ALIASES = table("heard");

/** Recognition sometimes writes the name in Cyrillic or Greek ("Тесая"): read it in Latin letters (after NFD, so й is и). */
const LATIN: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",

  ж: "zh",
  з: "z",
  и: "i",

  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ы: "y",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "h",
  ψ: "ps",
  ω: "o",
};

const LEAD_SPELLINGS = table("lead");
const ADDRESSED_SPELLINGS = table("addressed");
const ASKING =
  /^(?:what|whats|who|where|when|why|how|please|tell|open|show|send|start|set|remind|play|turn|give|find|check|bring|type|explain|look|read|stop)$/;
/** "Tessa can you…", not "Tessa can't come": a modal counts only with "you" after it. */
const ASKING_WITH_YOU = /^(?:can|could|would|will)$/;

const letters = (text: string): string =>
  [...text.toLowerCase().normalize("NFD")]
    .map((c) => LATIN[c] ?? c)
    .join("")
    .replace(/[^a-z ]/g, "");

const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
};

const similar = (heard: string, word: string): number =>
  1 - editDistance(heard, word) / Math.max(heard.length, word.length, 1);

/**
 * How a word sounds, roughly: one letter per consonant sound and one "a" per run of vowels. Words are
 * keyed one at a time and joined, so "to say yeah", "tess a ya" and "the saya" all read as Tessaya
 * ("tasaya") while "to say a" and "Tessa" ("tasa") do not.
 */
const soundKey = (word: string): string =>
  word
    .replace(/th/g, "t")
    .replace(/ph/g, "f")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/d/g, "t")
    .replace(/h/g, "")
    .replace(/y(?![aeiou])/g, "a")
    .replace(/[aeiou]/g, "a");

const keyOf = (words: ReadonlyArray<string>): string =>
  words
    .map(soundKey)
    .join("")
    .replace(/(.)\1+/g, "$1");

/** A name split into words is trusted by sound only when it ends on its "-ya" ("to say yeah", "the saya"), never "you". */
const YA_ENDING = /y(?:a|ah|eah)$/;
/** "To say you." as the whole clip is how recognition writes his "Tessaya"; "They say you", "To see you" are not. */
const SAY_YOU = /^(?:to|tu|ta|tah) say you$/;

/**
 * The name said in one, two or three recognised words: "Tessaia", "al fred", "to say yeah". Not `close`:
 * only the name, its listed spellings, or a split ending on "-ya", for words that are not a wake clip.
 */
const matches = (
  words: ReadonlyArray<string>,
  target: string,
  close = true,
  /** The whole clip: then its "-ya" may be written "you" ("To say you."), never inside a sentence. */
  whole = false,
): boolean => {
  if (
    keyOf(words) === keyOf([target]) &&
    (words.length === 1
      ? close
      : YA_ENDING.test(words.at(-1)!) || (whole && SAY_YOU.test(words.join(" "))))
  )
    return true;
  // Spelling closeness only within two words: across three, "to say a" is a letter away from "tesaya".
  // Never a split ending on "you": "tessa you" is a letter or two from "tessaya" and is Tessa.
  if (words.length > 2 || (words.length === 2 && words[1] === "you")) return false;
  const piece = words.join("");
  return [target, ...(ALIASES[target] ?? [])].some((c) => {
    const flat = letters(c).replace(/ /g, "");
    return piece === flat || (close && similar(piece, flat) >= 0.72);
  });
};

const MAX_WORDS = 3;

/** A wake the model is at least this sure of may be heard in the forms below. */
const SURE_SCORE = 1.0;
/** His own name as the recogniser writes it at the start of a wake clip (G1, 0.1.73-74). */
const OWN_FORMS: Readonly<Record<string, RegExp>> = {
  tessaya: /^(?:to|tuh) (?:say|see her)(?: (?:here|yeah|ya|a|uh))?$/,
};

/**
 * True when the clip ends on `word` or a close spelling of it: the clip stops where the model fired, just
 * after the name, so a name earlier in it ("Tessa, you there?") is not this wake. Three words count only
 * as the whole clip, so "I was going to say yeah" is not "to say yeah".
 */
export const wakeWordHeard = (
  transcript: string,
  word: string,
  /** The wake model's score (output over threshold); his real wakes score 1.02-1.05. */
  score?: number,
): boolean => {
  const target = letters(word).replace(/ /g, "");
  if (target === "") return true;
  const spoken = letters(transcript).split(/\s+/).filter(Boolean);
  // How Parakeet writes his own "Tessaya" ("To say.", "To see her.", the clip he says is right: "To say here"):
  // only as the whole clip, nothing before and at most the name's tail after, and only with the model sure.
  if (
    score !== undefined &&
    score >= SURE_SCORE &&
    (OWN_FORMS[target]?.test(spoken.join(" ")) ?? false)
  )
    return true;
  return [1, 2, 3].some(
    (n) =>
      n <= spoken.length &&
      (n < MAX_WORDS || n === spoken.length) &&
      matches(spoken.slice(-n), target, true, n === spoken.length),
  );
};

/**
 * How many of the first words are one of the wake words said the way recognition wrote it ("To say
 * yeah, dictate" starts with Tessaya in three words); 0 when it does not start with one.
 */
export const wakeWordLead = (
  words: ReadonlyArray<string>,
  wakeWords: ReadonlyArray<string>,
): number => {
  const targets = wakeWords.map((w) => letters(w).replace(/ /g, "")).filter(Boolean);
  const heard = words.map((w) => letters(w).replace(/ /g, ""));
  if (targets.some((t) => (LEAD_SPELLINGS[t] ?? []).includes(heard[0] ?? ""))) return 1;
  if (
    targets.some((t) => (ADDRESSED_SPELLINGS[t] ?? []).includes(heard[0] ?? "")) &&
    (heard.length === 1 ||
      /,$/.test(words[0] ?? "") ||
      ASKING.test(heard[1] ?? "") ||
      (ASKING_WITH_YOU.test(heard[1] ?? "") && heard[2] === "you"))
  )
    return 1;
  for (let n = 1; n <= Math.min(MAX_WORDS, heard.length); n += 1) {
    const lead = heard.slice(0, n);
    if (lead.every(Boolean) && targets.some((t) => matches(lead, t, false))) return n;
  }
  return 0;
};

/**
 * The model's own output (score × the word's threshold) at its ceiling. His real "Tessaya" in the 0.1.61
 * logs scored 1.0518–1.0525 at threshold 0.95, an output of 0.9992–0.9999; a borderline fire sits near 1×.
 */
const TRUSTED_OUTPUT = 0.999;

/** The wake model is sure enough of `word` to need no second opinion. */
export const wakeTrusted = (
  words: ReadonlyArray<{ readonly word: string; readonly threshold: number }>,
  word: string,
  score: number,
): boolean => {
  const setting = words.find((w) => w.word.toLowerCase() === word.toLowerCase());
  return setting !== undefined && score * setting.threshold >= TRUSTED_OUTPUT;
};

/** "Get me", "talk to", "switch back to", "hey": the words after one are who he is calling, on every vessel. */
export const CALL_SLOT =
  /\b(?:switch(?: me)?(?: back| over)? to|hand (?:me |it )?(?:over |back )?to|pass me (?:over |back )?to|put me (?:through |back )?(?:to|on to|onto)|(?:get|give|bring) me(?: back)?|(?:talk|speak) to|connect me (?:to|with)|hey|okay|ok)\s+/giu;

const NOT_A_NAME = new Set([
  "me",
  "you",
  "us",
  "him",
  "her",
  "them",
  "it",
  "a",
  "an",
  "the",
  "my",
  "this",
  "that",
]);

/**
 * The persona he asked for in the words after "get me" or "switch to", and how many words it took. There a name is
 * all he can mean, so a sound-alike start of one name counts: "to say a" or "T" for Tessaya (15 Nov, four tries).
 * A start must hold four sound-letters, or be all he said, and fit only one name.
 */
export const nameAskedFor = (
  after: string,
  names: ReadonlyArray<string>,
): { readonly name: string; readonly words: number } | null => {
  const spoken = letters(after).split(/\s+/).filter(Boolean);
  for (let n = Math.min(MAX_WORDS, spoken.length); n >= 1; n -= 1) {
    const head = spoken.slice(0, n);
    const exact = names.find((name) => matches(head, letters(name).replace(/ /g, ""), n === 1));
    if (exact !== undefined) return { name: exact, words: n };
    const key = keyOf(head);
    if ((key.length < 4 && n !== spoken.length) || NOT_A_NAME.has(head[0]!)) continue;
    const starts = names.filter((name) => keyOf([letters(name).replace(/ /g, "")]).startsWith(key));
    if (starts.length === 1) return { name: starts[0]!, words: n };
    // Or a close spelling of the whole name: "Alfie" for Alfred.
    const heard = head.join("");
    const near = names.filter((name) => {
      const target = letters(name).replace(/ /g, "");
      return (
        heard[0] === target[0] &&
        heard.length >= target.length - 2 &&
        editDistance(heard, target) <= Math.floor(target.length / 3)
      );
    });
    if (near.length === 1) return { name: near[0]!, words: n };
  }
  return null;
};
