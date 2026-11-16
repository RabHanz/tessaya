// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The one usage ledger (BRAIN-DESIGN §13.3): every paid call of hers writes a row with tokens, who paid, the list
 * price and its price-list date, and what it was for (`UsageAttribution`). Provider turns stay in T3's turn record.
 * `dollars` is what an API key spent; a plan's row says null. A failed write is logged and never fails the call.
 */
import { zoneOf } from "@t3tools/tessaya-shared/brain";
import { houseZone } from "./houseZone.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { credentialOf, LEDGERED_DIR } from "@t3tools/tessaya-shared/brainRoutes";
import type { BrainRole, BrainSpendAlert } from "@t3tools/contracts";
import type {
  BrainUsageCall,
  BrainUsageInput,
  BrainUsageUnit,
  UsageAttribution,
  UsageBilling,
  UsageOutcome,
} from "@t3tools/tessaya-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { priceUsage, type RateTable } from "../usage/usagePricing.ts";
import * as TessayaDatabase from "./TessayaDatabase.ts";
import * as TessayaRecordService from "./TessayaRecordService.ts";
import { readPriceList, type PriceList } from "./TessayaJobSpend.ts";

/** One call's tokens on one model. `input` is the uncached part, as the API counts it. */
export interface CallTokens {
  readonly model: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/** The folder her own CLI calls run from: the tag that keeps T3's transcript scan from counting them twice. */
export const ledgeredCwd = (): string => {
  const dir = NodePath.join(NodeOS.tmpdir(), LEDGERED_DIR);
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Her routing table's roles, `agent` for a provider turn, `speech` for cloud speech in and out. */
export type UsageRole = BrainRole | "agent" | "speech";

export interface UsageRow extends CallTokens {
  readonly role: UsageRole;
  /** A `BrainCredential`, or `instance:<id>` for a provider instance's own login. */
  readonly credential: string;
  /** "anthropic" when absent. */
  readonly provider?: string;
  /** From the credential when absent: an `apiKey:` login bills per token, everything else is his plan. */
  readonly billing?: UsageBilling;
  /** The login's account (an email or plan label), when the call knows it. */
  readonly account?: string;
  /** A report that can arrive twice (a provider turn) names itself once; the second write is dropped. */
  readonly key?: string;
  /** What it was for and what started it: required, so no call site can leave it out. */
  readonly attribution: UsageAttribution;
  /** `failed`: it ran and spent, and its tokens were lost; `unmeasured`: it worked and reported none. */
  readonly outcome?: UsageOutcome;
  /** Audio a speech call heard or said, which its provider bills by. */
  readonly audioMs?: number;
}

/** One day's use of one model by one role on one login, the day in the asker's time zone. */
export interface UsageTotal {
  readonly day: string;
  readonly role: string;
  readonly credential: string;
  readonly model: string;
  readonly feature: string;
  readonly persona: string | null;
  readonly surface: string | null;
  readonly billing: UsageBilling;
  readonly calls: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** API key rows only; null when none were priced. */
  readonly dollars: number | null;
  /** Every row at list price, the plan's as its equivalent; null when none were priced. */
  readonly listDollars: number | null;
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

export const billingOfRow = (row: Pick<UsageRow, "billing" | "credential">): UsageBilling =>
  row.billing ??
  (credentialOf(row.credential as never).kind === "apiKey" ? "apiKey" : "subscription");

/** List price of a call on any login (a plan's call as its equivalent); null when the rate list doesn't know it. */
export const listDollarsOf = (rates: RateTable | null, row: CallTokens): number | null => {
  // No tokens is no claim: a speech call bills by audio, and a lost count is not $0.
  if (rates === null || row.input + row.cacheRead + row.cacheWrite + row.output === 0) return null;
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

/** What an API key spent on the call; null on a subscription, or when the rate list doesn't know the model. */
export const dollarsOf = (rates: RateTable | null, row: UsageRow): number | null =>
  billingOfRow(row) === "apiKey" ? listDollarsOf(rates, row) : null;

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

export type SpendScope = "all" | UsageRole;
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
  row: { readonly role: UsageRole; readonly dollars: number },
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
    /** Totals per day, role, login, model, feature, persona and surface since `since` (ms), days in `timeZone`. */
    readonly totals: (input: {
      readonly since: number;
      readonly timeZone: string;
    }) => Effect.Effect<ReadonlyArray<UsageTotal>>;
    /** Unit cost since `since`: each schedule per run, each job in all. */
    readonly units: (since: number) => Effect.Effect<ReadonlyArray<BrainUsageUnit>>;
    /** The calls behind one line, newest first, at most `limit`. */
    readonly calls: (input: {
      readonly since: number;
      readonly timeZone: string;
      readonly filter: NonNullable<BrainUsageInput["detail"]>;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<BrainUsageCall>>;
    /** His spend alerts, each with what the API keys spent against it this day or month in `timeZone`. */
    readonly limits: (timeZone: string) => Effect.Effect<ReadonlyArray<SpendLimitState>>;
  }
>()("t3/tessaya/BrainUsage") {}

/** `readRateList` gives the price list, or null before T3's usage page has ever fetched one. */
export const make = Effect.fn("BrainUsage.make")(function* (readRateList: () => PriceList | null) {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const notes = yield* TessayaRecordService.TessayaRecordService;
  // Parsed once an hour, not on every call: T3's list is ~3 MB.
  let rates: { readonly list: PriceList | null; readonly at: number } | null = null;
  const ratesNow = Effect.fn("BrainUsage.rates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (rates === null || now - rates.at > RATES_TTL_MS) rates = { list: readRateList(), at: now };
    return rates.list;
  });

  const spendNow = Effect.fn("BrainUsage.spendNow")(function* (timeZone: string, at: number) {
    const starts = periodStarts(timeZone, at);
    const rows = yield* sql<{ role: UsageRole; day: number | null; month: number | null }>`
      SELECT role, SUM(CASE WHEN at >= ${starts.day} THEN dollars END) AS day, SUM(dollars) AS month
      FROM tessaya_brain_usage WHERE at >= ${starts.month} AND dollars IS NOT NULL GROUP BY role
    `;
    const day: Partial<Record<SpendScope, number>> = { all: 0 };
    // Provider turns on an API key count toward "all" and their own `agent` scope.
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
    role: UsageRole,
    dollars: number,
    at: number,
  ) {
    const limits = (yield* settings.getSettings).brainSpendAlert;
    if (Object.keys(limits).length === 0) return;
    const after = yield* spendNow(yield* houseZone(), at);
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
      const prices = yield* ratesNow();
      const list = listDollarsOf(prices?.table ?? null, row);
      const billing = billingOfRow(row);
      const dollars = billing === "apiKey" ? list : null;
      const at = yield* Clock.currentTimeMillis;
      const a = row.attribution;
      const written = yield* sql<{ id: number }>`
      INSERT INTO tessaya_brain_usage
        (at, role, provider, credential, model, input, cache_read, cache_write, output, dollars,
         feature, origin, surface, persona, thread_id, turn_id, job_id, schedule_id, device, member,
         billing, account, list_dollars, price_version, call_key, outcome, audio_ms)
      VALUES (${at}, ${row.role}, ${row.provider ?? "anthropic"}, ${row.credential}, ${row.model},
        ${row.input}, ${row.cacheRead}, ${row.cacheWrite}, ${row.output}, ${dollars},
        ${a.feature}, ${a.origin}, ${a.surface ?? null}, ${a.persona ?? null}, ${a.threadId ?? null},
        ${a.turnId ?? null}, ${a.jobId ?? null}, ${a.scheduleId ?? null}, ${a.device ?? null},
        ${a.member ?? null}, ${billing}, ${row.account ?? null}, ${list},
        ${list === null ? null : (prices?.version ?? null)}, ${row.key ?? null},
        ${row.outcome ?? "ok"}, ${row.audioMs ?? null})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
      if (written.length > 0 && dollars !== null && dollars > 0)
        yield* alertIfCrossed(row.role, dollars, at);
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
      feature: string;
      persona: string | null;
      surface: string | null;
      billing: UsageBilling;
      calls: number;
      input: number;
      cache_read: number;
      cache_write: number;
      output: number;
      dollars: number | null;
      list_dollars: number | null;
    }>`
      SELECT date((at + ${offset}) / 1000, 'unixepoch') AS day, role, credential, model,
        feature, persona, surface, billing,
        COUNT(*) AS calls, SUM(input) AS input, SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write, SUM(output) AS output, SUM(dollars) AS dollars,
        SUM(list_dollars) AS list_dollars
      FROM tessaya_brain_usage WHERE at >= ${input.since}
      GROUP BY day, role, credential, model, feature, persona, surface, billing
      ORDER BY day, role, credential, model, feature, persona, surface
    `.pipe(
      Effect.tapCause((cause) => Effect.logWarning("brain: usage could not be read", { cause })),
      Effect.orElseSucceed(() => []),
    );
    return rows.map((r): UsageTotal => ({
      day: r.day,
      role: r.role,
      credential: r.credential,
      model: r.model,
      feature: r.feature,
      persona: r.persona,
      surface: r.surface,
      billing: r.billing,
      calls: r.calls,
      input: r.input,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      output: r.output,
      dollars: r.dollars,
      listDollars: r.list_dollars,
    }));
  });

  // A provider turn's row names its thread; the job it belongs to is that thread's work session.
  const units = Effect.fn("BrainUsage.units")(function* (since: number) {
    const rows = yield* sql<{
      kind: "schedule" | "job";
      id: string;
      runs: number;
      calls: number;
      tokens: number;
      dollars: number | null;
      list_dollars: number | null;
    }>`
      WITH u AS (
        SELECT b.*, COALESCE(b.job_id, t.work_session_id) AS job
        FROM tessaya_brain_usage b
        LEFT JOIN fabric_work_session_threads t ON t.thread_id = b.thread_id
        WHERE b.at >= ${since}
      )
      SELECT 'schedule' AS kind, schedule_id AS id,
        COUNT(DISTINCT COALESCE(thread_id, turn_id, id)) AS runs, COUNT(*) AS calls,
        SUM(input + cache_read + cache_write + output) AS tokens, SUM(dollars) AS dollars,
        SUM(list_dollars) AS list_dollars
      FROM u WHERE schedule_id IS NOT NULL GROUP BY schedule_id
      UNION ALL
      SELECT 'job' AS kind, job AS id, COUNT(DISTINCT COALESCE(thread_id, id)) AS runs, COUNT(*) AS calls,
        SUM(input + cache_read + cache_write + output) AS tokens, SUM(dollars) AS dollars,
        SUM(list_dollars) AS list_dollars
      FROM u WHERE job IS NOT NULL GROUP BY job
    `.pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("brain: unit costs could not be read", { cause }),
      ),
      Effect.orElseSucceed(() => []),
    );
    return rows.map((r): BrainUsageUnit => ({
      kind: r.kind,
      id: r.id,
      runs: r.runs,
      calls: r.calls,
      tokens: r.tokens,
      dollars: r.dollars,
      listDollars: r.list_dollars,
    }));
  });

  const calls = Effect.fn("BrainUsage.calls")(function* (input: {
    readonly since: number;
    readonly timeZone: string;
    readonly filter: NonNullable<BrainUsageInput["detail"]>;
    readonly limit: number;
  }) {
    const offset = zoneOffsetMs(input.timeZone, yield* Clock.currentTimeMillis);
    const f = input.filter;
    const rows = yield* sql<{
      at: number;
      role: string;
      feature: string;
      origin: string;
      outcome: UsageOutcome;
      surface: string | null;
      persona: string | null;
      provider: string;
      model: string;
      billing: UsageBilling;
      account: string | null;
      credential: string;
      input: number;
      cache_read: number;
      cache_write: number;
      output: number;
      dollars: number | null;
      list_dollars: number | null;
      price_version: string | null;
      thread_id: string | null;
      turn_id: string | null;
      job_id: string | null;
      schedule_id: string | null;
      device: string | null;
      member: string | null;
    }>`
      SELECT at, role, feature, origin, outcome, surface, persona, provider, model, billing, account, credential,
        input, cache_read, cache_write, output, dollars, list_dollars, price_version, thread_id, turn_id,
        job_id, schedule_id, device, member
      FROM tessaya_brain_usage
      WHERE at >= ${input.since}
        AND (${f.day ?? null} IS NULL OR date((at + ${offset}) / 1000, 'unixepoch') = ${f.day ?? null})
        AND (${f.feature ?? null} IS NULL OR feature = ${f.feature ?? null})
        AND (${f.persona ?? null} IS NULL OR persona = ${f.persona ?? null})
        AND (${f.model ?? null} IS NULL OR model = ${f.model ?? null})
        AND (${f.surface ?? null} IS NULL OR surface = ${f.surface ?? null})
        AND (${f.threadId ?? null} IS NULL OR thread_id = ${f.threadId ?? null})
        AND (${f.scheduleId ?? null} IS NULL OR schedule_id = ${f.scheduleId ?? null})
      ORDER BY at DESC LIMIT ${input.limit}
    `.pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("brain: usage calls could not be read", { cause }),
      ),
      Effect.orElseSucceed(() => []),
    );
    return rows.map((r): BrainUsageCall => ({
      at: r.at,
      role: r.role,
      feature: r.feature,
      origin: r.origin,
      outcome: r.outcome,
      surface: r.surface,
      persona: r.persona,
      provider: r.provider,
      model: r.model,
      billing: r.billing,
      account: r.account,
      credential: r.credential,
      input: r.input,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      output: r.output,
      dollars: r.dollars,
      listDollars: r.list_dollars,
      priceVersion: r.price_version,
      threadId: r.thread_id,
      turnId: r.turn_id,
      jobId: r.job_id,
      scheduleId: r.schedule_id,
      device: r.device,
      member: r.member,
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

  return BrainUsage.of({ record, totals, units, calls, limits });
});

const CALLS_LIMIT = 200;

/**
 * The Usage page's and `tessaya_usage_report`'s read: the last `days` days in `timeZone`, its unit costs and his
 * spend alerts; with `detail`, the calls behind one line instead of the totals (the drill-down to the turn).
 */
export const brainUsageReport = Effect.fn("BrainUsage.report")(function* (input: BrainUsageInput) {
  const usage = yield* BrainUsage;
  const now = yield* Clock.currentTimeMillis;
  const timeZone = zoneOf(input.timeZone, yield* houseZone());
  const since = periodStarts(timeZone, now - (input.days - 1) * 86_400_000).day;
  if (input.detail !== undefined) {
    return {
      totals: [],
      units: [],
      limits: [],
      calls: yield* usage.calls({ since, timeZone, filter: input.detail, limit: CALLS_LIMIT }),
    };
  }
  return {
    totals: yield* usage.totals({ since, timeZone }),
    units: yield* usage.units(since),
    limits: yield* usage.limits(timeZone),
  };
});

/** On Baton's database, the same one the services use (a layer is built once per server). */
export const layer = Layer.effect(
  BrainUsage,
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    return yield* make(() => readPriceList(NodePath.dirname(dbPath)));
  }),
).pipe(Layer.provide(TessayaRecordService.layer), Layer.provide(TessayaDatabase.layer));
