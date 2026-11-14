/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * How long Baton keeps what it wrote down (§26).
 *
 * @module baton/capability
 */
import * as Schema from "effect/Schema";

/**
 * How long Baton keeps what it wrote down.
 *
 * §26's defaults are about voice, and the principle generalises: keep what
 * became a command, not the stream it arrived on. Baton's own logs — every
 * sentence, every rule firing — are useful for days and are a liability for
 * ever, so they have a horizon and it is a setting rather than a habit.
 */
export const BatonRetentionPolicy = Schema.Struct({
  /** Days to keep the intent log. Zero means keep nothing beyond today. */
  intentDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
  /** Days to keep orchestration firings. */
  firingDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
  /**
   * Whether refused intents are kept as long as the rest. On by default: a log
   * that keeps only what worked cannot show a grammar its own blind spots.
   */
  keepRefusals: Schema.Boolean,
});
export type BatonRetentionPolicy = typeof BatonRetentionPolicy.Type;

export const DEFAULT_RETENTION: BatonRetentionPolicy = {
  intentDays: 30,
  firingDays: 90,
  keepRefusals: true,
};
