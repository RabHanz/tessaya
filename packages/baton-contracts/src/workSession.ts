/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton WorkSession contracts.
 *
 * A thread is the durable conversation for a project. A **WorkSession** is the
 * durable identity of the user's *work* — it outlives the thread, and it
 * outlives the provider account that happened to be running when the work
 * started. One WorkSession can own several provider threads in sequence
 * (Claude A, then Claude B, then Codex for review) or, deliberately, in
 * parallel.
 *
 * The invariant this exists to hold: **ending a thread must not end the work.**
 * Nothing in this module lets a WorkSession's lifetime be derived from a
 * thread's.
 *
 * Environment scoping follows the rest of T3: a WorkSession is owned by the
 * environment that serves it, exactly as a project and its threads are
 * (`docs/internals/remote.md`). The wire shape therefore carries no
 * environment id; the client tags records with the environment it read them
 * from and merges across environments locally. `environmentAffinity` is a
 * different thing — the environments this work is *intended* for, which is
 * what handoff and machine-capability routing need.
 *
 * @module baton/workSession
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import { RepositoryIdentity } from "@t3tools/contracts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { WorkSessionSynopsis } from "./synopsis.ts";
import { renamedKind } from "./renamed.ts";

// Legacy names (D71): wire methods, event types and error tags keep "fabric"; the event store holds them.
export const BATON_WS_METHODS = {
  workSessionList: "fabric.workSession.list",
  workSessionCreate: "fabric.workSession.create",
  workSessionUpdate: "fabric.workSession.update",
  workSessionAttachThread: "fabric.workSession.attachThread",
  workSessionDetachThread: "fabric.workSession.detachThread",
  workSessionStartThread: "fabric.workSession.startThread",
  workSessionSettle: "fabric.workSession.settle",
  workSessionUnsettle: "fabric.workSession.unsettle",
  workSessionArchive: "fabric.workSession.archive",
  workSessionUnarchive: "fabric.workSession.unarchive",
  fleetGet: "fabric.fleet.get",
  subscribeWorkSessions: "fabric.subscribeWorkSessions",
} as const;

export const WorkSessionId = TrimmedNonEmptyString.pipe(Schema.brand("WorkSessionId"));
export type WorkSessionId = typeof WorkSessionId.Type;

/**
 * Lifecycle, mirroring how T3 treats threads: settlement and archival are
 * separate, both reversible, and neither is inferred from provider state.
 * `settled` means the work is done; `archived` means it is out of view.
 */
export const WorkSessionStatus = Schema.Literals(["active", "settled", "archived"]);
export type WorkSessionStatus = typeof WorkSessionStatus.Type;

/** The specification's §24.1 bands. Carried on the work, not on the thread. */
export const WorkSessionRiskClass = Schema.Literals(["low", "medium", "high"]);
export type WorkSessionRiskClass = typeof WorkSessionRiskClass.Type;

export const WorkSessionPriority = Schema.Literals(["low", "normal", "high"]);
export type WorkSessionPriority = typeof WorkSessionPriority.Type;

/**
 * What a provider thread is doing for this work. `review` sessions are
 * expected to be read-only against the same branch; `adopted` marks a thread
 * Baton did not start and whose structured state may be incomplete.
 */
export const WorkSessionProviderRole = Schema.Literals(["implementation", "review", "adopted"]);
export type WorkSessionProviderRole = typeof WorkSessionProviderRole.Type;

/** Whether this WorkSession started the thread or adopted an existing one. */
export const WorkSessionProviderOrigin = Schema.Literals(["created", "attached"]);
export type WorkSessionProviderOrigin = typeof WorkSessionProviderOrigin.Type;

/**
 * One stretch of the work performed by one provider thread.
 *
 * The provider instance and driver are captured **at attach time** and never
 * refreshed. That is deliberate: the timeline has to keep reading
 * "Claude A 09:10–10:32" after the thread's model selection changes, after the
 * instance is renamed, and after the thread itself is deleted. Live state
 * (working, idle, needs input) is not here — it belongs to the thread, which
 * clients already stream.
 */
export const WorkSessionProviderSession = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerDriver: Schema.NullOr(ProviderDriverKind),
  role: WorkSessionProviderRole,
  origin: WorkSessionProviderOrigin,
  attachedAt: IsoDateTime,
  detachedAt: Schema.NullOr(IsoDateTime),
});
export type WorkSessionProviderSession = typeof WorkSessionProviderSession.Type;

