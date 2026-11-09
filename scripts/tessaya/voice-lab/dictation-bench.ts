// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Dictation's measure, read-only. `timing <voice-turns.ndjson> [--since T]`: key-up to paste at p50/p90/p99 by stage.
 * `score <pairs.jsonl> <arm.jsonl> [terms.json]`: an arm against Wispr's finals, WER on normalised words, with
 * punctuation, capitals and false insertions scored apart.
 */
import * as NodeFS from "node:fs";

const STAGES = ["releaseToPasteMs", "asrMs", "cleanupMs", "fitMs", "pasteMs"] as const;
type Stage = (typeof STAGES)[number];
type TimingLine = { readonly at?: string; readonly reused?: boolean | null } & Partial<
  Record<Stage, number | null>
>;

/** The value at quantile `q` of sorted numbers (nearest rank); null with none. */
const quantile = (sorted: ReadonlyArray<number>, q: number): number | null =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;

/** p50, p90 and p99 of each stage. Wispr budgets p99, so the tail is the number that matters. */
export const stageStats = (lines: ReadonlyArray<TimingLine>) =>
  Object.fromEntries(
    STAGES.map((stage) => {
      const ms = lines.flatMap((l) => (typeof l[stage] === "number" ? [l[stage]] : []));
      ms.sort((a, b) => a - b);
      return [
        stage,
        { n: ms.length, p50: quantile(ms, 0.5), p90: quantile(ms, 0.9), p99: quantile(ms, 0.99) },
      ];
    }),
  ) as Record<Stage, { n: number; p50: number | null; p90: number | null; p99: number | null }>;

const FILLERS = new Set(["um", "uh", "er", "erm", "ah", "hmm", "mm", "mhm", "mmm"]);
const NUMBER_WORDS: Readonly<Record<string, string>> = Object.fromEntries(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, String(i)]),
);

/**
 * Words for WER, the same on both sides, after Whisper's English normaliser in the parts that matter here: case,
 * punctuation, hyphens, fillers and small numbers, so formatting (Wispr's finals are formatted) never counts as a
 * hearing error.
 */
export const normalise = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[-–—/]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w !== "" && !FILLERS.has(w))
    .map((w) => NUMBER_WORDS[w] ?? w);

/** Word alignment by edit distance: the distance and the pairs of indices that matched. */
const align = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  const pairs: Array<[number, number]> = [];
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) pairs.unshift([(i -= 1), (j -= 1)]);
    else if (d[i]![j] === d[i - 1]![j]! + 1) i -= 1;
    else if (d[i]![j] === d[i]![j - 1]! + 1) j -= 1;
    else {
      i -= 1;
      j -= 1;
    }
  }
  return { distance: d[a.length]![b.length]!, pairs };
};

/** Each word as heard, with its capital and the mark after it (. , ? ! or none). */
const marked = (text: string) =>
  text
    .normalize("NFKC")
    .split(/\s+/)
    .flatMap((token) => {
      const words = normalise(token);
      if (words.length === 0) return [];
      const mark = /([.,?!;:])["')\]]*$/.exec(token)?.[1] ?? "";
      return words.map((word, i) => ({
        word,
        cap: i === 0 && /^\P{L}*\p{Lu}/u.test(token),
        mark: i === words.length - 1 ? mark.replace(/[;:]/, ",") : "",
      }));
    });

export interface Score {
  readonly words: number;
  readonly errors: number;
  readonly punctHit: number;
  readonly punctOurs: number;
  readonly punctTheirs: number;
  readonly capsSame: number;
  readonly capsSeen: number;
  readonly falseInsertions: number;
}

/**
 * One dictation against Wispr's final: WER on normalised words; on the words both have, punctuation (a mark after the
 * same word, the same mark) and capitals; and terms in ours that neither the recogniser nor Wispr had.
 */
export const scoreOne = (
  ours: string,
  wispr: string,
  raw: string,
  terms: ReadonlyArray<string> = [],
): Score => {
  const a = marked(ours);
  const b = marked(wispr);
  const { distance, pairs } = align(
    b.map((w) => w.word),
    a.map((w) => w.word),
  );
  let punctHit = 0;
  let capsSame = 0;
  for (const [i, j] of pairs) {
    if (b[i]!.mark !== "" && b[i]!.mark === a[j]!.mark) punctHit += 1;
    if (b[i]!.cap === a[j]!.cap) capsSame += 1;
  }
  // Spaced apart still counts ("Venture OS" for VentureOS), as Wispr writes some of his names.
  const has = (text: string, term: string) =>
    new RegExp(
      String.raw`(?<![\p{L}\p{N}])${[...term].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\s?`)}(?![\p{L}\p{N}])`,
      "iu",
    ).test(text);
  return {
    words: b.length,
    errors: distance,
    punctHit,
    punctOurs: pairs.filter(([, j]) => a[j]!.mark !== "").length,
    punctTheirs: pairs.filter(([i]) => b[i]!.mark !== "").length,
    capsSame,
    capsSeen: pairs.length,
    falseInsertions: terms.filter((t) => has(ours, t) && !has(raw, t) && !has(wispr, t)).length,
  };
};

/** The scores summed: WER and punctuation F1 in percent, capitals agreement in percent. */
export const summary = (scores: ReadonlyArray<Score>) => {
  const sum = (k: keyof Score) => scores.reduce((s, x) => s + x[k], 0);
  const p = sum("punctHit") / Math.max(1, sum("punctOurs"));
  const r = sum("punctHit") / Math.max(1, sum("punctTheirs"));
  const pct = (x: number) => Math.round(x * 1000) / 10;
  return {
    n: scores.length,
    wer: pct(sum("errors") / Math.max(1, sum("words"))),
    punctF1: pct(p + r === 0 ? 0 : (2 * p * r) / (p + r)),
    capitals: pct(sum("capsSame") / Math.max(1, sum("capsSeen"))),
    falseInsertions: sum("falseInsertions"),
  };
};

const jsonLines = <T>(file: string): T[] =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() === "" ? [] : [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });

const main = () => {
  const [step, a, b, c] = process.argv.slice(2);
  if (step === "timing" && a !== undefined) {
    const at = process.argv.indexOf("--since");
    const since = at < 0 ? "" : (process.argv[at + 1] ?? "");
    const lines = jsonLines<TimingLine & { kind?: string }>(a).filter(
      (l) => l.kind === "dictation_timing" && (l.at ?? "") >= since,
    );
    console.log(
      JSON.stringify(
        {
          dictations: lines.length,
          reused: lines.filter((l) => l.reused === true).length,
          ...stageStats(lines),
        },
        null,
        1,
      ),
    );
    return;
  }
  if (step === "score" && a !== undefined && b !== undefined) {
    const pairs = new Map(
      jsonLines<{ id: string; raw: string; wtext: string }>(a).map((r) => [r.id, r]),
    );
    const terms = c === undefined ? [] : (JSON.parse(NodeFS.readFileSync(c, "utf8")) as string[]);
    const scores = jsonLines<{ id: string; text: string }>(b).flatMap((o) => {
      const pair = pairs.get(o.id);
      return pair === undefined ? [] : [scoreOne(o.text, pair.wtext, pair.raw, terms)];
    });
    console.log(JSON.stringify(summary(scores)));
    return;
  }
  throw new Error(
    "timing <voice-turns.ndjson> [--since T] | score <pairs.jsonl> <arm.jsonl> [terms.json]",
  );
};

if (process.argv[1]?.endsWith("dictation-bench.ts")) main();
