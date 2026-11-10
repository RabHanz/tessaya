/**
 * His personal vocabulary, `<state dir>/voice/dictionary.json`. One format for words he added, words
 * Baton learned from his corrections and wording, and the Wispr import. Old files (just `phrase`
 * and `replacement`) read as `added` with a count of 1. It never leaves his machine except inside
 * his own Claude clean-up call (the term list in the prompt).
 */

export type VocabularySource = "added" | "learned" | "wispr";

export interface VocabularyEntry {
  /** What is heard (or, with no replacement, the word spelt as he spells it). */
  readonly phrase: string;
  /** null keeps the phrase and only corrects its capitals and near-miss spellings. */
  readonly replacement: string | null;
  readonly source?: VocabularySource;
  /** Times it was added, corrected or seen. Learned words enter once this reaches the threshold. */
  readonly count?: number;
  /** ISO time it was last added, corrected or seen. */
  readonly lastSeen?: string;
  /** How the recogniser has written this word, as Wispr's `observedSource`: hints for the clean-up, not a find-and-replace. */
  readonly heard?: ReadonlyArray<string>;
}

/** A learned word needs this many sightings (corrections, or distinct turns) to enter. */
export const LEARN_THRESHOLD = 3;
export const CORRECTION_THRESHOLD = 2;
/** The clean-up prompt lists at most this many, the most used first. */
export const PROMPT_TERMS = 200;

const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Distinct forms, never the word itself; an absent list stays absent so old files read back unchanged. */
const withHeard = (phrase: string, value: unknown): { readonly heard?: ReadonlyArray<string> } => {
  if (!Array.isArray(value)) return {};
  const forms = [
    ...new Set(
      value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.replace(/\s+/g, " ").trim())
        .filter((v) => /\p{L}/u.test(v) && v.length <= 60 && !sameWord(v, phrase)),
    ),
  ];
  return forms.length > 0 ? { heard: forms } : {};
};

/** Takes one mis-heard form off the entry for `phrase`. */
export const removeHeard = (
  entries: ReadonlyArray<VocabularyEntry>,
  phrase: string,
  form: string,
): ReadonlyArray<VocabularyEntry> =>
  entries.map((e) => {
    if (!sameWord(e.phrase, phrase) || e.heard === undefined) return e;
    const { heard, ...rest } = e;
    return {
      ...rest,
      ...withHeard(
        e.phrase,
        heard.filter((h) => !sameWord(h, form)),
      ),
    };
  });

/** A file that is not a list is no vocabulary; an entry that is not text is skipped. */
export const parseVocabulary = (value: unknown): ReadonlyArray<VocabularyEntry> =>
  Array.isArray(value)
    ? value.flatMap((item): ReadonlyArray<VocabularyEntry> => {
        const entry = item as Partial<VocabularyEntry> | null;
        if (typeof entry !== "object" || entry === null || typeof entry.phrase !== "string")
          return [];
        if (entry.phrase.trim().length === 0) return [];
        return [
          {
            phrase: entry.phrase,
            replacement:
              typeof entry.replacement === "string" && entry.replacement.length > 0
                ? entry.replacement
                : null,
            source: entry.source === "learned" || entry.source === "wispr" ? entry.source : "added",
            count:
              typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count > 0
                ? Math.floor(entry.count)
                : 1,
            ...(typeof entry.lastSeen === "string" ? { lastSeen: entry.lastSeen } : {}),
            ...withHeard(entry.phrase, entry.heard),
          },
        ];
      })
    : [];