export const WorkSession = Schema.Struct({
  id: WorkSessionId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** Why this work exists, in the user's words. May be empty. */
  objective: TrimmedString,
  constraints: Schema.Array(TrimmedNonEmptyString),
  acceptanceCriteria: Schema.Array(TrimmedNonEmptyString),
  /** Environments this work is intended for. Not a claim of ownership. */
  environmentAffinity: Schema.Array(EnvironmentId),
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  /** The checkout a provider thread for this work should normally run in. */
  primaryWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  status: WorkSessionStatus,
  riskClass: WorkSessionRiskClass,
  priority: WorkSessionPriority,
  /**
   * The thread the user is currently working through. Null is a normal
   * state, not a broken one: a WorkSession between providers has no active
   * thread and is still the same piece of work.
   */
  activeThreadId: Schema.NullOr(ThreadId),
  /** Oldest first. The §5.4 timeline. */
  providerSessions: Schema.Array(WorkSessionProviderSession),
  /**
   * The Working Synopsis (§11), updated deterministically from events. Null
   * until something has happened. Optional on the wire so a client from before
   * Phase 4 still decodes a Phase 4 server's payloads.
   */
  synopsis: Schema.optional(Schema.NullOr(WorkSessionSynopsis)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type WorkSession = typeof WorkSession.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WorkSessionNotFoundError extends Schema.TaggedError<WorkSessionNotFoundError>()(
  "WorkSessionNotFoundError",
  { workSessionId: WorkSessionId },
) {
  override get message(): string {
    return `Work session ${this.workSessionId} was not found on this environment.`;
  }
}

export class WorkSessionThreadConflictError extends Schema.TaggedError<WorkSessionThreadConflictError>()(
  "WorkSessionThreadConflictError",
  {
    threadId: ThreadId,
    /** The work session that already holds a live attachment for this thread. */
    heldBy: WorkSessionId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is already attached to work session ${this.heldBy}. Detach it there first.`;
  }
}

export class WorkSessionThreadNotAttachedError extends Schema.TaggedError<WorkSessionThreadNotAttachedError>()(
  "WorkSessionThreadNotAttachedError",
  { workSessionId: WorkSessionId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not attached to work session ${this.workSessionId}.`;
  }
}

/**
 * Persistence failed. The cause is a defect rather than a typed SQL error so
 * a storage detail never becomes part of the wire contract.
 */
export class WorkSessionStorageError extends Schema.TaggedError<WorkSessionStorageError>()(
  "WorkSessionStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Work session storage failed during ${this.operation}.`;
  }
}

export const WorkSessionError = Schema.Union([
  WorkSessionNotFoundError,
  WorkSessionThreadConflictError,
  WorkSessionThreadNotAttachedError,
  WorkSessionStorageError,
]);
export type WorkSessionError = typeof WorkSessionError.Type;

// ---------------------------------------------------------------------------
// RPC payloads
// ---------------------------------------------------------------------------

export const WorkSessionListInput = Schema.Struct({
  /** Archived work is hidden by default, the way archived threads are. */
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type WorkSessionListInput = typeof WorkSessionListInput.Type;

export const WorkSessionListResult = Schema.Struct({
  workSessions: Schema.Array(WorkSession),
});
export type WorkSessionListResult = typeof WorkSessionListResult.Type;

/**
 * The id is supplied by the caller, as thread ids are. Creating twice with the
 * same id returns the existing record untouched, so a retry after a dropped
 * response cannot produce two work sessions for one intent.
 */
export const WorkSessionCreateInput = Schema.Struct({
  id: WorkSessionId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  objective: Schema.optionalKey(TrimmedString),
  constraints: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  acceptanceCriteria: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  environmentAffinity: Schema.optionalKey(Schema.Array(EnvironmentId)),
  repositoryIdentity: Schema.optionalKey(Schema.NullOr(RepositoryIdentity)),
  primaryWorktreePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  baseBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  riskClass: Schema.optionalKey(WorkSessionRiskClass),
  priority: Schema.optionalKey(WorkSessionPriority),
});
export type WorkSessionCreateInput = typeof WorkSessionCreateInput.Type;

/** Absent keys are left alone; an explicit null clears a nullable field. */
export const WorkSessionUpdateInput = Schema.Struct({
  id: WorkSessionId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  objective: Schema.optionalKey(TrimmedString),
  constraints: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  acceptanceCriteria: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  environmentAffinity: Schema.optionalKey(Schema.Array(EnvironmentId)),
  repositoryIdentity: Schema.optionalKey(Schema.NullOr(RepositoryIdentity)),
  primaryWorktreePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  baseBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  riskClass: Schema.optionalKey(WorkSessionRiskClass),
  priority: Schema.optionalKey(WorkSessionPriority),
  activeThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
});
export type WorkSessionUpdateInput = typeof WorkSessionUpdateInput.Type;

export const WorkSessionAttachThreadInput = Schema.Struct({
  id: WorkSessionId,
  threadId: ThreadId,
  role: Schema.optionalKey(WorkSessionProviderRole),
  /**
   * Captured by the caller from the thread it is attaching, because the
   * timeline must survive that thread changing model or being deleted.
   */
  providerInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  providerDriver: Schema.optionalKey(Schema.NullOr(ProviderDriverKind)),
  /** Make this the active thread. Defaults to true for implementation roles. */
  makeActive: Schema.optionalKey(Schema.Boolean),
});
export type WorkSessionAttachThreadInput = typeof WorkSessionAttachThreadInput.Type;

export const WorkSessionDetachThreadInput = Schema.Struct({
  id: WorkSessionId,
  threadId: ThreadId,
});
export type WorkSessionDetachThreadInput = typeof WorkSessionDetachThreadInput.Type;

/**
 * Start a provider thread inside this work session.
 *
 * The payload is the thread T3 would have created anyway; the server
 * dispatches it through the ordinary orchestration engine and then records the
 * attachment, so there is exactly one thread-creation path. `branch` and
 * `worktreePath` default to the work session's own, which is what keeps
 * sequential providers in the same checkout.
 */
export const WorkSessionStartThreadInput = Schema.Struct({
  id: WorkSessionId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  branch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  role: Schema.optionalKey(WorkSessionProviderRole),
});
export type WorkSessionStartThreadInput = typeof WorkSessionStartThreadInput.Type;

export const WorkSessionRefInput = Schema.Struct({ id: WorkSessionId });
export type WorkSessionRefInput = typeof WorkSessionRefInput.Type;

export const WorkSessionResult = Schema.Struct({ workSession: WorkSession });
export type WorkSessionResult = typeof WorkSessionResult.Type;

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/**
 * Event names are the specification's §28 families verbatim, so the wire is
 * traceable to the contract that asked for it. Each event carries the whole
 * record: a client applies it without a follow-up read, the way the shell
 * stream's `thread-upserted` does.
 *
 * These are a live broadcast, not a durable log. The durable truth is the
 * work-session rows and their thread attachments — see
 * the maintainers' decision log D11 for why Baton deliberately keeps its events
 * out of T3's orchestration event store.
 */
export const WorkSessionStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    workSessions: Schema.Array(WorkSession),
  }),
  Schema.Struct({
    kind: renamedKind("fabric.workSession.created"),
    workSession: WorkSession,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.workSession.updated"),
    workSession: WorkSession,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.workSession.statusChanged"),
    workSession: WorkSession,
    previousStatus: WorkSessionStatus,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.workSession.providerAttached"),
    workSession: WorkSession,
    providerSession: WorkSessionProviderSession,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.workSession.providerDetached"),
    workSession: WorkSession,
    providerSession: WorkSessionProviderSession,
  }),
  // §28's synopsis family. Separate from `.updated` because a synopsis moves
  // far more often than the work session's own fields, and a surface showing
  // only the synopsis should not repaint for a title change.
  Schema.Struct({
    kind: renamedKind("fabric.synopsis.updated"),
    workSessionId: WorkSessionId,
    synopsis: WorkSessionSynopsis,
  }),
]);
export type WorkSessionStreamItem = typeof WorkSessionStreamItem.Type;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export const DEFAULT_WORK_SESSION_RISK_CLASS: WorkSessionRiskClass = "low";
export const DEFAULT_WORK_SESSION_PRIORITY: WorkSessionPriority = "normal";
export const DEFAULT_WORK_SESSION_PROVIDER_ROLE: WorkSessionProviderRole = "implementation";

