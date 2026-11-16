/**
 * His personal vocabulary, `<state dir>/voice/dictionary.json`. One format for words he added, words
 * Baton learned from his corrections and wording, and the Wispr import. Old files (just `phrase`
 * and `replacement`) read as `added` with a count of 1. It never leaves his machine except inside
 * his own Claude clean-up call (the term list in the prompt).
 */

import type { VocabularyChange } from "@t3tools/tessaya-contracts";

import { CALL_SLOT, NAME_SOUNDALIKES, nameAskedFor } from "./wakeVerify.ts";

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

/** A word without the full stop or quote that ended its sentence: "Tessaya." is taught as Tessaya. */
const bare = (word: string): string => word.replace(/[.'’-]+$/, "");

/** Distinct forms, never the word itself; an absent list stays absent so old files read back unchanged. */
const withHeard = (phrase: string, value: unknown): { readonly heard?: ReadonlyArray<string> } => {
  if (!Array.isArray(value)) return {};
  const forms = [
    ...new Set(
      value
        .filter((v): v is string => typeof v === "string")
        .map((v) => bare(v.replace(/\s+/g, " ").trim()))
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
    ? // A stopped copy of a word ("Tessaya." beside Tessaya) is the same word: one entry.
      mergeEntries(
        [],
        value.flatMap((item): ReadonlyArray<VocabularyEntry> => {
          const entry = item as Partial<VocabularyEntry> | null;
          if (typeof entry !== "object" || entry === null || typeof entry.phrase !== "string")
            return [];
          if (entry.phrase.trim().length === 0) return [];
          // A word at a sentence's end was once learned or added with its stop ("Tessaya." heard as "Tsaya.").
          const learned = entry.source === "learned";
          const phrase =
            (learned ? bare(entry.phrase) : entry.phrase.replace(/[.,!?;:]+$/, "")) || entry.phrase;
          return [
            {
              phrase,
              replacement:
                typeof entry.replacement === "string" && entry.replacement.length > 0
                  ? entry.replacement
                  : null,
              source:
                entry.source === "learned" || entry.source === "wispr" ? entry.source : "added",
              count:
                typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count > 0
                  ? Math.floor(entry.count)
                  : 1,
              ...(typeof entry.lastSeen === "string" ? { lastSeen: entry.lastSeen } : {}),
              ...withHeard(phrase, entry.heard),
            },
          ];
        }),
      )
    : [];

/** The words the clean-up prompt gets, her own names first, then most used, capped; each with how it is mis-heard. */
export const promptTerms = (entries: ReadonlyArray<VocabularyEntry>): ReadonlyArray<string> => {
  const his = new Set(withOwnWords(entries).map((e) => (e.replacement ?? e.phrase).toLowerCase()));
  return withOwnWords(entries)
    .map((entry, i) => ({ entry, rank: entry.count ?? Number.MAX_SAFE_INTEGER - i }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, PROMPT_TERMS)
    .map(({ entry }) => {
      const term = entry.replacement ?? entry.phrase;
      // Never an everyday word, however it is capitalised: "feelIt (heard as "It")" made the model write "part of
      // feelIt" (0.1.92).
      const forms = (entry.heard ?? []).filter(
        (h) => !everydayForm(h) && !his.has(h.toLowerCase()),
      );
      const quote = (list: ReadonlyArray<string>) => list.map((h) => `"${h}"`).join(", ");
      const named = forms.filter((h) => /^\p{Lu}/u.test(h));
      // A form that is also a real word ("button" for Baton) is a hint only where the sentence is about his word.
      const plain = forms.filter((h) => !/^\p{Lu}/u.test(h));
      const notes = [
        ...(named.length === 0 ? [] : [`heard as ${quote(named)}`]),
        ...(plain.length === 0
          ? []
          : [`sometimes heard as ${quote(plain)}, only where it names this`]),
      ];
      return notes.length === 0 ? term : `${term} (${notes.join("; ")})`;
    });
};

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

/** Adds or replaces: one entry per phrase, ignoring case. An empty phrase changes nothing. */
export const addEntry = (
  list: ReadonlyArray<VocabularyEntry>,
  entry: { readonly phrase: string; readonly replacement: string | null },
): ReadonlyArray<VocabularyEntry> => {
  // A word added by voice comes with the sentence's stop ("Tessaya." on his laptop, 16 Nov); "Sol.md" keeps its dot.
  const phrase = entry.phrase.trim().replace(/[.,!?;:]+$/, "");
  if (phrase.length === 0) return list;
  const replacement =
    entry.replacement === null || entry.replacement.trim().length === 0
      ? null
      : entry.replacement.trim();
  const heard = list.find((e) => sameWord(e.phrase, phrase))?.heard;
  return [
    { phrase, replacement, source: "added", ...(heard === undefined ? {} : { heard }) },
    ...list.filter((e) => !sameWord(e.phrase, phrase)),
  ];
};

/** Changes the spelling or the phrase of one word and keeps what was learned about it. */
export const editEntry = (
  list: ReadonlyArray<VocabularyEntry>,
  from: string,
  to: { readonly phrase: string; readonly replacement: string | null },
): ReadonlyArray<VocabularyEntry> => {
  const old = list.find((e) => sameWord(e.phrase, from));
  const phrase = to.phrase.trim();
  if (old === undefined || phrase.length === 0) return list;
  const replacement =
    to.replacement === null || to.replacement.trim().length === 0 ? null : to.replacement.trim();
  return list
    .map((e) => (e === old ? { ...e, phrase, replacement } : e))
    .filter((e, i, all) => e === old || !sameWord(e.phrase, phrase) || all.indexOf(e) === i);
};

/**
 * Another copy's entries into this one: the same word keeps the higher count, every heard form, the later time and
 * "added" when either says so. Merging twice changes nothing, so a copy may send what it has as often as it likes.
 */
export const mergeEntries = (
  entries: ReadonlyArray<VocabularyEntry>,
  incoming: ReadonlyArray<VocabularyEntry>,
): ReadonlyArray<VocabularyEntry> => {
  const all = [...entries];
  for (const next of incoming) {
    const at = all.findIndex(
      (e) => sameWord(e.phrase, next.phrase) && (e.replacement ?? null) === next.replacement,
    );
    if (at < 0) {
      all.push(next);
      continue;
    }
    const old = all[at]!;
    const heard = withHeard(old.phrase, [...(old.heard ?? []), ...(next.heard ?? [])]);
    const { heard: _heard, ...rest } = old;
    const lastSeen = [old.lastSeen, next.lastSeen]
      .filter((t) => t !== undefined)
      .sort()
      .at(-1);
    all[at] = {
      ...rest,
      source:
        old.source === "added" || next.source === "added"
          ? "added"
          : (old.source ?? next.source ?? "added"),
      count: Math.max(old.count ?? 1, next.count ?? 1),
      ...(lastSeen === undefined ? {} : { lastSeen }),
      ...heard,
    };
  }
  return all;
};

const SOURCE_RANK: Record<VocabularySource, number> = { added: 0, learned: 1, wispr: 2 };
const spellingKey = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase();

/**
 * The upstream speech dictionary (`speechProjectCustomWords`) as the top `max` of his: added first, then learned by
 * count, then Wispr. Each spelling is used once across the list and fits its 50 letters, as that contract requires.
 */
export const customWordsOf = (
  entries: ReadonlyArray<VocabularyEntry>,
  max = 100,
): ReadonlyArray<{ readonly term: string; readonly aliases: ReadonlyArray<string> }> => {
  const seen = new Set<string>();
  const fresh = (spelling: string) => {
    const key = spellingKey(spelling);
    if (key.length === 0 || spelling.trim().length > 50 || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort(
      (a, b) =>
        SOURCE_RANK[a.entry.source ?? "added"] - SOURCE_RANK[b.entry.source ?? "added"] ||
        (a.entry.source === "learned" ? (b.entry.count ?? 1) - (a.entry.count ?? 1) : 0) ||
        a.i - b.i,
    )
    .flatMap(({ entry }) => {
      const term = (entry.replacement ?? entry.phrase).trim();
      if (!fresh(term)) return [];
      const forms = [...(entry.replacement === null ? [] : [entry.phrase]), ...(entry.heard ?? [])];
      const aliases: Array<string> = [];
      for (const form of forms) if (aliases.length < 8 && fresh(form)) aliases.push(form.trim());
      return [{ term, aliases }];
    })
    .slice(0, max);
};

/** An edit of T3's dictionary list (Settings → Voice on web and phone) as changes to his one dictionary. */
export const changesFromCustomWords = (
  before: ReadonlyArray<{ readonly term: string; readonly aliases: ReadonlyArray<string> }>,
  after: ReadonlyArray<{ readonly term: string; readonly aliases: ReadonlyArray<string> }>,
): ReadonlyArray<VocabularyChange> => {
  const find = (list: typeof before, term: string) => list.find((w) => sameWord(w.term, term));
  const missing = (list: ReadonlyArray<string>, form: string) =>
    !list.some((f) => sameWord(f, form));
  return [
    ...before.flatMap((old): ReadonlyArray<VocabularyChange> => {
      const now = find(after, old.term);
      if (now === undefined) return [{ verb: "remove", phrase: old.term }];
      return old.aliases
        .filter((form) => missing(now.aliases, form))
        .map((form) => ({ verb: "unhear", phrase: old.term, form }));
    }),
    ...after.flatMap((now): ReadonlyArray<VocabularyChange> => {
      const old = find(before, now.term);
      if (old === undefined)
        return [
          { verb: "add", phrase: now.term, replacement: null },
          ...(now.aliases.length === 0
            ? []
            : [
                {
                  verb: "learn" as const,
                  entries: [{ phrase: now.term, replacement: null, heard: now.aliases }],
                },
              ]),
        ];
      const added = now.aliases.filter((form) => missing(old.aliases, form));
      return added.length === 0
        ? []
        : [{ verb: "learn", entries: [{ phrase: now.term, replacement: null, heard: added }] }];
    }),
  ];
};

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

/** Spelling folded towards sound: "Tesai" and "Tessaya", "Zohayb" and "Zohaib" come closer, letters only. */
export const soundKey = (word: string): string =>
  word
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");

/** Whether a heard word could be one of his terms mis-heard ("Tesla" for Tessaya, "button" for Baton). */
export const soundsLike = (heard: string, term: string): boolean =>
  heard.toLowerCase() !== term.toLowerCase() && similar(soundKey(heard), soundKey(term)) >= 0.6;

const consonants = (word: string) =>
  soundKey(word)
    .replace(/(?!^)[aeiouhwy]/g, "")
    .replace(/(.)\1+/g, "$1");
/** The same consonants in the same order, four or more: "whisperfull" and Wispr Flow, where vowels and spelling differ. */
export const sameConsonants = (heard: string, term: string): boolean => {
  const key = consonants(term);
  return key.length >= 4 && consonants(heard) === key;
};

/**
 * Names on his screen, from the lines of the focused window's accessibility tree (`Kind: Name …`): words with a
 * capital, a digit or camelCase inside, most frequent first. Titles capitalise every word, so common words are dropped.
 */
export const screenNames = (lines: ReadonlyArray<string>, max = 50): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const name = line.replace(/^[\w ]+?:\s*/, "");
    for (const word of tokens(name)) {
      const bare = word.replace(/[.'’-]+$/g, "");
      if (
        bare.length < 2 ||
        COMMON.has(bare.toLowerCase()) ||
        EVERYDAY_FORMS.has(bare.toLowerCase())
      )
        continue;
      const looks = /^\p{Lu}/u.test(bare) || /\p{N}/u.test(bare) || /[a-z][A-Z]/.test(bare);
      if (looks && !/^\d+$/.test(bare)) counts.set(bare, (counts.get(bare) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);
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
      ? [{ heard: bare(span.join(" ")), meant: bare(word[0]!) }]
      : [];
  }
  const pairs: Array<{ heard: string; meant: string }> = [];
  for (let i = 0; i < a.length; i += 1) {
    const heard = bare(a[i]!);
    const meant = bare(b[i]!);
    if (heard === meant) continue;
    // A capital or spelling change only is still a correction (clearly the same word).
    if (similar(heard, meant) >= 0.4) pairs.push({ heard, meant });
    else return [];
  }
  return pairs.length > 0 && pairs.length <= Math.max(1, Math.floor(a.length / 3)) ? pairs : [];
};

/** Longer messages are left alone: the alignment below costs their word counts multiplied. */
const SENT_ALIGN_LIMIT = 250_000;

/**
 * His fixes in a message he sent, against what dictation put in: the two are aligned word by word, and each changed
 * run of 1 to 3 words either side reads as `correctionsBetween` reads a field. Words he only added or deleted teach nothing.
 */
export const correctionsInSent = (
  written: string,
  sent: string,
): ReadonlyArray<{ readonly heard: string; readonly meant: string }> => {
  const a = tokens(written).map(bare);
  const b = tokens(sent).map(bare);
  if (a.length * b.length > SENT_ALIGN_LIMIT) return [];
  // Longest common run of words, from the end, so the walk below goes forward.
  const same = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      same[i]![j] =
        a[i] === b[j] ? same[i + 1]![j + 1]! + 1 : Math.max(same[i + 1]![j]!, same[i]![j + 1]!);
  const fixes: Array<{ readonly heard: string; readonly meant: string }> = [];
  let i = 0;
  let j = 0;
  let from: readonly [number, number] = [0, 0];
  const close = () => {
    const heard = a.slice(from[0], i);
    const meant = b.slice(from[1], j);
    if (heard.length >= 1 && heard.length <= 3 && meant.length >= 1 && meant.length <= 3)
      fixes.push(...correctionsBetween(heard.join(" "), meant.join(" ")));
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
      from = [i, j];
    } else if (j >= b.length || (i < a.length && same[i + 1]![j]! >= same[i]![j + 1]!)) i += 1;
    else j += 1;
  }
  close();
  return fixes;
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

/** Common first names: a person, never a near-miss of his word, and a capital kept mid-sentence (dictationFit.ts). */
export const FIRST_NAMES: ReadonlySet<string> = new Set(
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
  if (FIRST_NAMES.has(w.toLowerCase())) return "common name";
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
 * forms that are never everyday words or real names: "Tessa" and "Tesla" are left to the model. Never an old name
 * (Baton, Fabric): one here is put in every prompt, and Sonnet wrote "Batons" for his "buttons" (16 Nov).
 */
const OWN_HEARD: ReadonlyArray<{
  readonly to: string;
  readonly form: string;
  readonly before?: ReadonlyArray<string>;
  readonly after?: ReadonlyArray<string>;
}> = [
  // Her name's sound-alikes from the one list; a persona's reach turns through the dictionary's heard forms.
  ...NAME_SOUNDALIKES.tessaya!.heard.map((form) => ({ to: "Tessaya", form })),
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

/** Her own names of more than one word: her manager thread, written the way he names it. */
const OWN_PHRASES: ReadonlyArray<string> = ["Tessaya Manager", "Tessel"];

/**
 * His names of two or more words put right as one: each word as written, or (with at least one word exact to hold it in
 * place) a near-miss of it, so "the Tesla manager" is Tessaya Manager while a Tesla alone stays a car.
 */
export const applyKnownNames = (text: string, entries: ReadonlyArray<VocabularyEntry>): string => {
  const own = withOwnWords(entries);
  const phrases = [...new Set(own.map((e) => (e.replacement ?? e.phrase).trim()))]
    .filter((t) => /\s/.test(t))
    .toSorted((a, b) => b.length - a.length);
  if (phrases.length === 0) return text;
  const heardOf = (word: string) =>
    own.find((e) => sameWord(e.replacement ?? e.phrase, word))?.heard ?? [];
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)].map((m) => ({
    word: m[0],
    at: m.index,
  }));
  const fixes: Array<{ readonly from: number; readonly to: number; readonly name: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const name of phrases) {
      const parts = name.split(/\s+/);
      const run = tokens.slice(i, i + parts.length);
      if (run.length < parts.length) continue;
      const start = run[0]!.at;
      const end = run.at(-1)!.at + run.at(-1)!.word.length;
      // One phrase, words apart only by spaces, and never inside a path, an identifier or an address.
      if (
        run.some(
          (t, k) =>
            k > 0 && !/^[ \t]+$/.test(text.slice(run[k - 1]!.at + run[k - 1]!.word.length, t.at)),
        )
      )
        continue;
      if (/[_/\\.@-]$/.test(text.slice(0, start)) || /^[_/\\@-]|^\.\w/.test(text.slice(end)))
        continue;
      // "Wispr Flow's": the possessive stays on the name.
      const tail = /['’]s$/i.exec(run.at(-1)!.word)?.[0] ?? "";
      let exact = 0;
      const fits = run.every(({ word: said }, k) => {
        const word = k === run.length - 1 ? said.slice(0, said.length - tail.length) : said;
        const part = parts[k]!;
        if (word.toLowerCase() === part.toLowerCase()) return ++exact > 0;
        return (
          word.length >= 4 &&
          word[0]!.toLowerCase() === part[0]!.toLowerCase() &&
          (soundsLike(word, part) || heardOf(part).some((h) => sameWord(h, word)))
        );
      });
      if (!fits || exact === 0) continue;
      fixes.push({ from: start, to: end, name: name + tail });
      i += parts.length - 1;
      break;
    }
  }
  return fixes.reduceRight((out, f) => out.slice(0, f.from) + f.name + out.slice(f.to), text);
};

/** Her own names as entries, so the clean-up's hints and its check know them whether or not he added them. */
export const withOwnWords = (
  entries: ReadonlyArray<VocabularyEntry>,
): ReadonlyArray<VocabularyEntry> => {
  const own = [...new Set([...OWN_HEARD.map((r) => r.to), ...OWN_PHRASES])].map((to) => ({
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
export const joinSplitTerms = (heard: string, entries: ReadonlyArray<VocabularyEntry>): string => {
  let text = heard;
  const terms = new Map<string, string>();
  for (const e of withOwnWords(entries)) {
    const term = e.replacement ?? e.phrase;
    const key = term.replace(/\s+/g, "").toLowerCase();
    if ((key.length >= 3 || /\p{N}/u.test(key)) && /^[\p{L}\p{N}]+$/u.test(key))
      terms.set(key, term);
  }
  if (terms.size === 0) return text;
  // The split form with a dotted acronym ("venture O.S.") is his word too, where the letters complete it.
  text = text.replace(
    /([\p{L}\p{N}]+) ((?:\p{L}\.){2,})/gu,
    (found: string, head: string, dotted: string) => {
      return terms.get(`${head}${dotted.replace(/\./g, "")}`.toLowerCase()) ?? found;
    },
  );
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
      // A phrase in small letters ("by the way") never takes a sentence's capital away.
      if (term === undefined || (term === term.toLowerCase() && found.toLowerCase() === term))
        continue;
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
  // A form that is itself one of his words stays: Wispr taught one word of his as a mis-hearing of another.
  const his = new Set(entries.map((e) => (e.replacement ?? e.phrase).toLowerCase()));
  let out = text;
  for (const e of entries)
    for (const form of e.heard ?? []) {
      if (!/^\p{L}+$/u.test(form) || everydayForm(form) || his.has(form.toLowerCase())) continue;
      const term = e.replacement ?? e.phrase;
      out = out.replace(
        new RegExp(`${WORD_START}${escapeRegExp(form)}${WORD_END}`, "giu"),
        (found: string, at: number, whole: string) => {
          // Written as a name ("Tessa" he corrected to Tessaya), it is his word wherever it stands.
          if (/^\p{Lu}/u.test(form) && /^\p{Lu}/u.test(found) && found !== found.toUpperCase())
            return term;
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

/**
 * A name the recogniser made up ("Tessa", "Tesla", "Zohayb") that sounds like one of his words on screen right now is that
 * word. Only capitalised words, so "button" stays for the model, which sees the sentence; with no screen, nothing.
 */
const applyScreenNames = (
  text: string,
  entries: ReadonlyArray<VocabularyEntry>,
  screen: ReadonlyArray<string>,
): string => {
  const shown = new Set(screen.map((w) => w.toLowerCase()));
  // A dictation that is only that name ("Tessa.") is his word, on screen or not: nobody dictates a stranger's name alone.
  const alone = /^\s*\p{Lu}[\p{L}\p{N}]*[.!?]?\s*$/u.test(text);
  const terms = withOwnWords(entries)
    .map((e) => e.replacement ?? e.phrase)
    .filter((t) => t.length >= 4 && (alone || shown.has(t.toLowerCase())));
  if (terms.length === 0) return text;
  return text.replace(
    new RegExp(`${WORD_START}\\p{Lu}[\\p{L}\\p{N}]*${WORD_END}`, "gu"),
    (word) => {
      if (shown.has(word.toLowerCase())) return word;
      const term = terms.find(
        (t) => soundsLike(word, t) && word[0]!.toLowerCase() === t[0]!.toLowerCase(),
      );
      return term ?? word;
    },
  );
};

/** What may follow a called name: the end, or a word that is not more of a noun phrase ("get me to say a few words"). */
const AFTER_CALL =
  /^(?:\s*(?:[,.!?;:]|$)|\s+(?:please|now|here|again|back|then|little|for|and)\b)/iu;
/** A whole turn that is only a mis-heard word to her: "This best." and "This miss." for "Dismissed." (Tessel, 15 Nov). */
const SPOKEN_ALONE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:this|dis|the) (?:best|miss|missed|mist|must)$/, "Dismissed."],
];

/**
 * The persona he calls, heard as several words ("get me to say a", "let's talk to T"): `nameAskedFor`, the one name
 * resolver the room uses too, decides who; here it is written in only where English cannot go on. Words said to her only.
 */
export const applyCalledNames = (text: string, names: ReadonlyArray<string>): string => {
  const called = names.filter((n) => /^\p{L}+$/u.test(n) && n.length >= 4);
  if (called.length === 0) return text;
  const plain = text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
  for (const [heard, to] of SPOKEN_ALONE) if (heard.test(plain)) return to;
  let out = "";
  let from = 0;
  for (const slot of text.matchAll(CALL_SLOT)) {
    const at = slot.index + slot[0].length;
    if (at < from) continue;
    const asked = nameAskedFor(text.slice(at), called);
    if (asked === null) continue;
    const words = [...text.slice(at).matchAll(/\S+/g)].slice(0, asked.words);
    const tail = /[.,!?;:]+$/.exec(words.at(-1)![0])?.[0] ?? "";
    const heard = words.map((w, i) =>
      i === words.length - 1 ? w[0].slice(0, w[0].length - tail.length) : w[0],
    );
    // A name's words are letters apart only by spaces ("T3 code" is not one).
    if (heard.some((w) => !/^\p{L}+$/u.test(w)) || heard.join("") === asked.name) continue;
    const end = at + words.at(-1)!.index + words.at(-1)![0].length - tail.length;
    if (!AFTER_CALL.test(text.slice(end))) continue;
    out += text.slice(from, at) + asked.name;
    from = end;
  }
  return out + text.slice(from);
};

export const biasTranscript = (
  heardText: string,
  entries: ReadonlyArray<VocabularyEntry>,
  context: {
    readonly screen?: ReadonlyArray<string>;
    /** The personas he can call, when these words were said to her (a voice turn), not dictated. */
    readonly names?: ReadonlyArray<string>;
  } = {},
): string => {
  const text = applyKnownNames(
    joinSplitTerms(
      applyScreenNames(
        applyTaughtForms(applyCalledNames(applyOwnNames(heardText), context.names ?? []), entries),
        entries,
        context.screen ?? [],
      ),
      entries,
    ),
    entries,
  );
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
    if (word.length < 5 || FIRST_NAMES.has(word.toLowerCase())) return word;
    for (const term of terms) {
      if (word === term || word[0]!.toLowerCase() !== term[0]!.toLowerCase()) continue;
      // A whole part of a compound term ("Alpha" of AlphaOS, up to its capital) is an ordinary word: "a new alpha"
      // is never AlphaOS, though "alphas" still is. A clipped spelling ("claud" for Claude) is not a part.
      const w = word.toLowerCase();
      const bare = term.toLowerCase();
      const boundary = (at: number) =>
        at > 0 && at < term.length && /[\p{Lu}\p{N}]/u.test(term[at]!);
      if (
        (bare.startsWith(w) && boundary(w.length)) ||
        (bare.endsWith(w) && boundary(term.length - w.length))
      )
        continue;
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
