/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Moving one piece of work from one account to another (§6.1).
 *
 * The provider cannot do this. A provider thread is bound to the config
 * directory its session was resumed from — `ProviderService.startSession`
 * refuses a resume across instances whose continuation identity differs, and
 * upstream's own documentation says a thread may switch "only between Claude
 * instances with the same config directory". That is exactly why the spec puts
 * the WorkSession above the ProviderSession (§5.4): the work continues, on a
 * **new** thread, carrying a capsule.
 *
 * This module is the part that decides and describes. What it produces is read
 * by a person as often as by a machine, so the rendering is part of the
 * contract, not a debug aid.
 */
import type {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/tessaya-contracts";

/** What a work session does when the account it runs on reaches its limit. */
export type BatonOnLimitPolicy = "ask" | "auto" | "hold";

export const DEFAULT_ON_LIMIT_POLICY: BatonOnLimitPolicy = "ask";

/** One account a handoff could move to, as the chooser sees it. */
export interface HandoffCandidate {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  /** Null when the instance reports no signed-in address — an expired login. */
  readonly email: string | null;
  readonly enabled: boolean;
  readonly limits: ServerProviderUsageLimits | null;
}

export type HandoffTargetRefusal =
  | "no-other-account"
  | "every-account-limited"
  | "every-account-unusable";

export type HandoffTargetChoice =
  | { readonly outcome: "chosen"; readonly candidate: HandoffCandidate; readonly headroom: number }
  | { readonly outcome: "refused"; readonly reason: HandoffTargetRefusal };

/**
 * Headroom is the **tightest** window, not the average.
 *
 * An account at 4% of its five-hour window and 99% of its weekly one has 1% of
 * headroom, and moving work onto it buys minutes. Averaging would call that
 * account healthy and hand the same limit back within the hour.
 */
export function accountHeadroom(limits: ServerProviderUsageLimits | null): number | null {
  if (limits === null) return null;
  if (limits.unavailable !== undefined) return null;
  if (limits.windows.length === 0) return null;
  const tightest = limits.windows.reduce(
    (worst: ServerProviderUsageWindow, window) =>
      window.usedPercent > worst.usedPercent ? window : worst,
    limits.windows[0]!,
  );
  return Math.max(0, 100 - tightest.usedPercent);
}

/**
 * The account to continue on: same driver, not the one we are leaving, signed
 * in, enabled, and with the most headroom.
 *
 * Accounts whose limits cannot be read are skipped rather than ranked last.
 * "I could not read this one" is not evidence of headroom, and an automatic
 * handoff that acts on a guess is the guessing §14 forbids — a person choosing
 * manually may still pick it, which is why the refusal names why.
 */
export function chooseHandoffTarget(input: {
  readonly from: { readonly instanceId: string; readonly driver: string };
  readonly candidates: ReadonlyArray<HandoffCandidate>;
  /** Below this, an account is treated as already spent. */
  readonly minimumHeadroom?: number;
}): HandoffTargetChoice {
  const minimum = input.minimumHeadroom ?? 5;
  const sameDriver = input.candidates.filter(
    (candidate) =>
      candidate.driver === input.from.driver && candidate.instanceId !== input.from.instanceId,
  );
  if (sameDriver.length === 0) return { outcome: "refused", reason: "no-other-account" };

  const usable = sameDriver.filter(
    (candidate) =>
      candidate.enabled &&
      (candidate.email?.trim().length ?? 0) > 0 &&
      accountHeadroom(candidate.limits) !== null,
  );
  if (usable.length === 0) return { outcome: "refused", reason: "every-account-unusable" };

  const ranked = usable
    .map((candidate) => ({ candidate, headroom: accountHeadroom(candidate.limits) ?? 0 }))
    .sort(
      (left, right) =>
        right.headroom - left.headroom ||
        left.candidate.instanceId.localeCompare(right.candidate.instanceId),
    );
  const best = ranked[0]!;
  if (best.headroom < minimum) return { outcome: "refused", reason: "every-account-limited" };
  return { outcome: "chosen", candidate: best.candidate, headroom: best.headroom };
}

/** Why the handoff happened, in the words the timeline and the voice use. */
export type HandoffReason = "limit" | "manual";

/**
 * What the new thread is told. Both halves matter: the structured fields are
 * what a machine reads back, and the rendering is what the receiving model is
 * actually given — a capsule, not a transcript dump (§6.1).
 */
export interface HandoffCapsule {
  readonly workSessionId: string;
  readonly title: string;
  readonly objective: string;
  readonly constraints: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly currentAction: string | null;
  readonly lastCompleted: string | null;
  readonly nextStep: string | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  /** HEAD in that checkout when the handoff was taken, and whether it was dirty. */
  readonly checkpointCommit: string | null;
  readonly checkpointDirtyPaths: ReadonlyArray<string>;
  readonly sourceThreadId: string;
  readonly sourceAccountLabel: string;
  readonly targetAccountLabel: string;
  readonly reason: HandoffReason;
  readonly createdAt: string;
}

const bullets = (items: ReadonlyArray<string>): string =>
  items.map((item) => `- ${item}`).join("\n");

/**
 * The capsule as the receiving session reads it.
 *
 * Deliberately short. The older context is retrievable on demand — the source
 * thread is linked and still readable — and a model handed forty thousand words
 * of someone else's transcript spends its first turn summarising instead of
 * working.
 */
export function renderHandoffCapsule(capsule: HandoffCapsule): string {
  const lines: Array<string> = [];
  lines.push(
    capsule.reason === "limit"
      ? `You are continuing work that another account was doing until it reached its limit.`
      : `You are continuing work another account was doing.`,
  );
  lines.push("");
  lines.push(`**${capsule.title}**`);
  if (capsule.objective.trim().length > 0) {
    lines.push("");
    lines.push(capsule.objective.trim());
  }
  if (capsule.constraints.length > 0) {
    lines.push("");
    lines.push("Constraints:");
    lines.push(bullets(capsule.constraints));
  }
  if (capsule.acceptanceCriteria.length > 0) {
    lines.push("");
    lines.push("Done when:");
    lines.push(bullets(capsule.acceptanceCriteria));
  }

  const state: Array<string> = [];
  if (capsule.lastCompleted !== null) state.push(`Last finished: ${capsule.lastCompleted}`);
  if (capsule.currentAction !== null) state.push(`Was doing: ${capsule.currentAction}`);
  if (capsule.nextStep !== null) state.push(`Next: ${capsule.nextStep}`);
  if (state.length > 0) {
    lines.push("");
    lines.push("Where it got to:");
    lines.push(bullets(state));
  }

  const checkout: Array<string> = [];
  if (capsule.worktreePath !== null) checkout.push(`Checkout: ${capsule.worktreePath}`);
  if (capsule.branch !== null) {
    checkout.push(
      capsule.baseBranch === null
        ? `Branch: ${capsule.branch}`
        : `Branch: ${capsule.branch} (from ${capsule.baseBranch})`,
    );
  }
  if (capsule.checkpointCommit !== null) {
    checkout.push(
      capsule.checkpointDirtyPaths.length === 0
        ? `At commit ${capsule.checkpointCommit}, working tree clean`
        : `At commit ${capsule.checkpointCommit}, with uncommitted changes in ${capsule.checkpointDirtyPaths.length} file${capsule.checkpointDirtyPaths.length === 1 ? "" : "s"}: ${capsule.checkpointDirtyPaths.slice(0, 8).join(", ")}`,
    );
  }
  if (checkout.length > 0) {
    lines.push("");
    lines.push("The work is here:");
    lines.push(bullets(checkout));
  }

  lines.push("");
  lines.push(
    `Handed over from ${capsule.sourceAccountLabel} to ${capsule.targetAccountLabel}. The earlier conversation is still open in this work session if you need it — ask for it rather than assuming what it said.`,
  );
  return lines.join("\n");
}

/** The one line the fleet row and the spoken status use. */
export function handoffLine(input: {
  readonly targetAccountLabel: string;
  readonly reason: HandoffReason;
}): string {
  return input.reason === "limit"
    ? `Moved to ${input.targetAccountLabel} — the previous account reached its limit`
    : `Moved to ${input.targetAccountLabel}`;
}

/** Why a handoff was refused, said to a person. */
export function handoffRefusalLine(reason: HandoffTargetRefusal): string {
  switch (reason) {
    case "no-other-account":
      return "There is no second account for this provider on this machine. Add one in Settings → Providers.";
    case "every-account-unusable":
      return "The other accounts here are signed out or cannot report their limits. Sign one in, then try again.";
    case "every-account-limited":
      return "Every account here is at its limit. Nothing to move to until one resets.";
  }
}

/**
 * One automatic handoff per limit window, per work session.
 *
 * Without this an account that limits again immediately — which is exactly what
 * a spent weekly window does — walks the work through every account on the
 * machine in a few seconds. The second limit inside the same window holds and
 * asks instead.
 */
export function shouldAutoHandoff(input: {
  readonly policy: BatonOnLimitPolicy;
  readonly lastAutoHandoffAt: string | null;
  /** When the limit that fired this is expected to reset. */
  readonly windowResetsAt: string | null;
  readonly now: string;
}): boolean {
  if (input.policy !== "auto") return false;
  if (input.lastAutoHandoffAt === null) return true;
  const last = Date.parse(input.lastAutoHandoffAt);
  if (Number.isNaN(last)) return true;
  const now = Date.parse(input.now);
  if (Number.isNaN(now)) return false;
  if (input.windowResetsAt === null) {
    // No reset time to reason about: hold for an hour, which is shorter than
    // every window a provider reports and long enough to stop a loop.
    return now - last > 60 * 60 * 1000;
  }
  const resetsAt = Date.parse(input.windowResetsAt);
  if (Number.isNaN(resetsAt)) return now - last > 60 * 60 * 1000;
  // The previous handoff was for this same window if it happened while the
  // window was still open.
  return last > resetsAt;
}