/**
 * The attachment currently running this work, if any. Several can be live at
 * once — a review session alongside an implementation session is intentional
 * (§5.4) — so this answers "which one is the user working through", not "how
 * many are alive".
 */
export const activeProviderSession = (
  workSession: WorkSession,
): WorkSessionProviderSession | null => {
  if (workSession.activeThreadId === null) return null;
  const activeThreadId = workSession.activeThreadId;
  return (
    workSession.providerSessions.find(
      (session) => session.threadId === activeThreadId && session.detachedAt === null,
    ) ?? null
  );
};

/** Every thread this work session currently holds, in attach order. */
export const liveProviderSessions = (
  workSession: WorkSession,
): ReadonlyArray<WorkSessionProviderSession> =>
  workSession.providerSessions.filter((session) => session.detachedAt === null);

/**
 * Work sessions this thread belongs to. The server enforces at most one live
 * attachment per thread, so this returns at most one work session for a live
 * lookup; detached history can name several.
 */
export const findWorkSessionForThread = (
  workSessions: ReadonlyArray<WorkSession>,
  threadId: ThreadId,
): WorkSession | null =>
  workSessions.find((workSession) =>
    workSession.providerSessions.some(
      (session) => session.threadId === threadId && session.detachedAt === null,
    ),
  ) ?? null;

/**
 * Status a work session should have given its timestamps. Archival outranks
 * settlement so an archived-then-settled record does not read as active.
 */
export const resolveWorkSessionStatus = (input: {
  readonly settledAt: string | null;
  readonly archivedAt: string | null;
}): WorkSessionStatus =>
  input.archivedAt !== null ? "archived" : input.settledAt !== null ? "settled" : "active";
