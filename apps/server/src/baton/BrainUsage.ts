// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Every model call the brain makes writes one row (BRAIN-DESIGN §13.3, B1d): role, provider, login, model, tokens,
 * and dollars at list price when an API key paid (a subscription row says null: the plan paid). The first slice of
 * ACCOUNTS-IDENTITY C-2's usage ledger, not a second ledger. A failed write is logged and never fails the call.
 */
import * as NodePath from "node:path";

import { credentialOf } from "@t3tools/tessaya-shared/brainRoutes";
import type { BrainCredential, BrainRole, BrainSpendAlert } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { HomeAssistantService } from "../home/HomeAssistantService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { priceUsage, type RateTable } from "../usage/usagePricing.ts";
import * as BatonDatabase from "./BatonDatabase.ts";
import * as BatonRecordService from "./BatonRecordService.ts";
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

/** A zone `Intl` knows: a client's string is checked before any date math throws on it. */
export const knownZone = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/** Where in his day and month `at` falls: both starts, in ms. */
export const periodStarts = (timeZone: string, at: number) => {
  const offset = zoneOffsetMs(timeZone, at);
  const local = new Date(at + offset);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  // shortcut: the offset at `at` is used for midnight too, so a DST change today moves the start by an hour.
  return {
    day: Date.UTC(y, m, local.getUTCDate()) - offset,
    month: Date.UTC(y, m, 1) - offset,
  };
};

export type SpendScope = "all" | BrainRole;
/** What the API keys spent this day and month, in dollars: every role together (`all`) and each one. */
export interface SpendNow {
  readonly day: Partial<Record<SpendScope, number>>;
  readonly month: Partial<Record<SpendScope, number>>;
}
export interface SpendLimitState {
  readonly scope: SpendScope;
  readonly period: "day" | "month";
  readonly limit: number;
  readonly spent: number;
  readonly reached: boolean;
}

/** Every limit he set, with what was spent against it. */
export const spendLimits = (
  limits: BrainSpendAlert,
  spent: SpendNow,
): ReadonlyArray<SpendLimitState> =>
  (Object.entries(limits) as ReadonlyArray<[SpendScope, BrainSpendAlert["all"]]>).flatMap(
    ([scope, limit]) =>
      (["day", "month"] as const).flatMap((period) => {
        const at = limit?.[period];
        if (at === undefined || at === null) return [];
        const so = spent[period][scope] ?? 0;
        return [{ scope, period, limit: at, spent: so, reached: so >= at }];
      }),
  );

/** The limits this call took over: reached now, not before it. */
export const crossedBy = (
  limits: BrainSpendAlert,
  after: SpendNow,
  row: { readonly role: BrainRole; readonly dollars: number },
): ReadonlyArray<SpendLimitState> => {
  const less = (sums: SpendNow["day"]) => ({
    ...sums,
    all: (sums.all ?? 0) - row.dollars,
    [row.role]: (sums[row.role] ?? 0) - row.dollars,
  });
  const before = spendLimits(limits, { day: less(after.day), month: less(after.month) });
  return spendLimits(limits, after).filter((now, i) => now.reached && before[i]?.reached === false);
};

const money = (dollars: number) => `$${dollars.toFixed(2)}`;

/** One line for the Record, the desktop's notice and her voice. */
export const spendLine = (crossed: SpendLimitState) =>
  `${crossed.period === "day" ? "Today's" : "This month's"} API spend on ${
    crossed.scope === "all" ? "all her work" : crossed.scope
  } reached your ${money(crossed.limit)} alert: ${money(crossed.spent)} so far.`;

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
    /** His spend alerts, each with what the API keys spent against it this day or month in `timeZone`. */
    readonly limits: (timeZone: string) => Effect.Effect<ReadonlyArray<SpendLimitState>>;
  }
>()("t3/baton/BrainUsage") {}

/** His zone: the house's, else this machine's. Read where the call is made, so any caller can record. */
const houseZone = Effect.gen(function* () {
  const home = yield* Effect.serviceOption(HomeAssistantService);
  return Option.isSome(home)
    ? yield* home.value.timeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
});

