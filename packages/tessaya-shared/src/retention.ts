/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * What Baton keeps, and for how long (§26).
 *
 * §26's voice defaults are the principle: keep what became a command, not the
 * stream it arrived on. Baton's own logs generalise it — every sentence it was
 * given and every rule that fired are useful for days and a liability for ever.
 *
 * The horizon is a policy rather than a habit, the selection is a pure function
 * so it can be asserted rather than trusted, and one thing is deliberately kept
 * longer than convenience would suggest: **refusals**. A log that keeps only
 * what worked cannot show a grammar its own blind spots.
 *
 * @module batonRetention
 */
import type { BatonRetentionPolicy } from "@t3tools/tessaya-contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetainableRecord {
  readonly id: string;
  readonly at: string;
  /** A refused intent, which the policy may keep for longer. */
  readonly refused: boolean;
}

/**
 * Which rows are past the horizon.
 *
 * Returns the ids to delete rather than deleting anything: the caller owns the
 * storage, and a pure selection is the part worth testing.
 */
export const expiredRecords = (input: {
  readonly records: ReadonlyArray<RetainableRecord>;
  readonly days: number;
  readonly keepRefusals: boolean;
  readonly now: number;
}): ReadonlyArray<string> => {
  const horizon = input.now - input.days * DAY_MS;
  return input.records
    .filter((record) => {
      if (input.keepRefusals && record.refused) return false;
      const at = Date.parse(record.at);
      // A row with an unreadable timestamp is kept. Deleting something because
      // its date could not be parsed is the wrong way round.
      return Number.isFinite(at) && at < horizon;
    })
    .map((record) => record.id);
};

/** The two horizons, in words, for the settings screen that will show them. */
export const describeRetention = (policy: BatonRetentionPolicy): string => {
  const intents =
    policy.intentDays === 0 ? "sentences are not kept" : `sentences for ${policy.intentDays} days`;
  const firings =
    policy.firingDays === 0
      ? "rule firings are not kept"
      : `rule firings for ${policy.firingDays} days`;
  const refusals = policy.keepRefusals ? ", and refusals are kept" : "";
  return `Tessaya keeps ${intents}, ${firings}${refusals}.`;
};
