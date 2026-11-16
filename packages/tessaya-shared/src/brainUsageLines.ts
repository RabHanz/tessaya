import type { BrainUsageCall, BrainUsageResult, BrainUsageTotal } from "@t3tools/tessaya-contracts";

export const USAGE_VIEWS = ["feature", "persona", "surface", "model", "day", "login"] as const;
export type UsageView = (typeof USAGE_VIEWS)[number];

export interface UsageLine {
  readonly key: string;
  readonly total: BrainUsageTotal;
  calls: number;
  tokens: number;
  /** API key dollars; null when the plan paid for all of it. */
  dollars: number | null;
}

type Keyed = Pick<
  BrainUsageCall,
  "role" | "credential" | "model" | "feature" | "persona" | "surface"
> & {
  readonly day?: string;
};

const keyOf = (view: UsageView, row: Keyed) =>
  view === "login"
    ? `${row.role}|${row.credential}|${row.model}`
    : view === "day"
      ? (row.day ?? "")
      : (row[view] ?? "");

/** One line per value of the chosen view over the whole range: days newest first, the rest costliest then busiest. */
export const usageLines = (
  totals: BrainUsageResult["totals"],
  view: UsageView,
): ReadonlyArray<UsageLine> => {
  const lines = new Map<string, UsageLine>();
  for (const t of totals) {
    const key = keyOf(view, t);
    const line = lines.get(key) ?? { key, total: t, calls: 0, tokens: 0, dollars: null };
    line.calls += t.calls;
    line.tokens += t.input + t.cacheRead + t.cacheWrite + t.output;
    if (t.dollars !== null) line.dollars = (line.dollars ?? 0) + t.dollars;
    lines.set(key, line);
  }
  return [...lines.values()].toSorted((a, b) =>
    view === "day"
      ? b.key.localeCompare(a.key)
      : (b.dollars ?? 0) - (a.dollars ?? 0) || b.calls - a.calls,
  );
};

/** The server filter for a line's calls; a null persona or surface can't be asked for, so `lineCalls` narrows. */
export const lineDetail = (view: UsageView, line: UsageLine) => {
  const t = line.total;
  if (view === "login") return { model: t.model };
  if (view === "day") return { day: t.day };
  const value = t[view];
  return value === null ? {} : { [view]: value };
};

/** The calls that belong to the line (the day is already exact on the server). */
export const lineCalls = (
  calls: ReadonlyArray<BrainUsageCall>,
  view: UsageView,
  line: UsageLine,
): ReadonlyArray<BrainUsageCall> =>
  view === "day" ? calls : calls.filter((call) => keyOf(view, call) === line.key);
