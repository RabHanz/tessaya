/**
 * Her motion library (M-081): performances that passed every check, indexed by the words that asked for them. A
 * model that can only say what it wants gives an `intent`, and her body plays the nearest entry. Entries are data
 * (`bodyMotionLibrary.ts`, grown by the direction eval's harvest); this module only ranks them.
 */

/** What a weaker model is told about her body (M-081's lower tier): name the motion, and her library performs it. */
export const BODY_INTENT_TIER =
  "Your body: when he directs it, call tessaya_body_state to see her `motions`, then tessaya_body_move with only `intent`: the listed motion nearest to what he asked, or a few plain words. Her body knows how to perform it.";
/** Models that do better naming a library motion than composing one (measured: Haiku 22% alone, 32% with the library). */
export const usesBodyIntents = (model: string): boolean => /haiku|flash|mini|nano/i.test(model);

export interface MotionEntry {
  readonly id: string;
  /** The direction that produced it, in his words. */
  readonly text: string;
  /** The move as the body control language takes it (bodyControl `BodyMove`, raw). */
  readonly move: Readonly<Record<string, unknown>>;
  /** The judge's score (1..5) when it was harvested. */
  readonly score: number;
  readonly source: string;
}

const STOP = new Set(
  "a an the you your me my i to of and or like as if it its is are be on in at for with just really so some someone something how would what that this up down out show act pretend give get make let now very bit little".split(
    " ",
  ),
);
/** Words to compare: lower case, no stop words, a crude stem (cheering, cheered, cheers → cheer). */
export const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/'s\b|n't\b/g, "")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, "").replace(/(.)\1$/, "$1"));

/** Every entry's BM25 score for an intent (the judge's score breaks ties), highest first, zeros left out. */
export const ranked = (
  intent: string,
  library: ReadonlyArray<MotionEntry>,
): ReadonlyArray<{ readonly entry: MotionEntry; readonly score: number }> => {
  const q = [...new Set(wordsOf(intent))];
  if (q.length === 0 || library.length === 0) return [];
  const docs = library.map((e) => wordsOf(e.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const df = (w: string) => docs.filter((d) => d.includes(w)).length;
  return docs
    .map((d, i) => {
      let s = 0;
      for (const w of q) {
        const tf = d.filter((x) => x === w).length;
        if (tf === 0) continue;
        const idf = Math.log(1 + (docs.length - df(w) + 0.5) / (df(w) + 0.5));
        s += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg));
      }
      return { entry: library[i]!, score: s > 0 ? s + 0.01 * library[i]!.score : 0 };
    })
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score);
};

/** The best entry for an intent by its words (BM25), or null when nothing shares enough of its meaning. */
export const recall = (
  intent: string,
  library: ReadonlyArray<MotionEntry>,
): { readonly entry: MotionEntry; readonly score: number } | null => {
  const best = ranked(intent, library)[0];
  return best !== undefined && best.score >= 1 ? best : null;
};

/** Cosine at or above this between bge-small sentence vectors reads as the same action (unrelated pairs sit near 0.5). */
export const MEANING_FLOOR = 0.72;

/**
 * The best entry by meaning and words together: the nearest sentence vector at or above the floor, fused with the BM25
 * ranking by reciprocal rank, so "show me you're worried sick" finds the hand-wringing entry that shares none of its
 * words. Pure: `query` and `vectors` (by entry id, unit length) come from the memory embedder; without them, words only.
 */
export const recallByMeaning = (
  intent: string,
  library: ReadonlyArray<MotionEntry>,
  query: Float32Array | null,
  vectors: ReadonlyMap<string, Float32Array>,
): MotionEntry | null => {
  if (query === null) return recall(intent, library)?.entry ?? null;
  const dot = (a: Float32Array, b: Float32Array) => a.reduce((n, x, i) => n + x * (b[i] ?? 0), 0);
  const near = library
    .flatMap((e) => {
      const v = vectors.get(e.id);
      return v === undefined ? [] : [{ entry: e, score: dot(query, v) }];
    })
    .filter((x) => x.score >= MEANING_FLOOR)
    .toSorted((a, b) => b.score - a.score);
  const words = ranked(intent, library).filter((x) => x.score >= 1);
  const fused = new Map<string, { entry: MotionEntry; score: number }>();
  for (const list of [near, words])
    list.forEach(({ entry }, rank) => {
      const was = fused.get(entry.id);
      fused.set(entry.id, { entry, score: (was?.score ?? 0) + 1 / (60 + rank + 1) });
    });
  return [...fused.values()].toSorted((a, b) => b.score - a.score)[0]?.entry ?? null;
};