/** The words the clean-up prompt gets, her own names first, then most used, capped; each with how it is mis-heard. */
export const promptTerms = (entries: ReadonlyArray<VocabularyEntry>): ReadonlyArray<string> =>
  withOwnWords(entries)
    .map((entry, i) => ({ entry, rank: entry.count ?? Number.MAX_SAFE_INTEGER - i }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, PROMPT_TERMS)
    .map(({ entry }) => {
      const term = entry.replacement ?? entry.phrase;
      // An everyday-looking form ("button", "venture OS") as a hint makes the model swap every "button" and "venture";
      // those are put back in code, only where the name fits.
      // Nor an everyday word, however it is capitalised: "feelIt (heard as "It")" made the model write "part of
      // feelIt" (0.1.92).
      const heard = (entry.heard ?? [])
        .filter((h) => /^\p{Lu}/u.test(h) && !everydayForm(h))
        .map((h) => `"${h}"`)
        .join(", ");
      return heard.length === 0 ? term : `${term} (heard as ${heard})`;
    });

/** Adds or strengthens one entry. `source: "added"` wins over learned once he has said it himself. */
export const upsertEntry = (
  entries: ReadonlyArray<VocabularyEntry>,
  next: {
    readonly phrase: string;
    readonly replacement: string | null;
    readonly source: VocabularySource;
  },
  now: string,
  by = 1,
): ReadonlyArray<VocabularyEntry> => {
  const at = entries.findIndex(
    (entry) =>
      sameWord(entry.phrase, next.phrase) && (entry.replacement ?? null) === next.replacement,
  );
  if (at < 0) {
    return [...entries, { ...next, count: by, lastSeen: now }];
  }
  return entries.map((entry, i) =>
    i === at
      ? {
          ...entry,
          source:
            entry.source === "added" || next.source === "added"
              ? "added"
              : (entry.source ?? next.source),
          count: (entry.count ?? 1) + by,
          lastSeen: now,
        }
      : entry,
  );
};

export const removeEntry = (
  entries: ReadonlyArray<VocabularyEntry>,
  phrase: string,
): ReadonlyArray<VocabularyEntry> => entries.filter((entry) => !sameWord(entry.phrase, phrase));

/** "add Kubernetes to my dictionary": the word, or null when it is not that command. */
export const parseAddToDictionary = (said: string): string | null => {
  const match =
    /^(?:(?:hey |ok |okay )?(?:jarvis|baton|alfred|freya)[,:]?\s+)?(?:please\s+)?(?:add|learn|remember)\s+(.{2,60}?)\s+(?:to|in|into)\s+(?:my|the)\s+(?:dictionary|vocabulary)[.!]?$/i.exec(
      said.trim(),
    );
  const word = match?.[1]?.trim().replace(/^["“'‘]|["”'’]$/g, "") ?? "";
  return word.length > 0 ? word : null;
};

const tokens = (text: string): ReadonlyArray<string> =>
  text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? [];

/** 1 for the same letters, 0 for nothing in common. */
export const similar = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (x[i - 1] === y[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - row[y.length]! / Math.max(x.length, y.length);
};

/**
 * Words he changed after Baton wrote them. The two texts must be the same sentence with a few words
 * swapped: if more than a third of the words differ, or lengths differ by more than two words, he
 * rewrote rather than corrected and nothing is learned. A swap must look like a mis-hearing.
 */
export const correctionsBetween = (
  inserted: string,
  readBack: string,
): ReadonlyArray<{ readonly heard: string; readonly meant: string }> => {
  const a = tokens(inserted);
  const b = tokens(readBack);
  if (a.length === 0) return [];
  if (a.length !== b.length) {
    // One span he typed over as one word ("git hub" became "GitHub"): the words around it must not change.
    let start = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start += 1;
    let end = 0;
    while (end < Math.min(a.length, b.length) - start && a.at(-1 - end) === b.at(-1 - end))
      end += 1;
    const span = a.slice(start, a.length - end);
    const word = b.slice(start, b.length - end);
    if (span.length < 2 || span.length > 3 || word.length !== 1) return [];
    return similar(span.join(""), word[0]!) >= 0.4
      ? [{ heard: span.join(" "), meant: word[0]! }]
      : [];
  }
  const pairs: Array<{ heard: string; meant: string }> = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    // A capital or spelling change only is still a correction (clearly the same word).
    if (similar(a[i]!, b[i]!) >= 0.4) pairs.push({ heard: a[i]!, meant: b[i]! });
    else return [];
  }
  return pairs.length > 0 && pairs.length <= Math.max(1, Math.floor(a.length / 3)) ? pairs : [];
};

const COMMON = new Set(
  "i i'm i'll i've i'd the a an and but or so if then this that these those it is are was were be to of in on at for with from by as we you he she they my your his her our their what when where who why how monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);

/** Grammar, not a name: "Their" for "There" or "in to" for "into" is never taught, whatever its capitals. */
const EVERYDAY = new Set(
  "there they're theirs its it's you're too two than were where wear into onto maybe cannot already anyway everyday altogether whatever whoever because about after before over under up down out off all any some no not yes".split(
    " ",
  ),
);
const everyday = (text: string): boolean =>
  text
    .toLowerCase()
    .split(/\s+/)
    .some((w) => COMMON.has(w) || EVERYDAY.has(w));

/**
 * The corrections in the words just before the caret, aligned word by word: the dictation's own length, or up to
 * two words shorter or longer for a span he typed over ("git hub" became "GitHub"), so text before it never counts.
 */
export const correctionsAtCaret = (
  written: string,
  before: string,
): {
  readonly fixes: ReadonlyArray<{ readonly heard: string; readonly meant: string }>;
  readonly fixed: string;
} => {
  const n = tokens(written).length;
  const starts = [...before.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)].map((m) => m.index);
  for (const k of [n, n - 1, n - 2, n + 1, n + 2]) {
    if (k < 1 || k > starts.length) continue;
    const fixed = before.slice(starts[starts.length - k]).trim();
    const fixes = correctionsBetween(written, fixed);
    if (fixes.length > 0) return { fixes, fixed };
  }
  return { fixes: [], fixed: "" };
};

/** Words that look like names or terms: capitalised mid-sentence, camelCase, or with digits. */
export const candidateWords = (text: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    tokens(sentence).forEach((word, index) => {
      const bare = word.replace(/[.'’-]+$/g, "");
      if (bare.length < 3 || COMMON.has(bare.toLowerCase())) return;
      const camel = /[a-z][A-Z]/.test(bare) || (/\p{N}/u.test(bare) && /\p{L}/u.test(bare));
      const proper = index > 0 && /^\p{Lu}\p{Ll}+$/u.test(bare);
      if (camel || proper) found.add(bare);
    });
  }
  return [...found];
};

/** Seen-count state for repeated terms; promoted into the vocabulary at LEARN_THRESHOLD. */
export type SeenWords = Readonly<Record<string, number>>;

const NAMES = new Set(
  "james john robert michael william david richard joseph thomas charles daniel matthew anthony mark paul steven andrew kenneth joshua kevin brian george edward ronald timothy jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel frank gregory raymond alexander patrick jack dennis jerry tyler aaron henry adam douglas nathan peter zachary kyle noah ethan jeremy walter christian keith roger terry austin sean gerald carl harold dylan arthur lawrence jordan jesse bryan billy bruce gabriel joe logan alan juan albert willie elijah wayne randy vincent mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley kimberly emily donna michelle carol amanda melissa deborah stephanie dorothy rebecca sharon laura cynthia amy kathleen angela shirley anna brenda pamela emma nicole helen samantha katherine christine debra rachel carolyn janet maria olivia heather diane julie joyce victoria kelly christina joan evelyn lauren judith megan cheryl andrea hannah jacqueline martha gloria teresa ann sara madison frances kathryn janice jean abigail alice julia judy sophia grace denise amber doris marilyn danielle beverly isabella theresa diana natalie brittany charlotte marie kayla alexis lori tessa tess sam tom bob jim tim dan mike steve chris nick ben will liz kate jen".split(
    " ",
  ),
);
const FILE_EXT =
  /\.(?:png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|csv|txt|md|json|ya?ml|zip|exe|msi|dll|ts|tsx|js|jsx|mjs|py|rs|go|java|cs|cpp|html?|css|sql|log|mp[34]|wav|mov)$/i;

/** Why a word is never learned, or null when it may be: paths, URLs, code, numbers, acronyms and common names. */
export const skipWord = (word: string): string | null => {
  const w = word.trim();
  if (w.length < 3) return "short";
  if (/:\/\/|^www\.|\.(?:com|org|net|io|dev|app|co|ai)$/i.test(w)) return "url";
  if (/[\\/]/.test(w)) return "path";
  if (FILE_EXT.test(w)) return "file";
  if (/[_=(){}<>$#`@]|::|=>/.test(w)) return "code";
  if (/^[\d.,:%£$€-]+$/.test(w) || /^\d/.test(w)) return "number";
  if (/^[0-9a-f]{7,}$/i.test(w)) return "code";
  if (w.length > 1 && w === w.toUpperCase() && /\p{L}/u.test(w) && !/\p{N}/u.test(w))
    return "acronym";
  if (NAMES.has(w.toLowerCase())) return "common name";
  return null;
};

/** A word he fixed himself may be a name or an acronym; only paths, files, URLs, code and numbers are skipped. */
const skipsCorrection = (word: string): boolean => {
  const why = skipWord(word);
  return why !== null && why !== "common name" && why !== "acronym" && why !== "short";
};

/** Words he has deleted or discarded: they never come back on their own. */
export type NeverList = ReadonlyArray<string>;
export const isNever = (never: NeverList, word: string): boolean =>
  never.some((n) => n.toLowerCase() === word.toLowerCase());
export const addNever = (never: NeverList, word: string): NeverList =>
  isNever(never, word) ? never : [...never, word];
export const parseNever = (value: unknown): NeverList =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

export interface Learned {
  readonly seen: SeenWords;
  readonly entries: ReadonlyArray<VocabularyEntry>;
  /** What entered the vocabulary in this call, for the toast. */
  readonly added: ReadonlyArray<VocabularyEntry>;
  /** Forms one correction taught to the word he meant, for the toast and its Undo. */
  readonly taught?: ReadonlyArray<{ readonly heard: string; readonly meant: string }>;
}

export const observeWording = (
  seen: SeenWords,
  entries: ReadonlyArray<VocabularyEntry>,
  text: string,
  now: string,
  wakeWords: ReadonlyArray<string> = [],
  never: NeverList = [],
): Learned => {
  const skip = new Set(wakeWords.map((word) => word.toLowerCase()));
  let nextSeen: Record<string, number> = { ...seen };
  let nextEntries = entries;
  const added: VocabularyEntry[] = [];
  for (const word of candidateWords(text)) {
    const key = word.toLowerCase();
    if (skip.has(key) || isNever(never, word) || skipWord(word) !== null) continue;
    if (entries.some((entry) => sameWord(entry.phrase, word))) continue;
    nextSeen[key] = (nextSeen[key] ?? 0) + 1;
    if (nextSeen[key]! >= LEARN_THRESHOLD) {
      nextEntries = upsertEntry(
        nextEntries,
        { phrase: word, replacement: null, source: "learned" },
        now,
        nextSeen[key]!,
      );
      added.push(nextEntries.find((e) => sameWord(e.phrase, word))!);
      const { [key]: _gone, ...rest } = nextSeen;
      nextSeen = rest;
    }
  }
  return { seen: nextSeen, entries: nextEntries, added };
};

/**
 * A correction he made. Once is enough to teach the form it was heard as, on the word he meant (as Wispr learns):
 * a hint for the clean-up, announced so he can undo it. Made CORRECTION_THRESHOLD times it also enters as
 * `heard -> meant`, which applies with no model. A capital-only fix teaches nothing until then.
 */
export const learnCorrection = (
  seen: SeenWords,
  entries: ReadonlyArray<VocabularyEntry>,
  fix: { readonly heard: string; readonly meant: string },
  now: string,
  never: NeverList = [],
): Learned => {
  if (
    isNever(never, fix.meant) ||
    isNever(never, fix.heard) ||
    skipsCorrection(fix.meant) ||
    everyday(fix.heard) ||
    everyday(fix.meant)
  ) {
    return { seen, entries, added: [], taught: [] };
  }
  const key = `${fix.heard.toLowerCase()}>${fix.meant}`;
  const count = (seen[key] ?? 0) + 1;
  let next = entries;
  const taught: Array<{ heard: string; meant: string }> = [];
  if (!sameWord(fix.heard, fix.meant)) {
    const word = next.find((e) => e.replacement === null && sameWord(e.phrase, fix.meant));
    if (word === undefined) {
      next = [
        ...next,
        {
          phrase: fix.meant,
          replacement: null,
          source: "learned",
          count: 1,
          lastSeen: now,
          heard: [fix.heard],
        },
      ];
      taught.push(fix);
    } else if (!(word.heard ?? []).some((h) => sameWord(h, fix.heard))) {
      next = next.map((e) =>
        e === word
          ? { ...e, lastSeen: now, ...withHeard(e.phrase, [...(e.heard ?? []), fix.heard]) }
          : e,
      );
      taught.push(fix);
    }
  }
  if (count < CORRECTION_THRESHOLD)
    return { seen: { ...seen, [key]: count }, entries: next, added: [], taught };
  const { [key]: _gone, ...rest } = seen;
  next = upsertEntry(
    next,
    { phrase: fix.heard, replacement: fix.meant, source: "learned" },
    now,
    count,
  );
  return {
    seen: rest,
    entries: next,
    added: next.filter((e) => sameWord(e.phrase, fix.heard) && e.replacement === fix.meant),
    taught,
  };
};

/** Undoes one taught form: off the word, and the word too when that form was all it had learned. */
export const unteach = (
  entries: ReadonlyArray<VocabularyEntry>,
  fix: { readonly heard: string; readonly meant: string },
): ReadonlyArray<VocabularyEntry> =>
  removeHeard(entries, fix.meant, fix.heard).filter(
    (e) =>
      // The literal rule a second correction added goes with it.
      !(sameWord(e.phrase, fix.heard) && e.replacement === fix.meant) &&
      !(
        sameWord(e.phrase, fix.meant) &&
        e.replacement === null &&
        e.source === "learned" &&
        (e.count ?? 1) <= 1 &&
        e.heard === undefined
      ),
  );

/**
 * Tessaya's own names as Parakeet writes them, mined from the training split of his Wispr clips (DICT-WISPR). Only
 * forms that are never everyday words or real names: "button", "baton", "Tessa" and "Tesla" are left to the model.
 */
const OWN_HEARD: ReadonlyArray<{
  readonly to: string;
  readonly form: string;
  readonly before?: ReadonlyArray<string>;
  readonly after?: ReadonlyArray<string>;
}> = [
  ...["Tisia", "Tessia", "Tesaya", "Tessay", "Tayya", "Te Saya", "Tes Saya"].map((form) => ({
    to: "Tessaya",
    form,
  })),
  { to: "Baton", form: "Buton" },
  // The dictation app he measures against, as Parakeet writes it.
  ...["WhisperFlow", "Whisper Flow", "Wisper Flow", "WisprFlow"].map((form) => ({
    to: "Wispr Flow",
    form,
  })),
  { to: "T3", form: "T three" },
  { to: "T3", form: "D3", after: ["code", "codes", "chat", "sessions", "s"] },
];
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
/** A whole word, never part of an identifier, path, file or address ("BATON_THREADS", "baton/dictation-magic"). */
const WORD_START = String.raw`(?<![\p{L}\p{N}_/\\.@-])`;
const WORD_END = String.raw`(?![\p{L}\p{N}_/\\@-]|\.\w)`;

/** Teseya, Tessaia, Tesseya, Tasaya: a T, one vowel, an s or two, and her name's ending. */
const OWN_NAME_SPELLING = /^[TG][aeiy][sc]{1,2}(?:[aeiy]{0,2}[yi][aeiy]{0,2})$/i;
const OWN_NAME_END = /(?:ya|ia|aia|eya|aya)$/i;
/** A clip that is only her name, as he says it to wake her. */
const OWN_NAME_ALONE = /^(?:to|ta|they|te|tes) (?:say|sea|saya|seya)(?: (?:um|uh))?$/;

/** Her own names put back before clean-up: whole words, any capitals, the longer form first, as Wispr does. */
export const applyOwnNames = (text: string): string => {
  if (
    OWN_NAME_ALONE.test(
      text
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .trim(),
    )
  )
    return text.replace(/[\p{L} ]+/u, "Tessaya");
  let out = text.replace(new RegExp(`${WORD_START}\\p{L}+(?:'?s)?${WORD_END}`, "gu"), (word) => {
    const name = (w: string) => w.length >= 6 && OWN_NAME_SPELLING.test(w) && OWN_NAME_END.test(w);
    if (name(word)) return "Tessaya";
    // "Teseyas" is her name with an "s" the recogniser ran on: a possessive.
    const bare = word.replace(/'?s$/i, "");
    return bare !== word && name(bare) ? "Tessaya's" : word;
  });
  for (const rule of OWN_HEARD.toSorted((a, b) => b.form.length - a.form.length)) {
    const pattern = new RegExp(`${WORD_START}${escapeRegExp(rule.form)}${WORD_END}`, "giu");
    out = out.replace(pattern, (found: string, at: number, whole: string) => {
      // A shouted "BATON" is not the name as heard.
      if (
        found.length > 1 &&
        found === found.toUpperCase() &&
        rule.form !== rule.form.toUpperCase()
      )
        return found;
      if (rule.before === undefined && rule.after === undefined) return rule.to;
      const before = /([\p{L}\p{N}']+)\W*$/u.exec(whole.slice(0, at))?.[1]?.toLowerCase();
      const after = /^\W*([\p{L}\p{N}']+)/u
        .exec(whole.slice(at + found.length))?.[1]
        ?.toLowerCase();
      const fits =
        (before !== undefined && (rule.before ?? []).includes(before)) ||
        (after !== undefined && (rule.after ?? []).includes(after));
      return fits ? rule.to : found;
    });
  }
  return out;
};

/** Her own names as entries, so the clean-up's hints and its check know them whether or not he added them. */
export const withOwnWords = (
  entries: ReadonlyArray<VocabularyEntry>,
): ReadonlyArray<VocabularyEntry> => {
  const own = [...new Set(OWN_HEARD.map((r) => r.to))].map((to) => ({
    phrase: to,
    heard: OWN_HEARD.filter((r) => r.to === to).map((r) => r.form),
  }));
  const mine = entries.map((e) => {
    const o = own.find((w) => sameWord(w.phrase, e.replacement ?? e.phrase));
    return o === undefined ? e : { ...e, ...withHeard(e.phrase, [...(e.heard ?? []), ...o.heard]) };
  });
  const missing = own.filter(
    (o) => !entries.some((e) => sameWord(o.phrase, e.replacement ?? e.phrase)),
  );
  return [...missing.map((o) => ({ ...o, replacement: null })), ...mine];
};

/**
 * Recognition-side bias: a near-miss of a word he uses (one or two letters off, same first letter)
 * is put right in the transcript before clean-up. Only for names and terms (a capital or a digit
 * inside), so ordinary words are never swapped.
 */
/**
 * His words written split or joined ("Wispr flow" or "WisprFlow" for Wispr Flow, "T 3" for T3) put back as he spells
 * them: a split form of his own term is never an ordinary word. Two or three words in a row, nothing between.
 */
export const joinSplitTerms = (text: string, entries: ReadonlyArray<VocabularyEntry>): string => {
  const terms = new Map<string, string>();
  for (const e of withOwnWords(entries)) {
    const term = e.replacement ?? e.phrase;
    const key = term.replace(/\s+/g, "").toLowerCase();
    if ((key.length >= 3 || /\p{N}/u.test(key)) && /^[\p{L}\p{N}]+$/u.test(key))
      terms.set(key, term);
  }
  if (terms.size === 0) return text;
  const words = [...text.matchAll(new RegExp(`${WORD_START}[\\p{L}\\p{N}]+${WORD_END}`, "gu"))];
  let out = "";
  let from = 0;
  for (let i = 0; i < words.length; i += 1) {
    // Longest first, and only words with one space between: "T 3 code" never loses "code".
    for (const size of [3, 2]) {
      const run = words.slice(i, i + size);
      if (run.length < size) continue;
      const start = run[0]!.index;
      const end = run.at(-1)!.index + run.at(-1)![0].length;
      const found = text.slice(start, end);
      if (found !== run.map((w) => w[0]).join(" ")) continue;
      const term = terms.get(found.replace(/ /g, "").toLowerCase());
      if (term === undefined) continue;
      out += text.slice(from, start) + term;
      from = end;
      i += size - 1;
      break;
    }
  }
  return out + text.slice(from);
};

/** Before these the bare word is his name ("to button on the laptop"); after an article it is the thing. */
const NAME_SLOT_BEFORE = new Set(
  "to of with without using in on from into about via through".split(" "),
);
const NAME_SLOT_AFTER = new Set(
  "and or but is was are were has have will can should so then because on in to for with at from as".split(
    " ",
  ),
);

/**
 * A form he taught (from Wispr or a correction) that is an everyday word ("button" for Baton) changes only in the
 * bare slot after a preposition, with no article, and only when what follows is not more of a noun phrase.
 */
/**
 * Everyday words a taught form must never be, however it was learned: "feelIt" taught from "It" turned "overlap with it
 * and" into "overlap with feelIt and" (0.1.92). Such a form is left to the model, which sees the whole sentence.
 */
const EVERYDAY_FORMS = new Set(
  (
    "i me my we us our you your he him his she her it its they them their this that these those there here " +
    "a an the and or but so if then than as of in on at to for from by with about into over after before " +
    "is am are was were be been being have has had do does did will would can could should may might must shall " +
    "not no yes all any some one two each every more most much many few what which who when where why how " +
    "get got make made go went say said see saw know think take come want look use find give tell work call try ask " +
    "need feel leave put mean keep let seem help show hear play run move like live hold bring write sit stand pay " +
    "meet set learn change lead read add grow open win love buy wait send build stay fall cut reach good new first " +
    "last long great little own other old right big high small large next early young important few public bad same able"
  ).split(" "),
);

/** A heard form too ordinary to stand for one of his words anywhere: short, or a word everyone says. */
const everydayForm = (form: string): boolean =>
  form.length < 3 || everyday(form) || EVERYDAY_FORMS.has(form.toLowerCase());

const applyTaughtForms = (text: string, entries: ReadonlyArray<VocabularyEntry>): string => {
  let out = text;
  for (const e of entries)
    for (const form of e.heard ?? []) {
      if (!/^\p{L}+$/u.test(form) || everydayForm(form)) continue;
      const term = e.replacement ?? e.phrase;
      out = out.replace(
        new RegExp(`${WORD_START}${escapeRegExp(form)}${WORD_END}`, "giu"),
        (found: string, at: number, whole: string) => {
          const before = /([\p{L}']+)[^\p{L}\n]*$/u.exec(whole.slice(0, at))?.[1]?.toLowerCase();
          const rest = whole.slice(at + found.length);
          const after = /^ ([\p{L}']+)/u.exec(rest)?.[1]?.toLowerCase();
          const ends = after === undefined && /^(?:[,.;:!?]|\s*$)/.test(rest);
          return before !== undefined &&
            NAME_SLOT_BEFORE.has(before) &&
            (ends || (after !== undefined && NAME_SLOT_AFTER.has(after)))
            ? term
            : found;
        },
      );
    }
  return out;
};

export const biasTranscript = (
  heardText: string,
  entries: ReadonlyArray<VocabularyEntry>,
): string => {
  const text = joinSplitTerms(applyTaughtForms(applyOwnNames(heardText), entries), entries);
  const terms = entries
    .map((entry) => entry.replacement ?? entry.phrase)
    .filter(
      (term) =>
        term.length >= 5 &&
        (/\p{Lu}/u.test(term.slice(1)) || /\p{N}/u.test(term) || /^\p{Lu}/u.test(term)),
    );
  if (terms.length === 0) return text;
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, (word) => {
    // A real first name ("Tessa") is someone, not a near-miss of his word.
    if (word.length < 5 || NAMES.has(word.toLowerCase())) return word;
    for (const term of terms) {
      if (word === term || word[0]!.toLowerCase() !== term[0]!.toLowerCase()) continue;
      if (
        similar(word, term) >= 1 - (term.length >= 8 ? 2 : 1) / term.length &&
        Math.abs(word.length - term.length) <= 2
      ) {
        return term;
      }
    }
    return word;
  });
};

/** One row of Wispr Flow's `Dictionary` table, as read from its database. */
export interface WisprRow {
  readonly phrase: string | null;
  readonly replacement: string | null;
  /** The form Wispr wrote before he corrected it; not always text. */
  readonly observedSource: unknown;
  readonly isSnippet: number | null;
  readonly frequencyUsed: number | null;
}

/**
 * What he taught Wispr, added to his vocabulary: each word with the forms it was mis-heard as, and how often he
 * used it. Snippets come back apart, for his snippets, and leave the dictionary an earlier import put them in.
 * `addWords: false` only enriches the words he has, so one he deleted after an earlier import stays deleted.
 */
export const mergeWispr = (
  entries: ReadonlyArray<VocabularyEntry>,
  rows: ReadonlyArray<WisprRow>,
  never: NeverList = [],
  addWords = true,
): {
  readonly entries: ReadonlyArray<VocabularyEntry>;
  readonly snippets: ReadonlyArray<{ readonly cue: string; readonly text: string }>;
} => {
  let next = entries;
  const snippets: Array<{ cue: string; text: string }> = [];
  for (const row of rows) {
    const phrase = row.phrase?.trim() ?? "";
    const replacement = row.replacement?.trim() || null;
    if (phrase.length === 0) continue;
    if (row.isSnippet === 1) {
      if (replacement === null) continue;
      snippets.push({ cue: phrase, text: replacement });
      next = next.filter((e) => !(sameWord(e.phrase, phrase) && e.replacement === replacement));
      continue;
    }
    if (isNever(never, phrase)) continue;
    const heard = withHeard(phrase, [row.observedSource]).heard ?? [];
    const used = Math.max(1, Math.floor(row.frequencyUsed ?? 1));
    if (!next.some((e) => sameWord(e.phrase, phrase))) {
      if (!addWords) continue;
      next = [
        ...next,
        {
          phrase,
          replacement,
          source: "wispr",
          count: used,
          ...(heard.length > 0 ? { heard } : {}),
        },
      ];
      continue;
    }
    next = next.map((e) =>
      sameWord(e.phrase, phrase)
        ? {
            ...e,
            count: Math.max(e.count ?? 1, used),
            ...withHeard(e.phrase, [...(e.heard ?? []), ...heard]),
          }
        : e,
    );
  }
  return { entries: next, snippets };
};
