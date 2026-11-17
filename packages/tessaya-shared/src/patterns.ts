/**
 * Patterns and predictions without a model (M-027): routines per hour of the week, EWMA z-scores for unusual hours, a
 * Markov chain whose next-event predictions are scored (calibration), and a change-point on daily volume. Incremental,
 * plain JSON. The statistics find; the pulse's model only explains.
 */

export interface PatternStats {
  /** key -> 168 counts (weekday * 24 + hour). */
  readonly routine: Readonly<Record<string, ReadonlyArray<number>>>;
  /** Events per hour of the week: EWMA mean and variance, and the hour being counted. */
  readonly hourly: {
    readonly mean: ReadonlyArray<number>;
    readonly variance: ReadonlyArray<number>;
    readonly bucket: number;
    readonly count: number;
  };
  /** from -> to -> count. */
  readonly transitions: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly last: string | null;
  /** The open prediction, scored by the next event. */
  readonly predicted: { readonly key: string; readonly p: number } | null;
  /** Calibration: per confidence decile, [predictions, hits]; plus the running Brier sum and count. */
  readonly calibration: ReadonlyArray<readonly [number, number]>;
  readonly brier: { readonly sum: number; readonly n: number };
  /** Events per day, newest last, 28 days. */
  readonly days: ReadonlyArray<{ readonly day: number; readonly n: number }>;
}

export const EMPTY_STATS: PatternStats = {
  routine: {},
  hourly: { mean: Array(168).fill(0), variance: Array(168).fill(0), bucket: -1, count: 0 },
  transitions: {},
  last: null,
  predicted: null,
  calibration: Array.from({ length: 10 }, () => [0, 0] as const),
  brier: { sum: 0, n: 0 },
  days: [],
};

const ALPHA = 0.1;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_KEYS = 60;

/** Hour of the week for a time, given his local weekday (0 Sunday) and hour. */
export type LocalClock = (at: number) => { readonly weekday: number; readonly hour: number };

const slot = (clock: LocalClock, at: number) => {
  const { weekday, hour } = clock(at);
  return weekday * 24 + hour;
};

/** The likeliest next key after `from`, with its probability and support. */
export const predictNext = (
  stats: PatternStats,
  from: string,
): { readonly key: string; readonly p: number; readonly n: number } | null => {
  const row = stats.transitions[from];
  if (row === undefined) return null;
  const n = Object.values(row).reduce((a, b) => a + b, 0);
  const [key, c] = Object.entries(row).reduce((b, e) => (e[1] > b[1] ? e : b), ["", 0]);
  return n === 0 ? null : { key, p: c / n, n };
};

/** The key a Record row is counted under, or null for her own bookkeeping rows. */
export const keyOfRow = (row: {
  readonly kind: string;
  readonly outcome: string;
  readonly actor?: string;
}): string | null =>
  row.kind === "pulse" ||
  row.kind === "brain_spend" ||
  row.kind === "turn_trace" ||
  // A replay's or our test playback's turn is not his use of her.
  /-(?:replay|playback)$/.test(row.actor ?? "")
    ? null
    : `${row.kind}:${row.outcome}`.slice(0, 60);

/** Folds one event in: routine, hourly volume, transition, prediction score, daily count. */
export const observe = (
  stats: PatternStats,
  key: string,
  at: number,
  clock: LocalClock,
): PatternStats => {
  const s = slot(clock, at);
  const known = stats.routine[key] !== undefined || Object.keys(stats.routine).length < MAX_KEYS;
  const routine = known
    ? {
        ...stats.routine,
        [key]: (stats.routine[key] ?? Array(168).fill(0)).map((c, i) => (i === s ? c + 1 : c)),
      }
    : stats.routine;
  // The hour bucket closes when a later hour's event arrives: its count updates that slot's EWMA.
  const bucket = Math.floor(at / HOUR);
  let hourly = stats.hourly;
  if (bucket !== hourly.bucket) {
    if (hourly.bucket >= 0) hourly = closeHour(hourly, slot(clock, hourly.bucket * HOUR));
    hourly = { ...hourly, bucket, count: 1 };
  } else hourly = { ...hourly, count: hourly.count + 1 };
  // Score the open prediction against what happened.
  let { calibration, brier } = stats;
  if (stats.predicted !== null) {
    const hit = stats.predicted.key === key ? 1 : 0;
    const d = Math.min(9, Math.floor(stats.predicted.p * 10));
    calibration = calibration.map((c, i) => (i === d ? [c[0] + 1, c[1] + hit] : c));
    brier = { sum: brier.sum + (stats.predicted.p - hit) ** 2, n: brier.n + 1 };
  }
  const transitions =
    stats.last === null
      ? stats.transitions
      : {
          ...stats.transitions,
          [stats.last]: {
            ...stats.transitions[stats.last],
            [key]: (stats.transitions[stats.last]?.[key] ?? 0) + 1,
          },
        };
  const day = Math.floor(at / DAY);
  const lastDay = stats.days.at(-1);
  const days =
    lastDay?.day === day
      ? [...stats.days.slice(0, -1), { day, n: lastDay.n + 1 }]
      : [...stats.days, { day, n: 1 }].filter((d) => day - d.day < 28);
  const next = { ...stats, routine, hourly, transitions, last: key, calibration, brier, days };
  const guess = predictNext(next, key);
  return { ...next, predicted: guess === null ? null : { key: guess.key, p: guess.p } };
};

