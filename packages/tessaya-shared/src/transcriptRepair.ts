/**
 * Transcript repair (VOXTA-STUDY G2, V-018): the recogniser's per-word confidence decides whether a turn is taken as
 * heard, one doubtful word is checked ("did you say Sara?"), the turn is asked again, or it is dropped. Only a content
 * word (a name or a number) earns a question; a doubtful "the" changes nothing. Unscored means unknown, never certain,
 * and a recogniser with no calibrated bounds keeps the feature off, except that a turn of pure noise is always dropped.
 */

/** One word as the recogniser heard it: `p` is its weakest sub-token's confidence (0..1), null when it gave none. */
export interface HeardWord {
  readonly text: string;
  readonly p: number | null;
}

/**
 * A recogniser's calibrated bounds: at or above `accept` a word is taken as heard, below `reject` it was not heard at
 * all. Both zero is an uncalibrated recogniser, and repair stays off for it.
 */
export interface RepairBounds {
  readonly accept: number;
  readonly reject: number;
}

export const UNCALIBRATED: RepairBounds = { accept: 0, reject: 0 };

/**
 * Each recogniser model's bounds (its file name), calibrated on his own recorded turns; one not listed keeps repair
 * off. Parakeet TDT v3 Q8 on his 39 dictation clips (16 Nov, 810 words): median 1.0, 5th percentile 0.92; 12 of the 19
 * words under 0.85 were "Tessaya" misheard (Tese 0.69, Say 0.60, Tessa 0.58), the rest function words.
 * shortcut: `reject` has no noise clips behind it yet; set it from the room's dropped turns once they are logged.
 */
const PARAKEET_TDT_V3: RepairBounds = { accept: 0.85, reject: 0.3 };
const REPAIR_BOUNDS: Readonly<Record<string, RepairBounds>> = {
  "parakeet-tdt-0.6b-v3-Q8_0": PARAKEET_TDT_V3,
  // The recogniser service's install name for the same file (deploy/*.service).
  tdt: PARAKEET_TDT_V3,
};

export const repairBoundsFor = (recogniser: string | undefined): RepairBounds =>
  (recogniser === undefined ? undefined : REPAIR_BOUNDS[recogniser]) ?? UNCALIBRATED;

export type RepairVerdict =
  | { readonly kind: "accept" }
  | { readonly kind: "clarify"; readonly word: string; readonly index: number }
  | { readonly kind: "repeat"; readonly doubtful: ReadonlyArray<string> }
  | { readonly kind: "drop"; readonly reason: "noise" | "unheard" };

/** What a breath, a cough or a room sound comes out as: a bracketed tag, a filler or punctuation alone. */
const NOISE_WORD = /^(?:\[[^\]]*\]|\([^)]*\)|u+h+|u+m+|m+|h+m+|e+r+m*|[.,!?…-]+)$/;
const NUMBER_WORD =
  /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|quarter|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/;

const bare = (text: string) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

const isNoise = (text: string) => {
  const t = text.trim().toLowerCase();
  return t === "" || NOISE_WORD.test(t) || NOISE_WORD.test(bare(t));
};

/**
 * A name or a number: digits, a number word, a word in `names` (his people, places and personas), or a capitalised
 * word that does not start a sentence ("I" aside).
 */
export const isContentWord = (
  words: ReadonlyArray<HeardWord>,
  index: number,
  names: ReadonlySet<string> = new Set(),
): boolean => {
  const word = bare(words[index]?.text ?? "");
  if (word === "") return false;
  const lower = word.toLowerCase();
  if (/\p{N}/u.test(word) || NUMBER_WORD.test(lower) || names.has(lower)) return true;
  const startsSentence = index === 0 || /[.?!]$/.test(words[index - 1]!.text.trim());
  return !startsSentence && word !== "I" && /^\p{Lu}/u.test(word);
};

export const repairVerdict = (
  words: ReadonlyArray<HeardWord>,
  bounds: RepairBounds,
  names?: ReadonlySet<string>,
): RepairVerdict => {
  const real = words.flatMap((w, index) => (isNoise(w.text) ? [] : [{ ...w, index }]));
  if (real.length === 0) return { kind: "drop", reason: "noise" };
  const calibrated = bounds.accept > 0 || bounds.reject > 0;
  const scored = real.filter((w) => w.p !== null && Number.isFinite(w.p));
  if (!calibrated || scored.length === 0) return { kind: "accept" };
  if (scored.length === real.length && scored.every((w) => w.p! < bounds.reject))
    return { kind: "drop", reason: "unheard" };
  const doubtful = real.filter(
    (w) =>
      (w.p === null || !Number.isFinite(w.p) || w.p < bounds.accept) &&
      isContentWord(words, w.index, names),
  );
  if (doubtful.length === 0) return { kind: "accept" };
  const one = doubtful.length === 1 ? doubtful[0]! : null;
  if (one !== null && (one.p === null || one.p >= bounds.reject))
    return { kind: "clarify", word: bare(one.text), index: one.index };
  return { kind: "repeat", doubtful: doubtful.map((w) => bare(w.text)) };
};

/**
 * The line for her brain on a turn not taken as heard: she says it in her own words, in her own voice, and acts on
 * nothing that rests on the doubtful word. Empty for a turn taken as heard (and a dropped one never reaches her).
 */
export const repairLine = (verdict: RepairVerdict, said: string): string => {
  if (verdict.kind === "clarify")
    return `You did not catch one word of this turn for sure: "${verdict.word}" in ${JSON.stringify(said)}. Reply only by checking that word in a few words of your own (did they say ${verdict.word}?). Call no tool and change nothing this turn: wait for their answer.`;
  if (verdict.kind === "repeat")
    return `You did not hear this turn clearly (${JSON.stringify(said)}). Reply only by asking them to say it again, in a few words of your own. Call no tool and change nothing this turn.`;
  return "";
};
