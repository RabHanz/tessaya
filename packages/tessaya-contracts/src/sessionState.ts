/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Provider-neutral session state, and the deterministic rules that produce it.
 *
 * The specification's §10 is emphatic on one point and this module exists to
 * hold it: **never use a model to infer a state T3 already expresses.** Every
 * value below is computed from structured data the environment already sends —
 * pending approvals, pending questions, session status, background liveness,
 * the latest turn, the provider's own quota report, and whether the
 * environment is reachable at all. There is no transcript reading here and
 * there must not be.
 *
 * Source priority, §10, highest first:
 *
 *   1. provider-native / T3 structured events  (`session`, `hasPending*`)
 *   2. T3 orchestration state                  (`latestTurn`, `backgroundLiveness`)
 *   3. explicit provider usage-limit responses (`usageLimits`)
 *   4. Herdr semantic integration              (Phase 8, absent here)
 *   5. process / terminal heuristics           (not used)
 *   6. transcript inference                    (never)
 *
 * Reachability outranks all of it: a state read off a stale cache from an
 * environment that is gone would be a lie with a confident face.
 *
 * @module baton/sessionState
 */
import * as Schema from "effect/Schema";

import { IsoDateTime } from "@t3tools/contracts";

export const BatonSessionState = Schema.Literals([
  "starting",
  "working",
  "monitoring",
  "needs_approval",
  "needs_input",
  "done_unseen",
  "idle",
  "limited",
  "offline",
  "failed",
]);
export type BatonSessionState = typeof BatonSessionState.Type;

/**
 * States that mean the work cannot move without the user. "What needs me?"
 * is exactly this set, and the fleet's top-level filter uses it.
 */
export const BATON_STATES_NEEDING_USER: ReadonlyArray<BatonSessionState> = [
  "needs_approval",
  "needs_input",
  "limited",
  "failed",
];

export const batonStateNeedsUser = (state: BatonSessionState): boolean =>
  BATON_STATES_NEEDING_USER.includes(state);

/** States where the provider is doing something right now. */
export const batonStateIsActive = (state: BatonSessionState): boolean =>
  state === "starting" || state === "working" || state === "monitoring";

/**
 * Sort weight for the fleet list: what needs the user first, then what is
 * running, then what finished unseen, then everything at rest. Lower sorts
 * earlier.
 */
export const BATON_STATE_PRIORITY: Readonly<Record<BatonSessionState, number>> = {
  needs_approval: 0,
  needs_input: 1,
  failed: 2,
  limited: 3,
  working: 4,
  starting: 5,
  monitoring: 6,
  done_unseen: 7,
  idle: 8,
  offline: 9,
};

/**
 * Everything the derivation reads. Deliberately structural rather than
 * `OrchestrationThreadShell`: the server derives from projection rows and the
 * clients from the shell, and both must get the same answer.
 */
export interface BatonSessionStateInput {
  /** False when the environment is unreachable; nothing else is trustworthy then. */
  readonly environmentOnline: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly sessionStatus:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error"
    | null;
  readonly sessionLastError: string | null;
  readonly backgroundLiveness: "working" | "monitoring" | null;
  readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
  readonly latestTurnCompletedAt: string | null;
  /** When the user last opened this thread. Null means never. */
  readonly lastVisitedAt: string | null;
  /**
   * True when the provider account this thread runs on has reported a quota
   * window at 100%. The provider says so; nothing here guesses it.
   */
  readonly providerQuotaExhausted: boolean;
}

/** A turn that finished after the user last looked at it. */
export const hasUnseenCompletion = (input: {
  readonly latestTurnCompletedAt: string | null;
  readonly lastVisitedAt: string | null;
}): boolean => {
  if (input.latestTurnCompletedAt === null) return false;
  const completedAt = Date.parse(input.latestTurnCompletedAt);
  if (Number.isNaN(completedAt)) return false;
  if (input.lastVisitedAt === null) return true;
  const lastVisitedAt = Date.parse(input.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) ? true : completedAt > lastVisitedAt;
};

