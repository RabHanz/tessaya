/**
 * The tessaya-lines grader: what the model wrote for each moment, against the same gate the server applies
 * (`lineProblem`), plus how varied the batch is. Plain logic; run.test.ts covers it.
 */
import {
  LINE_EVENTS,
  keptLines,
  lineId,
  lineProblem,
  type Line,
  type LineEvent,
} from "../../packages/baton-shared/src/expression.ts";

export interface Written {
  readonly text: string;
  readonly mood: string;
  readonly gesture: string;
}

export interface MomentGrade {
  readonly event: LineEvent;
  readonly asked: number;
  readonly written: number;
  readonly kept: ReadonlyArray<Line>;
  /** Why each refused wording was refused, counted. */
  readonly problems: Readonly<Record<string, number>>;
  /** Wordings that lost, repeated or invented a fact slot: the one failure that would say a wrong fact. */
  readonly slotFailures: number;
  /** Wordings that dropped words a safety or approval line must keep. */
  readonly requiredFailures: number;
  /** Distinct wordings over all written (1 is all different). */
  readonly distinct: number;
  /** The largest share of kept wordings that open with the same two words (lower is livelier). */
  readonly sameOpening: number;
  /** Kept wordings that are just the plain line again. */
  readonly plainEchoes: number;
}

const opening = (text: string) =>
  text
    .toLowerCase()
    .replace(/\{[a-z]+\}/g, "{}")
    .split(/[^\p{L}{}']+/u)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");

export const gradeMoment = (
  event: LineEvent,
  asked: number,
  written: ReadonlyArray<Written>,
): MomentGrade => {
  const problems: Record<string, number> = {};
  let slotFailures = 0;
  let requiredFailures = 0;
  for (const w of written) {
    const problem = lineProblem(event, w as Line);
    if (problem === null) continue;
    problems[problem] = (problems[problem] ?? 0) + 1;
    if (/\{[a-z]+\}/.test(problem)) slotFailures += 1;
    if (problem.startsWith("leaves out")) requiredFailures += 1;
  }
  const kept = keptLines(event, written, []);
  const ids = new Set(written.map((w) => lineId(event, w.text)));
  const openings = new Map<string, number>();
  for (const k of kept) openings.set(opening(k.text), (openings.get(opening(k.text)) ?? 0) + 1);
  const fixed = lineId(event, LINE_EVENTS[event].fixed);
  return {
    event,
    asked,
    written: written.length,
    kept,
    problems,
    slotFailures,
    requiredFailures,
    distinct: written.length === 0 ? 0 : ids.size / written.length,
    sameOpening: kept.length === 0 ? 0 : Math.max(...openings.values()) / kept.length,
    plainEchoes: kept.filter((k) => lineId(event, k.text) === fixed).length,
  };
};

export interface Summary {
  readonly moments: number;
  readonly written: number;
  readonly keepRate: number;
  readonly slotFailureRate: number;
  readonly requiredFailures: number;
  readonly meanDistinct: number;
  readonly worstSameOpening: number;
  readonly plainEchoes: number;
  readonly pass: boolean;
}

/** Pre-set bars: most wordings usable, almost no fact-slot slips, no safety wording lost, and real variety. */
export const BARS = {
  keepRate: 0.8,
  slotFailureRate: 0.05,
  meanDistinct: 0.9,
  worstSameOpening: 0.5,
};

export const summarize = (grades: ReadonlyArray<MomentGrade>): Summary => {
  const written = grades.reduce((n, g) => n + g.written, 0);
  const kept = grades.reduce((n, g) => n + g.kept.length, 0);
  const slot = grades.reduce((n, g) => n + g.slotFailures, 0);
  const required = grades.reduce((n, g) => n + g.requiredFailures, 0);
  const meanDistinct =
    grades.length === 0 ? 0 : grades.reduce((n, g) => n + g.distinct, 0) / grades.length;
  const worstSameOpening = Math.max(0, ...grades.map((g) => g.sameOpening));
  const keepRate = written === 0 ? 0 : kept / written;
  const slotFailureRate = written === 0 ? 0 : slot / written;
  return {
    moments: grades.length,
    written,
    keepRate,
    slotFailureRate,
    requiredFailures: required,
    meanDistinct,
    worstSameOpening,
    plainEchoes: grades.reduce((n, g) => n + g.plainEchoes, 0),
    pass:
      keepRate >= BARS.keepRate &&
      slotFailureRate <= BARS.slotFailureRate &&
      meanDistinct >= BARS.meanDistinct &&
      worstSameOpening <= BARS.worstSameOpening,
  };
};
