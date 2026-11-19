/**
 * Her motion library (M-081): performances that passed every check, indexed by the words that asked for them. A
 * model that can only say what it wants gives an `intent`, and her body plays the nearest entry. Entries are data
 * (`bodyMotionLibrary.ts`, grown by the direction eval's harvest); this module only ranks them.
 */

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

/**
 * The best entry for an intent by BM25 over the entries' words, or null when nothing shares enough of its meaning.
 * shortcut: words, not sentence vectors; move to the memory embedder (bge-small) once its model ships on the server.
 */
export const recall = (
  intent: string,
  library: ReadonlyArray<MotionEntry>,
): { readonly entry: MotionEntry; readonly score: number } | null => {
  const q = [...new Set(wordsOf(intent))];
  if (q.length === 0 || library.length === 0) return null;
  const docs = library.map((e) => wordsOf(e.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const df = (w: string) => docs.filter((d) => d.includes(w)).length;
  let best: { entry: MotionEntry; score: number } | null = null;
  docs.forEach((d, i) => {
    let s = 0;
    for (const w of q) {
      const tf = d.filter((x) => x === w).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - df(w) + 0.5) / (df(w) + 0.5));
      s += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg));
    }
    // the judge's score breaks ties between equally near entries
    s += 0.01 * library[i]!.score;
    if (best === null || s > best.score) best = { entry: library[i]!, score: s };
  });
  return best !== null && (best as { score: number }).score >= 1 ? best : null;
};
