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

/** The words the clean-up prompt gets: most used first, capped. */
export const promptTerms = (entries: ReadonlyArray<VocabularyEntry>): ReadonlyArray<string> =>
  [...entries]
    .sort((a, b) => (b.count ?? 1) - (a.count ?? 1))
    .slice(0, PROMPT_TERMS)
    .map((entry) => entry.replacement ?? entry.phrase);

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

const similar = (a: string, b: string): number => {
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
  if (a.length === 0 || Math.abs(a.length - b.length) > 0) return [];
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
  "james john robert michael william david richard joseph thomas charles daniel matthew anthony mark paul steven andrew kenneth joshua kevin brian george edward ronald timothy jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel frank gregory raymond alexander patrick jack dennis jerry tyler aaron henry adam douglas nathan peter zachary kyle noah ethan jeremy walter christian keith roger terry austin sean gerald carl harold dylan arthur lawrence jordan jesse bryan billy bruce gabriel joe logan alan juan albert willie elijah wayne randy vincent mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley kimberly emily donna michelle carol amanda melissa deborah stephanie dorothy rebecca sharon laura cynthia amy kathleen angela shirley anna brenda pamela emma nicole helen samantha katherine christine debra rachel carolyn janet maria olivia heather diane julie joyce victoria kelly christina joan evelyn lauren judith megan cheryl andrea hannah jacqueline martha gloria teresa ann sara madison frances kathryn janice jean abigail alice julia judy sophia grace denise amber doris marilyn danielle beverly isabella theresa diana natalie brittany charlotte marie kayla alexis lori sam tom bob jim tim dan mike steve chris nick ben will liz kate jen".split(
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
 * A learned correction: counted in `seen` until he has made it CORRECTION_THRESHOLD times, then it
 * enters as `heard -> meant`.
 */
export const learnCorrection = (
  seen: SeenWords,
  entries: ReadonlyArray<VocabularyEntry>,
  fix: { readonly heard: string; readonly meant: string },
  now: string,
  never: NeverList = [],
): Learned => {
  if (isNever(never, fix.meant) || isNever(never, fix.heard) || skipsCorrection(fix.meant)) {
    return { seen, entries, added: [] };
  }
  const key = `${fix.heard.toLowerCase()}>${fix.meant}`;
  const count = (seen[key] ?? 0) + 1;
  if (count < CORRECTION_THRESHOLD) return { seen: { ...seen, [key]: count }, entries, added: [] };
  const { [key]: _gone, ...rest } = seen;
  const next = upsertEntry(
    entries,
    { phrase: fix.heard, replacement: fix.meant, source: "learned" },
    now,
    count,
  );
  return {
    seen: rest,
    entries: next,
    added: next.filter((e) => sameWord(e.phrase, fix.heard) && e.replacement === fix.meant),
  };
};

/**
 * Recognition-side bias: a near-miss of a word he uses (one or two letters off, same first letter)
 * is put right in the transcript before clean-up. Only for names and terms (a capital or a digit
 * inside), so ordinary words are never swapped.
 */
export const biasTranscript = (text: string, entries: ReadonlyArray<VocabularyEntry>): string => {
  const terms = entries
    .map((entry) => entry.replacement ?? entry.phrase)
    .filter(
      (term) =>
        term.length >= 5 &&
        (/\p{Lu}/u.test(term.slice(1)) || /\p{N}/u.test(term) || /^\p{Lu}/u.test(term)),
    );
  if (terms.length === 0) return text;
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, (word) => {
    if (word.length < 5) return word;
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
