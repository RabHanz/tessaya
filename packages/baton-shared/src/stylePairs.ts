/**
 * His own past dictations and the text he kept, as examples for the clean-up: the few most like the one in hand go into
 * its prompt, so the model writes the way he does (lists, punctuation, register) rather than its own way. Pure and
 * local: a word-overlap index built in memory, no model and no dependency.
 *
 * @module batonStylePairs
 */
import { LIST_CUE, modeForApp, type DictationMode } from "./dictationCleanup.ts";

export interface StylePair {
  /** What the recogniser heard. */
  readonly raw: string;
  /** What he kept: his edit of it, or the final he let stand. */
  readonly kept: string;
  readonly mode: DictationMode;
  /** Where it came from (a Wispr transcript id, a History row), so a measure can leave a row's own pair out. */
  readonly id?: string;
}

const STOP = new Set(
  "the a an and or but so to of in on at for with is are was were be been it its this that these those i you he she we they me my your our their do does did not no yes just like".split(
    " ",
  ),
);

const terms = (text: string): ReadonlyArray<string> => {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => !STOP.has(w));
  return [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
};

/** Cosine over tf-idf of words and word pairs, with the same writing mode counted a little closer. */
export const makeStyleIndex = (pairs: ReadonlyArray<StylePair>) => {
  const docs = pairs.map((p) => terms(p.raw));
  const df = new Map<string, number>();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log((1 + pairs.length) / (1 + (df.get(t) ?? 0)));
  const vector = (doc: ReadonlyArray<string>) => {
    const v = new Map<string, number>();
    for (const t of doc) v.set(t, (v.get(t) ?? 0) + idf(t));
    const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
    for (const [t, x] of v) v.set(t, x / norm);
    return v;
  };
  const postings = new Map<string, Array<readonly [number, number]>>();
  docs.forEach((doc, i) => {
    for (const [t, w] of vector(doc)) {
      const list = postings.get(t) ?? [];
      list.push([i, w]);
      postings.set(t, list);
    }
  });
  return {
    size: pairs.length,
    /** Up to `count` pairs most like `text`, best first; never `text` itself, nor the pair `except` names. */
    nearest: (
      text: string,
      mode: DictationMode,
      count = 4,
      except?: string,
    ): ReadonlyArray<StylePair> => {
      const scores = new Map<number, number>();
      for (const [t, w] of vector(terms(text)))
        for (const [i, dw] of postings.get(t) ?? []) scores.set(i, (scores.get(i) ?? 0) + w * dw);
      const said = text.trim();
      // A list or paragraphs he kept teach layout only where he announced a list: shown with plain prose, they
      // taught the model to break prose he left whole (8 of 40 long dictations).
      const shaped = LIST_CUE.test(said);
      return [...scores]
        .map(([i, s]) => [i, pairs[i]!.mode === mode ? s * 1.2 : s] as const)
        .filter(
          ([i, s]) =>
            s >= 0.08 &&
            pairs[i]!.raw.trim() !== said &&
            (except === undefined || pairs[i]!.id !== except) &&
            (shaped || !pairs[i]!.kept.includes("\n")),
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, count)
        .map(([i]) => pairs[i]!);
    },
  };
};

/** Wispr's list markup as the plain text a paste puts in a field: "1. " for an ordered list, "- " otherwise. */
const plainLists = (text: string): string =>
  text
    .replace(/<(ol|ul)>([\s\S]*?)<\/\1>/g, (_, kind: string, body: string) =>
      [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)]
        .map((m, i) => `${kind === "ol" ? `${i + 1}.` : "-"} ${m[1]!.trim()}`)
        .join("\n"),
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export interface WisprHistoryRow {
  readonly transcriptEntityId: string | null;
  readonly asrText: string | null;
  readonly formattedText: string | null;
  readonly editedText: string | null;
  readonly app: string | null;
  readonly url: string | null;
}

const present = (text: string | null): text is string =>
  text !== null && text.trim() !== "" && text !== "None";

/** His Wispr history as pairs: what it heard, and his edit of the result or the result he kept. Newest last. */
export const pairsFromWispr = (rows: ReadonlyArray<WisprHistoryRow>): ReadonlyArray<StylePair> =>
  rows.flatMap((row) => {
    const kept = present(row.editedText) ? row.editedText : row.formattedText;
    if (!present(row.asrText) || !present(kept)) return [];
    const words = row.asrText.split(/\s+/).length;
    // A word or two teaches nothing about style, and a very long one costs the prompt more than it shows.
    if (words < 4 || words > 120) return [];
    return [
      {
        raw: row.asrText.trim(),
        kept: plainLists(kept),
        mode: modeForApp({ exe: row.app ?? "", title: row.url ?? "" }),
        ...(row.transcriptEntityId === null ? {} : { id: row.transcriptEntityId }),
      },
    ];
  });