const closeHour = (h: PatternStats["hourly"], s: number): PatternStats["hourly"] => {
  const m = h.mean[s] ?? 0;
  const diff = h.count - m;
  return {
    ...h,
    mean: h.mean.map((x, i) => (i === s ? m + ALPHA * diff : x)),
    variance: h.variance.map((v, i) => (i === s ? (1 - ALPHA) * (v + ALPHA * diff * diff) : v)),
  };
};

export interface Finding {
  readonly id: string;
  readonly text: string;
  /** 0 to 1. */
  readonly confidence: number;
}

/** How well predictions have held up: Brier score (lower is better) and how many were scored. */
export const calibrationOf = (stats: PatternStats) => ({
  brier: stats.brier.n === 0 ? null : stats.brier.sum / stats.brier.n,
  scored: stats.brier.n,
  hitRate:
    stats.brier.n === 0
      ? null
      : stats.calibration.reduce((a, c) => a + c[1], 0) / Math.max(1, stats.brier.n),
});

/**
 * What the statistics say now: an unusually busy hour (z >= 3 against that hour's own history), a sequence that
 * reliably follows (p >= 0.6 over >= 5), a weekly routine (one key in one hour of the week on >= 4 occasions and
 * >= 50% of its uses), and a change in daily volume (last 7 days against the 21 before, >= 2.5 standard errors).
 * Confidence is shrunk by how well predictions have scored, so a poorly calibrated model speaks less.
 */
export const findings = (stats: PatternStats, now: number, clock: LocalClock): Finding[] => {
  const out: Finding[] = [];
  const trust = (() => {
    const b = calibrationOf(stats).brier;
    return b === null || stats.brier.n < 20 ? 0.8 : Math.max(0.3, 1 - b);
  })();
  const s = slot(clock, now);
  const m = stats.hourly.mean[s] ?? 0;
  const sd = Math.sqrt(stats.hourly.variance[s] ?? 0);
  if (stats.hourly.bucket === Math.floor(now / HOUR) && sd > 0 && m > 0.5) {
    const z = (stats.hourly.count - m) / sd;
    if (z >= 3)
      out.push({
        id: `stat:busy:${Math.floor(now / HOUR)}`,
        text: `An unusually busy hour: ${stats.hourly.count} events against about ${m.toFixed(1)} usually (z ${z.toFixed(1)}).`,
        confidence: Math.min(0.9, 0.5 + z / 10) * trust,
      });
  }
  for (const from of Object.keys(stats.transitions)) {
    const next = predictNext(stats, from);
    if (next !== null && next.n >= 5 && next.p >= 0.6 && next.key !== from)
      out.push({
        id: `stat:seq:${from}>${next.key}`,
        text: `After "${from}", "${next.key}" usually follows (${Math.round(next.p * 100)}% of ${next.n}).`,
        confidence: Math.min(0.9, next.p * Math.min(1, next.n / 10)) * trust,
      });
  }
  for (const [key, counts] of Object.entries(stats.routine)) {
    const total = counts.reduce((a, b) => a + b, 0);
    const best = counts.reduce((b, c, i) => (c > (counts[b] ?? 0) ? i : b), 0);
    const c = counts[best] ?? 0;
    if (c >= 4 && c / total >= 0.5)
      out.push({
        id: `stat:routine:${key}:${best}`,
        text: `"${key}" is a routine: ${c} of ${total} times on ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Math.floor(best / 24)]} around ${best % 24}:00.`,
        confidence: Math.min(0.9, (c / total) * Math.min(1, c / 6)) * trust,
      });
  }
  const today = Math.floor(now / DAY);
  const byDay = (from: number, to: number) =>
    Array.from(
      { length: to - from },
      (_, i) => stats.days.find((d) => d.day === today - to + 1 + i)?.n ?? 0,
    );
  const recent = byDay(0, 7);
  const before = byDay(7, 28);
  if (stats.days.length >= 14) {
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const mb = mean(before);
    const sdb = Math.sqrt(mean(before.map((x) => (x - mb) ** 2)));
    const se = sdb / Math.sqrt(7);
    const mr = mean(recent);
    if (se > 0 && Math.abs(mr - mb) / se >= 2.5)
      out.push({
        id: `stat:change:${today}`,
        text: `Activity ${mr > mb ? "rose" : "fell"} this week: about ${mr.toFixed(0)} a day against ${mb.toFixed(0)} before.`,
        confidence: 0.7 * trust,
      });
  }
  return out;
};
