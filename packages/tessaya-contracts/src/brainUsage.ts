/**
 * What her brain used (BRAIN-DESIGN §13.3): totals per day, role, login and model, and his spend alerts against what
 * the API keys spent. Read by Settings → Usage on every client and by `tessaya_usage_report`.
 */
import * as Schema from "effect/Schema";

export const BATON_BRAIN_WS_METHODS = { usage: "baton.brain.usage" } as const;

export const BrainUsageInput = Schema.Struct({
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 93 })),
  /** Days are counted in this zone: the reader's own ("Asia/Karachi"); empty, or one it doesn't know, the house's. */
  timeZone: Schema.String.check(Schema.isMaxLength(64)),
});
export type BrainUsageInput = typeof BrainUsageInput.Type;

export const BrainUsageTotal = Schema.Struct({
  day: Schema.String,
  role: Schema.String,
  /** `subscription`, `subscription:<account>` or `apiKey:anthropic`. */
  credential: Schema.String,
  model: Schema.String,
  calls: Schema.Number,
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  /** List price, API key rows only: a subscription's plan pays, so null. */
  dollars: Schema.NullOr(Schema.Number),
});
export type BrainUsageTotal = typeof BrainUsageTotal.Type;

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
  limits: Schema.Array(BrainSpendLimitState),
});
export type BrainUsageResult = typeof BrainUsageResult.Type;