/** `readRateList` gives the price list, or null before T3's usage page has ever fetched one. */
export const make = Effect.fn("BrainUsage.make")(function* (readRateList: () => RateTable | null) {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const notes = yield* BatonRecordService.BatonRecordService;
  // Parsed once an hour, not on every call: T3's list is ~3 MB.
  let rates: { readonly table: RateTable | null; readonly at: number } | null = null;
  const ratesNow = Effect.fn("BrainUsage.rates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (rates === null || now - rates.at > RATES_TTL_MS) rates = { table: readRateList(), at: now };
    return rates.table;
  });

  const spendNow = Effect.fn("BrainUsage.spendNow")(function* (timeZone: string, at: number) {
    const starts = periodStarts(timeZone, at);
    const rows = yield* sql<{ role: BrainRole; day: number | null; month: number | null }>`
      SELECT role, SUM(CASE WHEN at >= ${starts.day} THEN dollars END) AS day, SUM(dollars) AS month
      FROM tessaya_brain_usage WHERE at >= ${starts.month} AND dollars IS NOT NULL GROUP BY role
    `;
    const day: Partial<Record<SpendScope, number>> = { all: 0 };
    const month: Partial<Record<SpendScope, number>> = { all: 0 };
    for (const r of rows) {
      day[r.role] = r.day ?? 0;
      month[r.role] = r.month ?? 0;
      day.all = (day.all ?? 0) + (r.day ?? 0);
      month.all = (month.all ?? 0) + (r.month ?? 0);
    }
    return { day, month } satisfies SpendNow;
  });

  /** A call that takes the keys' spend over one of his limits writes it to the Record once; the desktop says it. */
  const alertIfCrossed = Effect.fn("BrainUsage.alertIfCrossed")(function* (
    role: BrainRole,
    dollars: number,
    at: number,
  ) {
    const limits = (yield* settings.getSettings).brainSpendAlert;
    if (Object.keys(limits).length === 0) return;
    const after = yield* spendNow(yield* houseZone, at);
    for (const crossed of crossedBy(limits, after, { role, dollars })) {
      yield* Effect.logInfo("brain: a spend alert was reached", { ...crossed });
      yield* notes.append({
        kind: "brain_spend",
        actor: "Tessaya",
        subject: crossed.scope === "all" ? "API spend" : `API spend: ${crossed.scope}`,
        outcome: "alert",
        detail: spendLine(crossed),
      });
    }
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
      if (dollars !== null && dollars > 0) yield* alertIfCrossed(row.role, dollars, at);
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

  const limits = Effect.fn("BrainUsage.limits")(
    function* (timeZone: string) {
      const brainSpendAlert = (yield* settings.getSettings).brainSpendAlert;
      return spendLimits(
        brainSpendAlert,
        yield* spendNow(timeZone, yield* Clock.currentTimeMillis),
      );
    },
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("brain: spend limits could not be read", { cause }), []),
    ),
  );

  return BrainUsage.of({ record, totals, limits });
});

/** The Usage page's and `tessaya_usage_report`'s read: the last `days` days in `timeZone`, and his spend alerts. */
export const brainUsageReport = Effect.fn("BrainUsage.report")(function* (input: {
  readonly days: number;
  readonly timeZone: string;
}) {
  const usage = yield* BrainUsage;
  const now = yield* Clock.currentTimeMillis;
  const timeZone =
    input.timeZone !== "" && knownZone(input.timeZone) ? input.timeZone : yield* houseZone;
  const since = periodStarts(timeZone, now - (input.days - 1) * 86_400_000).day;
  return {
    totals: yield* usage.totals({ since, timeZone }),
    limits: yield* usage.limits(timeZone),
  };
});

/** On Baton's database, the same one the services use (a layer is built once per server). */
export const layer = Layer.effect(
  BrainUsage,
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    return yield* make(() => readRates(NodePath.dirname(dbPath)));
  }),
).pipe(Layer.provide(BatonRecordService.layer), Layer.provide(BatonDatabase.layer));
