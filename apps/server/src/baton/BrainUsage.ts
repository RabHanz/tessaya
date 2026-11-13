// @effect-diagnostics nodeBuiltinImport:off
/**
 * Every model call the brain makes writes one row (BRAIN-DESIGN §13.3, B1d): role, provider, login, model, tokens,
 * and dollars at list price when an API key paid (a subscription row says null: the plan paid). The first slice of
 * ACCOUNTS-IDENTITY C-2's usage ledger, not a second ledger. A failed write is logged and never fails the call.
 */
import * as NodePath from "node:path";

import { credentialOf } from "@t3tools/baton-shared/brainRoutes";
import type { BrainCredential, BrainRole } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { priceUsage, type RateTable } from "../usage/usagePricing.ts";
import * as BatonDatabase from "./BatonDatabase.ts";
import { readRates } from "./BatonJobSpend.ts";

/** One call's tokens on one model. `input` is the uncached part, as the API counts it. */
export interface CallTokens {
  readonly model: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface UsageRow extends CallTokens {
  readonly role: BrainRole;
  readonly credential: BrainCredential;
}

/** One day's use of one model by one role on one login, the day in the asker's time zone. */
export interface UsageTotal {
  readonly day: string;
  readonly role: string;
  readonly credential: string;
  readonly model: string;
  readonly calls: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** API key rows only; null when none were priced. */
  readonly dollars: number | null;
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** The Messages API's `usage` (a whole response, or a stream's `message_start` and last `message_delta` merged). */
export const apiTokens = (model: string, usage: unknown): CallTokens | null => {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return {
    model,
    input: count(u["input_tokens"]),
    cacheRead: count(u["cache_read_input_tokens"]),
    cacheWrite: count(u["cache_creation_input_tokens"]),
    output: count(u["output_tokens"]),
  };
};

/**
 * Claude Code's `result` event: `modelUsage` per resolved model id (a turn can use more than one), else its `usage`
 * under the model it was asked for.
 */
export const cliTokens = (result: unknown, asked: string): ReadonlyArray<CallTokens> => {
  if (typeof result !== "object" || result === null) return [];
  const r = result as Record<string, unknown>;
  const perModel = r["modelUsage"];
  if (typeof perModel === "object" && perModel !== null) {
    const rows = Object.entries(perModel as Record<string, Record<string, unknown>>).map(
      ([model, u]) => ({
        model,
        input: count(u["inputTokens"]),
        cacheRead: count(u["cacheReadInputTokens"]),
        cacheWrite: count(u["cacheCreationInputTokens"]),
        output: count(u["outputTokens"]),
      }),
    );
    if (rows.length > 0) return rows;
  }
  const one = apiTokens(asked, r["usage"]);
  return one === null ? [] : [one];
};

/** List price of an API key's call; null on a subscription, or when the rate list doesn't know the model. */
export const dollarsOf = (rates: RateTable | null, row: UsageRow): number | null => {
  if (rates === null || credentialOf(row.credential).kind !== "apiKey") return null;
  const priced = priceUsage(rates, {
    model: row.model,
    totals: {
      uncachedInputTokens: row.input,
      cachedInputTokens: row.cacheRead,
      cacheCreationTokens: row.cacheWrite,
      outputTokens: row.output,
      reasoningTokens: 0,
    },
    speed: "standard",
    reportedCostUsd: null,
  });
  return priced.costSource === "unpriced" ? null : priced.costUsd;
};

/** The zone's offset from UTC at `at`, in ms ("Asia/Karachi" is +5 h). */
export const zoneOffsetMs = (timeZone: string, at: number): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return wall - Math.floor(at / 1000) * 1000;
};

const RATES_TTL_MS = 60 * 60_000;

export class BrainUsage extends Context.Service<
  BrainUsage,
  {
    /** Writes one call's row (one per model it used); never fails the call it records. */
    readonly record: (row: UsageRow) => Effect.Effect<void>;
    /** Totals per day, role, login and model since `since` (ms), days in `timeZone`. */
    readonly totals: (input: {
      readonly since: number;
      readonly timeZone: string;
    }) => Effect.Effect<ReadonlyArray<UsageTotal>>;
  }
>()("t3/baton/BrainUsage") {}

/** `readRateList` gives the price list, or null before T3's usage page has ever fetched one. */
export const make = Effect.fn("BrainUsage.make")(function* (readRateList: () => RateTable | null) {
  const sql = yield* SqlClient.SqlClient;
  // Parsed once an hour, not on every call: T3's list is ~3 MB.
  let rates: { readonly table: RateTable | null; readonly at: number } | null = null;
  const ratesNow = Effect.fn("BrainUsage.rates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (rates === null || now - rates.at > RATES_TTL_MS) rates = { table: readRateList(), at: now };
    return rates.table;
  });

  const record = Effect.fn("BrainUsage.record")(
    function* (row: UsageRow) {
      const dollars = dollarsOf(yield* ratesNow(), row);
      const at = yield* Clock.currentTimeMillis;
      yield* sql`
      INSERT INTO tessaya_brain_usage
        (at, role, provider, credential, model, input, cache_read, cache_write, output, dollars)
      VALUES (${at}, ${row.role}, ${"anthropic"}, ${row.credential}, ${row.model}, ${row.input},
        ${row.cacheRead}, ${row.cacheWrite}, ${row.output}, ${dollars})
    `;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("brain: a usage row was not written", { cause }),
    ),
  );

  const totals = Effect.fn("BrainUsage.totals")(function* (input: {
    readonly since: number;
    readonly timeZone: string;
  }) {
    // shortcut: one offset for the whole span, so a DST change inside it moves an hour across midnight; exact per-row
    // zones if a household lives with DST and reads days to the hour.
    const offset = zoneOffsetMs(input.timeZone, yield* Clock.currentTimeMillis);
    const rows = yield* sql<{
      day: string;
      role: string;
      credential: string;
      model: string;
      calls: number;
      input: number;
      cache_read: number;
      cache_write: number;
      output: number;
      dollars: number | null;
    }>`
      SELECT date((at + ${offset}) / 1000, 'unixepoch') AS day, role, credential, model,
        COUNT(*) AS calls, SUM(input) AS input, SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write, SUM(output) AS output, SUM(dollars) AS dollars
      FROM tessaya_brain_usage WHERE at >= ${input.since}
      GROUP BY day, role, credential, model ORDER BY day, role, credential, model
    `.pipe(
      Effect.tapCause((cause) => Effect.logWarning("brain: usage could not be read", { cause })),
      Effect.orElseSucceed(() => []),
    );
    return rows.map((r): UsageTotal => ({
      day: r.day,
      role: r.role,
      credential: r.credential,
      model: r.model,
      calls: r.calls,
      input: r.input,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      output: r.output,
      dollars: r.dollars,
    }));
  });

  return BrainUsage.of({ record, totals });
});

/** On Baton's database, the same one the services use (a layer is built once per server). */
export const layer = Layer.effect(
  BrainUsage,
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    return yield* make(() => readRates(NodePath.dirname(dbPath)));
  }),
).pipe(Layer.provide(BatonDatabase.layer));
