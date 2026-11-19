// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * What a job's worker has spent: its threads' provider turns (T3's own turn record), priced at read time with the
 * rate list T3's usage page already keeps on disk. A turn with no counts, or a model with no price, is "not measured",
 * never zero.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import type { BrainUsageUnit } from "@t3tools/tessaya-contracts";
import * as DateTime from "effect/DateTime";

import { parseRateTable, priceUsage, type RateTable } from "../usage/usagePricing.ts";

/** The one price list: T3's usage page's rates and the day it fetched them (the price version on each usage row). */
export interface PriceList {
  readonly table: RateTable;
  /** "2026-11-14": the fetch day, so a row says which prices made its dollars. */
  readonly version: string;
}

let priceListCache: {
  readonly file: string;
  readonly stamp: string;
  readonly list: PriceList | null;
} | null = null;

/** The rate list T3's usage page keeps (usage-model-rates.json), or null before it has ever been fetched. */
export const readPriceList = (stateDir: string): PriceList | null => {
  const file = NodePath.join(stateDir, "usage-model-rates.json");
  try {
    // Usage rows price on every record; the file changes about once a day, so parse only when it does.
    const stat = NodeFS.statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (priceListCache?.file === file && priceListCache.stamp === stamp) return priceListCache.list;
    const raw = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
      document?: unknown;
      fetchedAtMs?: unknown;
    };
    const table = parseRateTable(raw.document);
    const at = typeof raw.fetchedAtMs === "number" ? raw.fetchedAtMs : 0;
    const list =
      table.size > 0 ? { table, version: new Date(at).toISOString().slice(0, 10) } : null;
    priceListCache = { file, stamp, list };
    return list;
  } catch {
    return null;
  }
};

export interface Spend {
  readonly tokens: number;
  /** Null when no part could be priced. */
  readonly dollars: number | null;
  /** Some turn reported no counts or some model had no price, so the figure is a floor. */
  readonly partial: boolean;
}

/** A job's spend from its threads' finished provider turns, at the list price of each turn's model. */
export const spendOfTurns = (
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "status" | "turnTokenUsage" | "model">>,
  rates: RateTable | null,
): Spend => {
  let tokens = 0;
  let dollars: number | null = null;
  let partial = false;
  for (const turn of turns) {
    if (turn.status === "pending" || turn.status === "running") continue;
    const usage = turn.turnTokenUsage;
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      partial = true;
      continue;
    }
    if (usage.usageStatus !== "complete") partial = true;
    // Input counts the cache reads and writes; output counts the reasoning.
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    tokens += usage.inputTokens + usage.outputTokens;
    const model = turn.model ?? usage.models?.[0];
    const priced =
      rates === null || model === undefined
        ? null
        : priceUsage(rates, {
            model,
            totals: {
              uncachedInputTokens: Math.max(
                0,
                usage.inputTokens - cachedInputTokens - cacheCreationTokens,
              ),
              cachedInputTokens,
              cacheCreationTokens,
              outputTokens: usage.outputTokens,
              reasoningTokens: 0,
            },
            speed: "standard",
            reportedCostUsd: null,
          });
    if (priced === null || priced.costSource === "unpriced") partial = true;
    else dollars = (dollars ?? 0) + priced.costUsd;
  }
  return { tokens, dollars, partial };
};

type TurnRun = {
  readonly turn: Pick<
    OrchestrationV2ProviderTurn,
    "id" | "status" | "turnTokenUsage" | "model" | "completedAt"
  >;
  readonly runId: string | null;
  readonly scheduledTaskId: string | null;
};

/** One job's provider turns, each with its run and the scheduled task that started that run, if one did. */
export interface JobTurns {
  readonly id: string;
  readonly label: string;
  readonly turns: ReadonlyArray<TurnRun>;
}

/**
 * Each job's and each schedule's provider turns finished since `since`, at list price; a schedule is the runs its
 * task started in the job's thread. shortcut: a turn's login is not known here, so it carries `listDollars`, never
 * API dollars; read the instance's billing if jobs ever run on an API key.
 */
export const turnUnits = (
  jobs: ReadonlyArray<JobTurns>,
  since: number,
  rates: RateTable | null,
): ReadonlyArray<BrainUsageUnit> => {
  const groups = new Map<
    string,
    { kind: BrainUsageUnit["kind"]; id: string; label: string; turns: Array<TurnRun> }
  >();
  const add = (kind: BrainUsageUnit["kind"], id: string, label: string, turn: TurnRun) => {
    const group = groups.get(`${kind}:${id}`) ?? { kind, id, label, turns: [] };
    group.turns.push(turn);
    groups.set(`${kind}:${id}`, group);
  };
  for (const job of jobs) {
    for (const t of job.turns) {
      if (t.turn.completedAt === null || DateTime.toEpochMillis(t.turn.completedAt) < since)
        continue;
      add("job", job.id, job.label, t);
      if (t.scheduledTaskId !== null)
        add("schedule", t.scheduledTaskId, `${job.label} (scheduled)`, t);
    }
  }
  return [...groups.values()].map(({ kind, id, label, turns }) => {
    const spend = spendOfTurns(
      turns.map((t) => t.turn),
      rates,
    );
    return {
      kind,
      id,
      label,
      runs: new Set(turns.map((t) => t.runId ?? t.turn.id)).size,
      calls: turns.length,
      tokens: spend.tokens,
      dollars: null,
      listDollars: spend.dollars,
    };
  });
};

const plus = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);

/** The ledger's units and the turns' as one line per job or schedule, costliest first. */
export const mergeUnits = (
  ledger: ReadonlyArray<BrainUsageUnit>,
  turns: ReadonlyArray<BrainUsageUnit>,
): ReadonlyArray<BrainUsageUnit> => {
  const out = new Map(turns.map((u) => [`${u.kind}:${u.id}`, u]));
  for (const u of ledger) {
    const t = out.get(`${u.kind}:${u.id}`);
    out.set(
      `${u.kind}:${u.id}`,
      t === undefined
        ? u
        : {
            ...t,
            calls: t.calls + u.calls,
            tokens: t.tokens + u.tokens,
            dollars: plus(t.dollars, u.dollars),
            listDollars: plus(t.listDollars, u.listDollars),
          },
    );
  }
  return [...out.values()].toSorted(
    (a, b) => (b.listDollars ?? 0) - (a.listDollars ?? 0) || b.tokens - a.tokens,
  );
};
