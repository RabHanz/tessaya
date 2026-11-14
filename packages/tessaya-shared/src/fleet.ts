/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Building the fleet: work sessions plus the threads under them, each with a
 * state derived from facts the environment already reported.
 *
 * One implementation, two callers. The server answers `fabric.fleet.get` with
 * it, and the web client rebuilds it locally from the thread shells it already
 * streams, so the two cannot disagree about what "working" means.
 *
 * They do differ in one input, on purpose. `lastVisitedAt` — when *this user*
 * last opened a thread — is client state; the environment has no idea. A
 * server therefore passes null and its `done_unseen` means "a turn completed
 * and nothing has been recorded since", while a client passes its real value
 * and gets the stricter, truer answer. the maintainers' decision log D17.
 *
 * @module batonFleet
 */
import {
  compareFleetEntries,
  deriveTessayaSessionState,
  deriveWorkSessionState,
  BATON_STATE_PRIORITY,
  tessayaStateNeedsUser,
  type TessayaFleet,
  type TessayaFleetEntry,
  type TessayaFleetAdopted,
  type TessayaFleetThread,
  type TessayaSessionState,
  type WorkSession,
} from "@t3tools/tessaya-contracts";

/** The thread facts the derivation needs, from a shell or a projection row. */
export interface FleetThreadInput {
  readonly threadId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
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
  readonly updatedAt: string;
}

export interface FleetInput {
  readonly workSessions: ReadonlyArray<WorkSession>;
  /** Keyed by thread id. A thread the environment no longer has is simply absent. */
  readonly threads: ReadonlyMap<string, FleetThreadInput>;
  readonly environmentOnline: boolean;
  /** Provider instances whose account has reported an exhausted quota window. */
  readonly exhaustedProviderInstanceIds: ReadonlySet<string>;
  /** When this client last opened a thread. Null everywhere on a server. */
  readonly lastVisitedAt: (threadId: string) => string | null;
  /**
   * Adopted sessions (§9) by work session id. Absent means none, which is the
   * answer on every environment without an external runtime.
   */
  readonly adopted?: ReadonlyMap<string, ReadonlyArray<TessayaFleetAdopted>> | undefined;
  readonly observedAt: string;
}

export function buildTessayaFleet(input: FleetInput): TessayaFleet {
  const entries: TessayaFleetEntry[] = [];

  for (const workSession of input.workSessions) {
    const live = workSession.providerSessions.filter((session) => session.detachedAt === null);
    const threads: TessayaFleetThread[] = [];

    for (const providerSession of live) {
      const thread = input.threads.get(providerSession.threadId);
      // The attachment outlived the thread. That is the invariant the whole
      // domain exists for, so it contributes no thread row and no state.
      if (thread === undefined) continue;
      const state = deriveTessayaSessionState({
        environmentOnline: input.environmentOnline,
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        sessionStatus: thread.sessionStatus,
        sessionLastError: thread.sessionLastError,
        backgroundLiveness: thread.backgroundLiveness,
        latestTurnState: thread.latestTurnState,
        latestTurnCompletedAt: thread.latestTurnCompletedAt,
        lastVisitedAt: input.lastVisitedAt(providerSession.threadId),
        providerQuotaExhausted:
          providerSession.providerInstanceId !== null &&
          input.exhaustedProviderInstanceIds.has(providerSession.providerInstanceId),
      });
      threads.push({
        threadId: providerSession.threadId,
        title: thread.title,
        state,
        providerInstanceId: providerSession.providerInstanceId,
        providerDriver: providerSession.providerDriver,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        lastActivityAt: thread.updatedAt,
      });
    }

    const adopted = input.adopted?.get(workSession.id) ?? [];
    // An adopted terminal that is blocked makes the *work* need the user, the
    // same as one of ours would. A session Baton cannot control still tells
    // the truth about what the work is waiting for.
    const state = input.environmentOnline
      ? deriveWorkSessionState([
          ...threads.map((thread) => thread.state),
          ...adopted.map((session) => session.state),
        ])
      : "offline";

    entries.push({
      workSessionId: workSession.id,
      title: workSession.title,
      projectId: workSession.projectId,
      lifecycle: workSession.status,
      state,
      needsUser: tessayaStateNeedsUser(state),
      activeThreadId: workSession.activeThreadId,
      threads,
      adopted,
      synopsis: workSession.synopsis ?? null,
      // The synopsis moves far more often than the record, so it is what
      // "recently" means for ordering. Falling back to the record's own
      // timestamp keeps a work session that has never run in the list.
      updatedAt: workSession.synopsis?.updatedAt ?? workSession.updatedAt,
    });
  }

  entries.sort((left, right) => compareFleetEntries(left, right, BATON_STATE_PRIORITY));
  return { entries, observedAt: input.observedAt };
}

export const filterFleetNeedsUser = (fleet: TessayaFleet): TessayaFleet => ({
  ...fleet,
  entries: fleet.entries.filter((entry) => entry.needsUser),
});

/** The states a fleet row can be in, for a legend or a filter control. */
export const FLEET_FILTER_STATES: ReadonlyArray<TessayaSessionState> = [
  "needs_approval",
  "needs_input",
  "working",
  "done_unseen",
  "idle",
];