/**
 * The §10 ladder, in order. Each rung is a fact the environment reported, not
 * an inference.
 */
export function deriveBatonSessionState(input: BatonSessionStateInput): BatonSessionState {
  // Reachability first: a cached "working" from an environment that dropped
  // is the one state that actively misleads.
  if (!input.environmentOnline) return "offline";

  // The provider is blocked on the user. This outranks a running session
  // because a session waiting on an approval is not making progress.
  if (input.hasPendingApprovals) return "needs_approval";
  if (input.hasPendingUserInput) return "needs_input";

  // A failure must be seen, and it outranks lingering background liveness.
  if (input.sessionStatus === "error" || input.sessionLastError !== null) return "failed";
  if (input.latestTurnState === "error") return "failed";

  // An exhausted account is why the work stopped, and it is the state that
  // tells the user a handoff is available (§31 Scenario E). It sits below
  // failure because a failed session needs attention first, and above idle
  // because "idle" would hide the reason.
  if (input.providerQuotaExhausted && !isProviderBusy(input)) return "limited";

  if (input.sessionStatus === "starting") return "starting";
  if (input.sessionStatus === "running") return "working";

  // Background work outlives the turn: subagents and workflows read as
  // working, watch loops alone as monitoring.
  if (input.backgroundLiveness === "working") return "working";
  if (input.backgroundLiveness === "monitoring") return "monitoring";

  if (input.latestTurnState === "running") return "working";

  if (hasUnseenCompletion(input)) return "done_unseen";

  return "idle";
}

const isProviderBusy = (input: BatonSessionStateInput): boolean =>
  input.sessionStatus === "running" ||
  input.sessionStatus === "starting" ||
  input.backgroundLiveness !== null ||
  input.latestTurnState === "running";

/**
 * A work session's state, as distinct from one thread's.
 *
 * A work session can have several live threads — an implementation session and
 * a review session are intentional (§5.4) — so the fleet needs one answer for
 * the work. It is the most demanding of its live threads, by
 * `BATON_STATE_PRIORITY`: if anything under this work needs the user, the
 * work needs the user.
 *
 * No live thread at all is `idle`, not `offline`: the work exists and is
 * between providers, which is a normal state and the reason the object exists.
 */
export function deriveWorkSessionState(
  threadStates: ReadonlyArray<BatonSessionState>,
): BatonSessionState {
  if (threadStates.length === 0) return "idle";
  return threadStates.reduce((best, candidate) =>
    BATON_STATE_PRIORITY[candidate] < BATON_STATE_PRIORITY[best] ? candidate : best,
  );
}

/** Wire shape for one entry in the fleet. */
export const BatonFleetEntryState = Schema.Struct({
  state: BatonSessionState,
  observedAt: IsoDateTime,
});
export type BatonFleetEntryState = typeof BatonFleetEntryState.Type;

/** Human labels, shared so every surface names a state the same way. */
export const BATON_STATE_LABELS: Readonly<Record<BatonSessionState, string>> = {
  starting: "Starting",
  working: "Working",
  monitoring: "Monitoring",
  needs_approval: "Approval needed",
  needs_input: "Needs you",
  done_unseen: "Done",
  idle: "Idle",
  limited: "Account limit reached",
  offline: "Offline",
  failed: "Failed",
};

/**
 * The §33 glyphs: `●` working, `!` needs the user, `◐` reviewing/monitoring,
 * `✓` done. One character, because the fleet has to be readable at a glance
 * and colour alone is not a signal everyone receives.
 */
export const BATON_STATE_GLYPHS: Readonly<Record<BatonSessionState, string>> = {
  starting: "◌",
  working: "●",
  monitoring: "◐",
  needs_approval: "!",
  needs_input: "!",
  done_unseen: "✓",
  idle: "·",
  limited: "!",
  offline: "×",
  failed: "!",
};
