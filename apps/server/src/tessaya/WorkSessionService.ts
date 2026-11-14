/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Baton work sessions: the user's work as an object that outlives the
 * provider thread and the account running it.
 *
 * The rule this phase exists for: **nothing here ends a work session because a
 * thread ended.** A thread can stop, fail, be archived, or be deleted, and the
 * work session keeps its identity, its objective, its worktree, and its record
 * of who ran it when. Only an explicit settle or archive changes its status,
 * and both are reversible.
 *
 * Mutations are serialized through one semaphore. Every one is a
 * read-modify-write across two tables, and two connections doing that at once
 * would interleave into a record that never existed.
 *
 * Events are a live broadcast, not a durable log — the durable truth is the
 * rows. the maintainers' decision log D11 explains why Baton keeps its events out
 * of T3's orchestration event store.
 */
import { applySynopsisSignals, type SynopsisSignal } from "@t3tools/tessaya-shared/synopsis";
import {
  DEFAULT_WORK_SESSION_PRIORITY,
  DEFAULT_WORK_SESSION_PROVIDER_ROLE,
  DEFAULT_WORK_SESSION_RISK_CLASS,
  EMPTY_SYNOPSIS,
  resolveWorkSessionStatus,
  WorkSessionNotFoundError,
  WorkSessionStorageError,
  WorkSessionThreadConflictError,
  WorkSessionThreadNotAttachedError,
  type WorkSession,
  type WorkSessionAttachThreadInput,
  type WorkSessionCreateInput,
  type WorkSessionDetachThreadInput,
  type WorkSessionError,
  type WorkSessionId,
  type WorkSessionListInput,
  type WorkSessionProviderOrigin,
  type WorkSessionProviderSession,
  type WorkSessionRefInput,
  type WorkSessionStreamItem,
  type WorkSessionSynopsis,
  type WorkSessionUpdateInput,
  type ThreadId,
} from "@t3tools/tessaya-contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  layer as workSessionRepositoryLayer,
  WorkSessionRepository,
  type WorkSessionRow,
  type WorkSessionThreadRow,
} from "./WorkSessionRepository.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toProviderSession = (row: WorkSessionThreadRow): WorkSessionProviderSession => ({
  threadId: row.threadId,
  providerInstanceId: row.providerInstanceId,
  providerDriver: row.providerDriver,
  role: row.role,
  origin: row.origin,
  attachedAt: row.attachedAt,
  detachedAt: row.detachedAt,
});

/**
 * Join a stored row with its thread attachments into the wire shape. Exported
 * because the assembly — in particular that `status` is derived and never
 * stored — is worth testing directly.
 */
export const assembleWorkSession = (
  row: WorkSessionRow,
  threads: ReadonlyArray<WorkSessionThreadRow>,
): WorkSession => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  objective: row.objective,
  constraints: row.constraints,
  acceptanceCriteria: row.acceptanceCriteria,
  environmentAffinity: row.environmentAffinity,
  repositoryIdentity: row.repositoryIdentity,
  primaryWorktreePath: row.primaryWorktreePath,
  baseBranch: row.baseBranch,
  status: resolveWorkSessionStatus({ settledAt: row.settledAt, archivedAt: row.archivedAt }),
  riskClass: row.riskClass,
  priority: row.priority,
  activeThreadId: row.activeThreadId,
  providerSessions: threads.map(toProviderSession),
  synopsis: row.synopsis,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  settledAt: row.settledAt,
  archivedAt: row.archivedAt,
});

