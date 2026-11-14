/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * When to move work to another account, and which one (§6.1, corrected).
 *
 * The Director already does this by hand, and his own rotator's numbers are the
 * defaults here: warn at 15% headroom, rotate at 5%, only onto an account with
 * at least 20% free, 5 points of hysteresis, a 15-minute cooldown. Those are
 * not invented thresholds — they are what a person who has been rate-limited
 * repeatedly settled on.
 *
 * Nothing here talks to a provider or a file. It decides, and says why.
 */
import type { BatonAccount, BatonAccountPool } from "@t3tools/baton-contracts";

/** What a work session does when the account it runs on nears its limit. */
export type BatonOnLimitPolicy = "auto" | "ask" | "hold";

export const DEFAULT_ON_LIMIT_POLICY: BatonOnLimitPolicy = "ask";

export interface BatonRotationThresholds {
  /** Headroom at which the surface starts saying the account is nearly spent. */
  readonly warnHeadroomPercent: number;
  /** Headroom at which rotation fires. */
  readonly rotateHeadroomPercent: number;
  /** An account is only worth moving to with at least this much free. */
  readonly minimumTargetHeadroomPercent: number;
  /** Extra headroom the target must have over the source, to stop flapping. */
  readonly hysteresisPercent: number;
  /** No second automatic rotation within this many seconds. */
  readonly cooldownSeconds: number;
}

/** His rotator's settings, which are the ones that survived contact with use. */
export const DEFAULT_ROTATION_THRESHOLDS: BatonRotationThresholds = {
  warnHeadroomPercent: 15,
  rotateHeadroomPercent: 5,
  minimumTargetHeadroomPercent: 20,
  hysteresisPercent: 5,
  cooldownSeconds: 900,
};

export type RotationRefusal =
  | "policy-off"
  | "no-other-account"
  | "no-usable-account"
  | "no-account-with-headroom"
  | "not-low-enough"
  | "cooling-down"
  | "already-rotated-this-window";

export type RotationDecision =
  | {
      readonly outcome: "rotate";
      readonly target: BatonAccount;
      readonly from: BatonAccount | null;
      readonly reason: "limit" | "policy";
    }
  | { readonly outcome: "hold"; readonly reason: RotationRefusal };

export const activeAccount = (pool: BatonAccountPool): BatonAccount | null =>
  pool.accounts.find((account) => account.active) ?? null;

/**
 * The account to move to: usable, not the current one, most headroom first.
 *
 * An account whose limits cannot be read is skipped rather than ranked last.
 * "I could not read this one" is not evidence of headroom, and acting on it
 * automatically is the guessing §14 forbids. A person choosing by hand may
 * still pick it — this is the automatic path's rule, not the UI's.
 */
export function rankRotationTargets(
  pool: BatonAccountPool,
  minimumHeadroomPercent: number,
): ReadonlyArray<BatonAccount> {
  return pool.accounts
    .filter(
      (account) =>
        !account.active &&
        account.usable &&
        account.headroomPercent !== null &&
        account.headroomPercent >= minimumHeadroomPercent,
    )
    .sort(
      (left, right) =>
        (right.headroomPercent ?? 0) - (left.headroomPercent ?? 0) ||
        left.key.localeCompare(right.key),
    );
}

/**
 * Whether to rotate now.
 *
 * The bound that matters most is the last one: **one automatic rotation per
 * limit window**. Without it, an account that limits again immediately — which
 * is exactly what a spent weekly window does — walks the work through every
 * account on the machine in seconds and ends up back where it started. The
 * second time inside the same window, it holds and asks.
 */
