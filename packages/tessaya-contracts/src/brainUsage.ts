/**
 * The one usage ledger's read (BRAIN-DESIGN §13.3): every paid call in the product, her own and every provider turn,
 * as totals per day, feature, persona, surface, login and model, unit costs per schedule and job, the calls behind
 * one line (drill-down to the turn), and his spend alerts. Read by Settings → Usage on every client and by
 * `tessaya_usage_report`.
 */
import * as Schema from "effect/Schema";

export const BATON_BRAIN_WS_METHODS = { usage: "baton.brain.usage" } as const;

/** Who paid: his plan (tokens, and their list-price equivalent) or an API key (dollars at list price). */
export const UsageBilling = Schema.Literals(["subscription", "apiKey"]);
export type UsageBilling = typeof UsageBilling.Type;

/** `ok`, `failed` (it ran and spent, and its tokens were lost) or `unmeasured` (it worked and reported none). */
export const UsageOutcome = Schema.Literals(["ok", "failed", "unmeasured"]);
export type UsageOutcome = typeof UsageOutcome.Type;

/** What a call was for and what started it; every usage row carries one. */
export interface UsageAttribution {
  /** The product feature that spent it: `chat`, `job`, `dictation`, `tessel`, `lines`, `intent`, `synopsis`… */
  readonly feature: string;
  /** What started it (provenance): `user`, `agent`, `schedule`, `system` (her own upkeep), `mcp`, `provider`. */
  readonly origin: string;
  /** Where: `desktop`, `web`, `mobile`, `tessel`, `server`. */
  readonly surface?: string;
  readonly persona?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly jobId?: string;
  readonly scheduleId?: string;
  readonly device?: string;
  readonly member?: string;
}

const Id = Schema.String.check(Schema.isMaxLength(128));

/** One line's calls: any field left out matches all. */
export const BrainUsageDetail = Schema.Struct({
  day: Schema.optional(Id),
  feature: Schema.optional(Id),
  persona: Schema.optional(Id),
  model: Schema.optional(Id),
  surface: Schema.optional(Id),
  threadId: Schema.optional(Id),
  scheduleId: Schema.optional(Id),
});

export const BrainUsageInput = Schema.Struct({
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 93 })),
  /** Days are counted in this zone: the reader's own ("Asia/Karachi"); empty, or one it doesn't know, the house's. */
  timeZone: Schema.String.check(Schema.isMaxLength(64)),
  /** The drill-down: the calls behind one line (at most 200, newest first) instead of the totals. */
  detail: Schema.optional(BrainUsageDetail),
});
export type BrainUsageInput = typeof BrainUsageInput.Type;

export const BrainUsageTotal = Schema.Struct({
  day: Schema.String,
  role: Schema.String,
  /** `subscription`, `subscription:<account>`, `apiKey:anthropic` or `instance:<id>` (a provider turn's login). */
  credential: Schema.String,
  model: Schema.String,
  feature: Schema.String,
  persona: Schema.NullOr(Schema.String),
  surface: Schema.NullOr(Schema.String),
  billing: UsageBilling,
  calls: Schema.Number,
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  /** List price, API key rows only: a subscription's plan pays, so null. */
  dollars: Schema.NullOr(Schema.Number),
  /** Every row at list price, a plan's as its equivalent; null when the price list doesn't know the model. */
  listDollars: Schema.NullOr(Schema.Number),
});
export type BrainUsageTotal = typeof BrainUsageTotal.Type;

/** A schedule's or a job's own cost: a schedule per run, a job in all. */
export const BrainUsageUnit = Schema.Struct({
  kind: Schema.Literals(["schedule", "job"]),
  id: Schema.String,
  runs: Schema.Number,
  calls: Schema.Number,
  tokens: Schema.Number,
  dollars: Schema.NullOr(Schema.Number),
  listDollars: Schema.NullOr(Schema.Number),
});
export type BrainUsageUnit = typeof BrainUsageUnit.Type;

/** One call, with everything it is attributed to. */
export const BrainUsageCall = Schema.Struct({
  at: Schema.Number,
  role: Schema.String,
  feature: Schema.String,
  origin: Schema.String,
  outcome: UsageOutcome,
  surface: Schema.NullOr(Schema.String),
  persona: Schema.NullOr(Schema.String),
  provider: Schema.String,
  model: Schema.String,
  billing: UsageBilling,
  account: Schema.NullOr(Schema.String),
  credential: Schema.String,
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  dollars: Schema.NullOr(Schema.Number),
  listDollars: Schema.NullOr(Schema.Number),
  /** The price list's date that made its dollars. */
  priceVersion: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  jobId: Schema.NullOr(Schema.String),
  scheduleId: Schema.NullOr(Schema.String),
  device: Schema.NullOr(Schema.String),
  member: Schema.NullOr(Schema.String),
});
export type BrainUsageCall = typeof BrainUsageCall.Type;

export const BrainSpendLimitState = Schema.Struct({
  /** `all`, or one role. */
  scope: Schema.String,
  period: Schema.Literals(["day", "month"]),
  limit: Schema.Number,
  spent: Schema.Number,
  reached: Schema.Boolean,
});
export type BrainSpendLimitState = typeof BrainSpendLimitState.Type;

export const BrainUsageResult = Schema.Struct({
  totals: Schema.Array(BrainUsageTotal),
  units: Schema.Array(BrainUsageUnit),
  limits: Schema.Array(BrainSpendLimitState),
  /** Only with `detail`. */
  calls: Schema.optional(Schema.Array(BrainUsageCall)),
});
export type BrainUsageResult = typeof BrainUsageResult.Type;