export class WorkSessionService extends Context.Service<
  WorkSessionService,
  {
    readonly list: (
      input: WorkSessionListInput,
    ) => Effect.Effect<ReadonlyArray<WorkSession>, WorkSessionError>;
    readonly get: (id: WorkSessionId) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly create: (
      input: WorkSessionCreateInput,
    ) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly update: (
      input: WorkSessionUpdateInput,
    ) => Effect.Effect<WorkSession, WorkSessionError>;
    /**
     * `origin` is not on the wire input: a client attaching a thread has by
     * definition adopted an existing one. Only the server's own
     * start-thread path sets `created`, right after it dispatched the
     * `thread.create` command.
     */
    readonly attachThread: (
      input: WorkSessionAttachThreadInput & {
        readonly origin?: WorkSessionProviderOrigin;
      },
    ) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly detachThread: (
      input: WorkSessionDetachThreadInput,
    ) => Effect.Effect<WorkSession, WorkSessionError>;
    /**
     * Fold signals into the work session's synopsis and persist the result.
     *
     * Returns the synopsis rather than the work session because the caller is
     * an event reactor, not a user action: nothing else about the work
     * changed, and `updatedAt` on the record deliberately does not move for a
     * synopsis update. A work session that has only been watched is not a work
     * session that has been worked on, and the fleet's recency ordering has to
     * keep telling those apart.
     */
    readonly applySynopsis: (input: {
      readonly workSessionId: WorkSessionId;
      readonly signals: ReadonlyArray<SynopsisSignal>;
    }) => Effect.Effect<WorkSessionSynopsis | null, WorkSessionError>;
    /** The work session holding a live attachment for this thread, if any. */
    readonly findForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<WorkSessionId | null, WorkSessionError>;
    readonly settle: (input: WorkSessionRefInput) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly unsettle: (input: WorkSessionRefInput) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly archive: (input: WorkSessionRefInput) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly unarchive: (
      input: WorkSessionRefInput,
    ) => Effect.Effect<WorkSession, WorkSessionError>;
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<WorkSessionStreamItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/tessaya/WorkSessionService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* WorkSessionRepository;
  const events = yield* PubSub.unbounded<WorkSessionStreamItem>();
  const mutations = yield* Semaphore.make(1);

  const storageFailure = (operation: string) => (cause: ProjectionRepositoryError) =>
    new WorkSessionStorageError({ operation, cause });

  const hydrate = (row: WorkSessionRow) =>
    repository.listThreads(row.id).pipe(
      Effect.mapError(storageFailure("listThreads")),
      Effect.map((threads) => assembleWorkSession(row, threads)),
    );

  const requireRow = (id: WorkSessionId) =>
    repository.get(id).pipe(
      Effect.mapError(storageFailure("get")),
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(new WorkSessionNotFoundError({ workSessionId: id }))
          : Effect.succeed(row),
      ),
    );

  const publish = (item: WorkSessionStreamItem) => PubSub.publish(events, item).pipe(Effect.asVoid);

  /** Persist a changed row with a fresh `updatedAt`, and return the wire shape. */
  const writeRow = (next: WorkSessionRow) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      const stamped: WorkSessionRow = { ...next, updatedAt };
      yield* repository.update(stamped).pipe(Effect.mapError(storageFailure("update")));
      return yield* hydrate(stamped);
    });

  const list: WorkSessionService["Service"]["list"] = (input) =>
    repository.list({ includeArchived: input.includeArchived ?? false }).pipe(
      Effect.mapError(storageFailure("list")),
      Effect.flatMap((rows) => Effect.forEach(rows, hydrate)),
    );

  const get: WorkSessionService["Service"]["get"] = (id) =>
    requireRow(id).pipe(Effect.flatMap(hydrate));

  const create: WorkSessionService["Service"]["create"] = (input) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const timestamp = yield* nowIso;
        const row: WorkSessionRow = {
          id: input.id,
          projectId: input.projectId,
          title: input.title,
          objective: input.objective ?? "",
          constraints: input.constraints ?? [],
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          environmentAffinity: input.environmentAffinity ?? [],
          repositoryIdentity: input.repositoryIdentity ?? null,
          primaryWorktreePath: input.primaryWorktreePath ?? null,
          baseBranch: input.baseBranch ?? null,
          riskClass: input.riskClass ?? DEFAULT_WORK_SESSION_RISK_CLASS,
          priority: input.priority ?? DEFAULT_WORK_SESSION_PRIORITY,
          activeThreadId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          settledAt: null,
          archivedAt: null,
          // Nothing has happened yet; a synopsis with no observation behind it
          // would be a blank card pretending to be a report.
          synopsis: null,
        };
        const inserted = yield* repository
          .insert(row)
          .pipe(Effect.mapError(storageFailure("insert")));
        // Creating twice with one id is a retry, not a second piece of work.
        if (inserted === null) return yield* get(input.id);
        const workSession = yield* hydrate(inserted);
        yield* publish({ kind: "fabric.workSession.created", workSession });
        return workSession;
      }),
    );

  const update: WorkSessionService["Service"]["update"] = (input) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const current = yield* requireRow(input.id);
        const next: WorkSessionRow = {
          ...current,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.objective === undefined ? {} : { objective: input.objective }),
          ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
          ...(input.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: input.acceptanceCriteria }),
          ...(input.environmentAffinity === undefined
            ? {}
            : { environmentAffinity: input.environmentAffinity }),
          ...(input.repositoryIdentity === undefined
            ? {}
            : { repositoryIdentity: input.repositoryIdentity }),
          ...(input.primaryWorktreePath === undefined
            ? {}
            : { primaryWorktreePath: input.primaryWorktreePath }),
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
          ...(input.riskClass === undefined ? {} : { riskClass: input.riskClass }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.activeThreadId === undefined ? {} : { activeThreadId: input.activeThreadId }),
        };
        const workSession = yield* writeRow(next);
        yield* publish({ kind: "fabric.workSession.updated", workSession });
        return workSession;
      }),
    );

  const attachThread: WorkSessionService["Service"]["attachThread"] = (input) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const current = yield* requireRow(input.id);
        const live = yield* repository
          .findLiveAttachment(input.threadId)
          .pipe(Effect.mapError(storageFailure("findLiveAttachment")));
        if (live !== null && live.workSessionId !== current.id) {
          return yield* new WorkSessionThreadConflictError({
            threadId: input.threadId,
            heldBy: live.workSessionId,
          });
        }
        // Already attached here: a retry, not a second stretch of work.
        if (live !== null) return yield* hydrate(current);

        const role = input.role ?? DEFAULT_WORK_SESSION_PROVIDER_ROLE;
        const attachedAt = yield* nowIso;
        const threadRow: WorkSessionThreadRow = {
          workSessionId: current.id,
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId ?? null,
          providerDriver: input.providerDriver ?? null,
          role,
          origin: input.origin ?? "attached",
          attachedAt,
          detachedAt: null,
        };
        yield* repository
          .attachThread(threadRow)
          .pipe(Effect.mapError(storageFailure("attachThread")));

        // A review session running beside an implementation session must not
        // steal focus, so only implementation roles become active by default.
        const makeActive = input.makeActive ?? role === "implementation";
        const workSession = yield* writeRow(
          makeActive ? { ...current, activeThreadId: input.threadId } : current,
        );
        yield* publish({
          kind: "fabric.workSession.providerAttached",
          workSession,
          providerSession: toProviderSession(threadRow),
        });
        return workSession;
      }),
    );

  const detachThread: WorkSessionService["Service"]["detachThread"] = (input) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const current = yield* requireRow(input.id);
        const live = yield* repository
          .findLiveAttachment(input.threadId)
          .pipe(Effect.mapError(storageFailure("findLiveAttachment")));
        if (live === null || live.workSessionId !== current.id) {
          return yield* new WorkSessionThreadNotAttachedError({
            workSessionId: current.id,
            threadId: input.threadId,
          });
        }
        const detachedAt = yield* nowIso;
        yield* repository
          .detachThread({ workSessionId: current.id, threadId: input.threadId, detachedAt })
          .pipe(Effect.mapError(storageFailure("detachThread")));

        // The work session carries on with no active thread. That is the state
        // between two providers, and it is normal rather than broken.
        const workSession = yield* writeRow(
          current.activeThreadId === input.threadId
            ? { ...current, activeThreadId: null }
            : current,
        );
        yield* publish({
          kind: "fabric.workSession.providerDetached",
          workSession,
          providerSession: toProviderSession({ ...live, detachedAt }),
        });
        return workSession;
      }),
    );

  const changeStatus = (
    id: WorkSessionId,
    change: (row: WorkSessionRow, timestamp: string) => WorkSessionRow,
  ) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const current = yield* requireRow(id);
        const previousStatus = resolveWorkSessionStatus(current);
        const timestamp = yield* nowIso;
        const workSession = yield* writeRow(change(current, timestamp));
        yield* publish({ kind: "fabric.workSession.statusChanged", workSession, previousStatus });
        return workSession;
      }),
    );

  const applySynopsis: WorkSessionService["Service"]["applySynopsis"] = ({
    workSessionId,
    signals,
  }) =>
    signals.length === 0
      ? Effect.succeed(null)
      : Semaphore.withPermit(
          mutations,
          Effect.gen(function* () {
            const current = yield* repository
              .get(workSessionId)
              .pipe(Effect.mapError(storageFailure("get")));
            // A reactor can outlive the work session it was following. That is
            // not an error; there is simply nothing to write.
            if (current === null) return null;
            const base = current.synopsis ?? EMPTY_SYNOPSIS(signals[0]?.at ?? (yield* nowIso));
            const next = applySynopsisSignals(base, signals);
            // Nothing moved: writing anyway would refresh the staleness clock
            // for an update that said nothing, which §11 warns against
            // specifically. Identity is the right test — the reducer returns
            // its input unchanged for a signal that carried nothing, and
            // comparing timestamps instead would swallow a first update whose
            // signal happens to share the empty record's instant.
            if (next === base) return current.synopsis;
            // `updatedAt` on the row is deliberately preserved: see the
            // interface comment.
            yield* repository
              .update({ ...current, synopsis: next })
              .pipe(Effect.mapError(storageFailure("update")));
            yield* publish({
              kind: "fabric.synopsis.updated",
              workSessionId,
              synopsis: next,
            });
            return next;
          }),
        );

  const findForThread: WorkSessionService["Service"]["findForThread"] = (threadId) =>
    repository.findLiveAttachment(threadId).pipe(
      Effect.mapError(storageFailure("findLiveAttachment")),
      Effect.map((attachment) => attachment?.workSessionId ?? null),
    );

  const settle: WorkSessionService["Service"]["settle"] = ({ id }) =>
    changeStatus(id, (row, timestamp) => ({ ...row, settledAt: row.settledAt ?? timestamp }));

  const unsettle: WorkSessionService["Service"]["unsettle"] = ({ id }) =>
    changeStatus(id, (row) => ({ ...row, settledAt: null }));

  // Archiving keeps the timeline. The work's history is the point of the
  // object, and hiding it from a list is not a reason to forget who ran it.
  const archive: WorkSessionService["Service"]["archive"] = ({ id }) =>
    changeStatus(id, (row, timestamp) => ({ ...row, archivedAt: row.archivedAt ?? timestamp }));

  const unarchive: WorkSessionService["Service"]["unarchive"] = ({ id }) =>
    changeStatus(id, (row) => ({ ...row, archivedAt: null }));

  return {
    list,
    get,
    create,
    update,
    attachThread,
    detachThread,
    applySynopsis,
    findForThread,
    settle,
    unsettle,
    archive,
    unarchive,
    subscribe: PubSub.subscribe(events),
  } satisfies WorkSessionService["Service"];
});

/**
 * Snapshot then events, subscribing before the read so nothing that happens
 * between the two is lost. Same shape as the device state stream.
 */
export const workSessionStream = (
  service: WorkSessionService["Service"],
): Stream.Stream<WorkSessionStreamItem, WorkSessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      const workSessions = yield* service.list({});
      const snapshot: WorkSessionStreamItem = { kind: "snapshot", workSessions };
      return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);

export const layer = Layer.effect(WorkSessionService, make).pipe(
  Layer.provideMerge(workSessionRepositoryLayer),
);