export function decideRotation(input: {
  readonly pool: BatonAccountPool;
  readonly policy: BatonOnLimitPolicy;
  readonly thresholds?: BatonRotationThresholds;
  /** When this work session last rotated automatically, if it has. */
  readonly lastAutoRotationAt: string | null;
  /** The window that is running out, when the provider named one. */
  readonly sourceWindowResetsAt: string | null;
  /** True when the provider has actually reported the account exhausted. */
  readonly limitReached: boolean;
  readonly now: string;
}): RotationDecision {
  const thresholds = input.thresholds ?? DEFAULT_ROTATION_THRESHOLDS;
  if (input.policy !== "auto") return { outcome: "hold", reason: "policy-off" };

  const from = activeAccount(input.pool);
  const headroom = from?.headroomPercent ?? null;
  // A reported limit outranks the threshold: the provider saying "spent" is a
  // fact, and a headroom reading taken minutes ago is an estimate.
  const lowEnough =
    input.limitReached || (headroom !== null && headroom <= thresholds.rotateHeadroomPercent);
  if (!lowEnough) return { outcome: "hold", reason: "not-low-enough" };

  if (input.pool.accounts.length < 2) return { outcome: "hold", reason: "no-other-account" };

  const nowMs = Date.parse(input.now);
  const lastMs = input.lastAutoRotationAt === null ? null : Date.parse(input.lastAutoRotationAt);
  if (lastMs !== null && !Number.isNaN(lastMs) && !Number.isNaN(nowMs)) {
    if (nowMs - lastMs < thresholds.cooldownSeconds * 1000) {
      return { outcome: "hold", reason: "cooling-down" };
    }
    // The window that is running out has not reset since the last rotation, so
    // this is the same limit asking twice.
    const resetsAtMs =
      input.sourceWindowResetsAt === null ? null : Date.parse(input.sourceWindowResetsAt);
    if (
      resetsAtMs !== null &&
      !Number.isNaN(resetsAtMs) &&
      lastMs < resetsAtMs &&
      nowMs < resetsAtMs
    ) {
      return { outcome: "hold", reason: "already-rotated-this-window" };
    }
  }

  const usable = input.pool.accounts.filter((account) => !account.active && account.usable);
  if (usable.length === 0) return { outcome: "hold", reason: "no-usable-account" };

  // Hysteresis is measured against the account being left, so a rotation only
  // happens when the destination is meaningfully better than the source.
  const minimum = Math.max(
    thresholds.minimumTargetHeadroomPercent,
    (headroom ?? 0) + thresholds.hysteresisPercent,
  );
  const ranked = rankRotationTargets(input.pool, minimum);
  const target = ranked[0];
  if (target === undefined) return { outcome: "hold", reason: "no-account-with-headroom" };

  return {
    outcome: "rotate",
    target,
    from,
    reason: input.limitReached ? "limit" : "policy",
  };
}

/** The line the fleet row, the timeline and the voice use. */
export function rotationLine(input: {
  readonly toLabel: string;
  readonly fromLabel: string | null;
  readonly toHeadroomPercent: number | null;
  readonly reason: "manual" | "limit" | "policy";
}): string {
  const where =
    input.toHeadroomPercent === null
      ? `Moved to ${input.toLabel}`
      : `Moved to ${input.toLabel} with ${Math.round(input.toHeadroomPercent)}% left`;
  if (input.reason === "manual") return input.fromLabel === null ? where : `${where}`;
  return input.fromLabel === null
    ? `${where} — the account in use had run out`
    : `${where} — ${input.fromLabel} had run out`;
}

/** Why nothing moved, said to a person rather than logged as a code. */
export function rotationRefusalLine(reason: RotationRefusal): string {
  switch (reason) {
    case "policy-off":
      return "Automatic account switching is off for this work. Turn it on, or pick an account yourself.";
    case "no-other-account":
      return "There is only one account here. Add another with `cswap add`, or sign a second one in.";
    case "no-usable-account":
      return "The other accounts are signed out or cannot report their limits. Sign one in, then try again.";
    case "no-account-with-headroom":
      return "No other account has enough left to be worth moving to.";
    case "not-low-enough":
      return "The account in use still has room.";
    case "cooling-down":
      return "This work switched accounts a moment ago. Waiting before switching again.";
    case "already-rotated-this-window":
      return "This work already switched once for this limit window. Pick an account yourself if you want another move.";
  }
}

/** How a surface describes the account in use, at a glance. */
export function accountStanding(
  account: BatonAccount | null,
  thresholds: BatonRotationThresholds = DEFAULT_ROTATION_THRESHOLDS,
): { readonly label: string; readonly tone: "ok" | "warn" | "spent" } | null {
  if (account === null) return null;
  const headroom = account.headroomPercent;
  if (!account.usable) {
    return { label: `${account.label} — signed out`, tone: "spent" };
  }
  if (headroom === null) return { label: account.label, tone: "ok" };
  if (headroom <= thresholds.rotateHeadroomPercent) {
    return { label: `${account.label} — out of room`, tone: "spent" };
  }
  if (headroom <= thresholds.warnHeadroomPercent) {
    return { label: `${account.label} — ${Math.round(headroom)}% left`, tone: "warn" };
  }
  return { label: account.label, tone: "ok" };
}

/**
 * One account, or none with room (B-031): non-urgent work waits for the reset instead of failing on the limit.
 * Defer when the account in use is within the warning band and no other usable account has the target's minimum;
 * `until` is the tightest window's reset when the provider named one. Null: go on, or let rotation move it.
 */
export function deferNearLimit(
  pool: Pick<BatonAccountPool, "accounts">,
  thresholds: BatonRotationThresholds = DEFAULT_ROTATION_THRESHOLDS,
): { readonly until: string | null; readonly headroomPercent: number } | null {
  const from = pool.accounts.find((account) => account.active) ?? null;
  const headroom = from?.headroomPercent ?? null;
  if (from === null || headroom === null || headroom > thresholds.warnHeadroomPercent) return null;
  if (rankRotationTargets(pool, thresholds.minimumTargetHeadroomPercent).length > 0) return null;
  const tightest = from.windows.toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
  return { until: tightest?.resetsAt ?? null, headroomPercent: headroom };
}
