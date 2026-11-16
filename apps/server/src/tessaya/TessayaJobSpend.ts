// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * What a job's worker has spent: its threads' provider turns (T3's own turn record), priced at read time with the
 * rate list T3's usage page already keeps on disk. A turn with no counts, or a model with no price, is "not measured",
 * never zero.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";

import { parseRateTable, priceUsage, type RateTable } from "../usage/usagePricing.ts";

/** The one price list: T3's usage page's rates and the day it fetched them (the price version on each usage row). */
export interface PriceList {
  readonly table: RateTable;
  /** "2026-11-14": the fetch day, so a row says which prices made its dollars. */
  readonly version: string;
}

/** The rate list T3's usage page keeps (usage-model-rates.json), or null before it has ever been fetched. */
export const readPriceList = (stateDir: string): PriceList | null => {
  try {
    const raw = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, "usage-model-rates.json"), "utf8"),
    ) as { document?: unknown; fetchedAtMs?: unknown };
    const table = parseRateTable(raw.document);
    const at = typeof raw.fetchedAtMs === "number" ? raw.fetchedAtMs : 0;
    return table.size > 0 ? { table, version: new Date(at).toISOString().slice(0, 10) } : null;
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
