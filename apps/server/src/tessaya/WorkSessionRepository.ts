/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Durable storage for Baton work sessions.
 *
 * Two tables, both written by migration 054: the work session itself, and one
 * row per stretch of work a provider thread performed for it. Everything the
 * service needs to answer "what work exists and who has been running it" is
 * here; nothing about a thread's *current* state is, because that belongs to
 * the thread projection and clients already stream it.
 *
 * `status` is not a column. It is derived from `settledAt`/`archivedAt` on
 * read, so the two can never drift apart the way a denormalized status does.
 */
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RepositoryIdentity,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  WorkSessionId,
  WorkSessionPriority,
  WorkSessionProviderOrigin,
  WorkSessionProviderRole,
  WorkSessionRiskClass,
  WorkSessionSynopsis,
} from "@t3tools/tessaya-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

/** The stored shape of a work session, before its thread rows are joined on. */
export const WorkSessionRow = Schema.Struct({
  id: WorkSessionId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  objective: TrimmedString,
  constraints: Schema.Array(TrimmedNonEmptyString),
  acceptanceCriteria: Schema.Array(TrimmedNonEmptyString),
  environmentAffinity: Schema.Array(EnvironmentId),
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  primaryWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  riskClass: WorkSessionRiskClass,
  priority: WorkSessionPriority,
  activeThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Null until the first event moves it; see migration 055. */
  synopsis: Schema.NullOr(WorkSessionSynopsis),
});
export type WorkSessionRow = typeof WorkSessionRow.Type;

export const WorkSessionThreadRow = Schema.Struct({
  workSessionId: WorkSessionId,
  threadId: ThreadId,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerDriver: Schema.NullOr(ProviderDriverKind),
  role: WorkSessionProviderRole,
  origin: WorkSessionProviderOrigin,
  attachedAt: IsoDateTime,
  detachedAt: Schema.NullOr(IsoDateTime),
});
export type WorkSessionThreadRow = typeof WorkSessionThreadRow.Type;

/** Database projection: the list-valued columns arrive as JSON text. */
const WorkSessionDbRow = WorkSessionRow.mapFields(
  Struct.assign({
    constraints: Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
    acceptanceCriteria: Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
    environmentAffinity: Schema.fromJsonString(Schema.Array(EnvironmentId)),
    repositoryIdentity: Schema.NullOr(Schema.fromJsonString(RepositoryIdentity)),
    synopsis: Schema.NullOr(Schema.fromJsonString(WorkSessionSynopsis)),
  }),
);

// Writing goes through the same codecs the reads decode with, so a column can
// never hold a shape the row schema would reject.
const encodeStringList = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
);
const encodeEnvironmentList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(EnvironmentId)));
const encodeRepositoryIdentity = Schema.encodeSync(Schema.fromJsonString(RepositoryIdentity));
const encodeSynopsis = Schema.encodeSync(Schema.fromJsonString(WorkSessionSynopsis));

const WorkSessionRefRow = Schema.Struct({ id: WorkSessionId });
const ThreadRefRow = Schema.Struct({ threadId: ThreadId });

export const ListWorkSessionsInput = Schema.Struct({ includeArchived: Schema.Boolean });
export type ListWorkSessionsInput = typeof ListWorkSessionsInput.Type;

export class WorkSessionRepository extends Context.Service<
  WorkSessionRepository,
  {
    /** Insert, or return null when a row with this id already exists. */
    readonly insert: (
      row: WorkSessionRow,
    ) => Effect.Effect<WorkSessionRow | null, ProjectionRepositoryError>;
    readonly update: (row: WorkSessionRow) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly get: (
      id: WorkSessionId,
    ) => Effect.Effect<WorkSessionRow | null, ProjectionRepositoryError>;
    readonly list: (
      input: ListWorkSessionsInput,
    ) => Effect.Effect<ReadonlyArray<WorkSessionRow>, ProjectionRepositoryError>;
    readonly listThreads: (
      id: WorkSessionId,
    ) => Effect.Effect<ReadonlyArray<WorkSessionThreadRow>, ProjectionRepositoryError>;
    /** The work session holding a live attachment for this thread, if any. */
    readonly findLiveAttachment: (
      threadId: ThreadId,
    ) => Effect.Effect<WorkSessionThreadRow | null, ProjectionRepositoryError>;
    readonly attachThread: (
      row: WorkSessionThreadRow,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    /** False when the thread held no live attachment on this work session. */
    readonly detachThread: (input: {
      readonly workSessionId: WorkSessionId;
      readonly threadId: ThreadId;
      readonly detachedAt: string;
    }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  }
>()("t3/tessaya/WorkSessionRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectById = SqlSchema.findOneOption({
    Request: WorkSessionRefRow,
    Result: WorkSessionDbRow,
    execute: ({ id }) => sql`
      SELECT
        id,
        project_id AS "projectId",
        title,
        objective,
        constraints_json AS "constraints",
        acceptance_criteria_json AS "acceptanceCriteria",
        environment_affinity_json AS "environmentAffinity",
        repository_identity_json AS "repositoryIdentity",
        primary_worktree_path AS "primaryWorktreePath",
        base_branch AS "baseBranch",
        risk_class AS "riskClass",
        priority,
        active_thread_id AS "activeThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        settled_at AS "settledAt",
        archived_at AS "archivedAt",
        synopsis_json AS "synopsis"
      FROM fabric_work_sessions
      WHERE id = ${id}
    `,
  });

  const selectActive = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: WorkSessionDbRow,
    execute: () => sql`
      SELECT
        id,
        project_id AS "projectId",
        title,
        objective,
        constraints_json AS "constraints",
        acceptance_criteria_json AS "acceptanceCriteria",
        environment_affinity_json AS "environmentAffinity",
        repository_identity_json AS "repositoryIdentity",
        primary_worktree_path AS "primaryWorktreePath",
        base_branch AS "baseBranch",
        risk_class AS "riskClass",
        priority,
        active_thread_id AS "activeThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        settled_at AS "settledAt",
        archived_at AS "archivedAt",
        synopsis_json AS "synopsis"
      FROM fabric_work_sessions
      WHERE archived_at IS NULL
      ORDER BY updated_at DESC, id ASC
    `,
  });

  const selectEvery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: WorkSessionDbRow,
    execute: () => sql`
      SELECT
        id,
        project_id AS "projectId",
        title,
        objective,
        constraints_json AS "constraints",
        acceptance_criteria_json AS "acceptanceCriteria",
        environment_affinity_json AS "environmentAffinity",
        repository_identity_json AS "repositoryIdentity",
        primary_worktree_path AS "primaryWorktreePath",
        base_branch AS "baseBranch",
        risk_class AS "riskClass",
        priority,
        active_thread_id AS "activeThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        settled_at AS "settledAt",
        archived_at AS "archivedAt",
        synopsis_json AS "synopsis"
      FROM fabric_work_sessions
      ORDER BY updated_at DESC, id ASC
    `,
  });

  const selectThreads = SqlSchema.findAll({
    Request: WorkSessionRefRow,
    Result: WorkSessionThreadRow,
    execute: ({ id }) => sql`
      SELECT
        work_session_id AS "workSessionId",
        thread_id AS "threadId",
        provider_instance_id AS "providerInstanceId",
        provider_driver AS "providerDriver",
        role,
        origin,
        attached_at AS "attachedAt",
        detached_at AS "detachedAt"
      FROM fabric_work_session_threads
      WHERE work_session_id = ${id}
      ORDER BY attached_at ASC, id ASC
    `,
  });

  const selectLiveAttachment = SqlSchema.findOneOption({
    Request: ThreadRefRow,
    Result: WorkSessionThreadRow,
    execute: ({ threadId }) => sql`
      SELECT
        work_session_id AS "workSessionId",
        thread_id AS "threadId",
        provider_instance_id AS "providerInstanceId",
        provider_driver AS "providerDriver",
        role,
        origin,
        attached_at AS "attachedAt",
        detached_at AS "detachedAt"
      FROM fabric_work_session_threads
      WHERE thread_id = ${threadId} AND detached_at IS NULL
    `,
  });

  // `SqlSchema` surfaces both SQL and row-decode failures here. Both are
  // storage faults to a caller; the operation name is what makes them
  // diagnosable.
  const asStorageError = (operation: string) => toPersistenceSqlError(operation);

  const get: WorkSessionRepository["Service"]["get"] = (id) =>
    selectById({ id }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(asStorageError("WorkSessionRepository.get")),
    );

  const insert: WorkSessionRepository["Service"]["insert"] = (row) =>
    Effect.gen(function* () {
      const existing = yield* get(row.id);
      if (existing !== null) return null;
      yield* sql`
        INSERT INTO fabric_work_sessions (
          id, project_id, title, objective,
          constraints_json, acceptance_criteria_json, environment_affinity_json,
          repository_identity_json, primary_worktree_path, base_branch,
          risk_class, priority, active_thread_id,
          created_at, updated_at, settled_at, archived_at, synopsis_json
        ) VALUES (
          ${row.id}, ${row.projectId}, ${row.title}, ${row.objective},
          ${encodeStringList(row.constraints)},
          ${encodeStringList(row.acceptanceCriteria)},
          ${encodeEnvironmentList(row.environmentAffinity)},
          ${row.repositoryIdentity === null ? null : encodeRepositoryIdentity(row.repositoryIdentity)},
          ${row.primaryWorktreePath}, ${row.baseBranch},
          ${row.riskClass}, ${row.priority}, ${row.activeThreadId},
          ${row.createdAt}, ${row.updatedAt}, ${row.settledAt}, ${row.archivedAt},
          ${row.synopsis === null ? null : encodeSynopsis(row.synopsis)}
        )
      `.pipe(Effect.mapError(asStorageError("WorkSessionRepository.insert")));
      return row;
    });

  const update: WorkSessionRepository["Service"]["update"] = (row) =>
    sql`
      UPDATE fabric_work_sessions SET
        project_id = ${row.projectId},
        title = ${row.title},
        objective = ${row.objective},
        constraints_json = ${encodeStringList(row.constraints)},
        acceptance_criteria_json = ${encodeStringList(row.acceptanceCriteria)},
        environment_affinity_json = ${encodeEnvironmentList(row.environmentAffinity)},
        repository_identity_json = ${
          row.repositoryIdentity === null ? null : encodeRepositoryIdentity(row.repositoryIdentity)
        },
        primary_worktree_path = ${row.primaryWorktreePath},
        base_branch = ${row.baseBranch},
        risk_class = ${row.riskClass},
        priority = ${row.priority},
        active_thread_id = ${row.activeThreadId},
        updated_at = ${row.updatedAt},
        settled_at = ${row.settledAt},
        archived_at = ${row.archivedAt},
        synopsis_json = ${row.synopsis === null ? null : encodeSynopsis(row.synopsis)}
      WHERE id = ${row.id}
    `.pipe(Effect.mapError(asStorageError("WorkSessionRepository.update")), Effect.asVoid);

  const list: WorkSessionRepository["Service"]["list"] = ({ includeArchived }) =>
    (includeArchived ? selectEvery({}) : selectActive({})).pipe(
      Effect.mapError(asStorageError("WorkSessionRepository.list")),
    );

  const listThreads: WorkSessionRepository["Service"]["listThreads"] = (id) =>
    selectThreads({ id }).pipe(
      Effect.mapError(asStorageError("WorkSessionRepository.listThreads")),
    );

  const findLiveAttachment: WorkSessionRepository["Service"]["findLiveAttachment"] = (threadId) =>
    selectLiveAttachment({ threadId }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(asStorageError("WorkSessionRepository.findLiveAttachment")),
    );

  const attachThread: WorkSessionRepository["Service"]["attachThread"] = (row) =>
    sql`
      INSERT INTO fabric_work_session_threads (
        work_session_id, thread_id, provider_instance_id, provider_driver,
        role, origin, attached_at, detached_at
      ) VALUES (
        ${row.workSessionId}, ${row.threadId}, ${row.providerInstanceId}, ${row.providerDriver},
        ${row.role}, ${row.origin}, ${row.attachedAt}, ${row.detachedAt}
      )
    `.pipe(Effect.mapError(asStorageError("WorkSessionRepository.attachThread")), Effect.asVoid);

  const detachThread: WorkSessionRepository["Service"]["detachThread"] = ({
    workSessionId,
    threadId,
    detachedAt,
  }) =>
    Effect.gen(function* () {
      const live = yield* findLiveAttachment(threadId);
      if (live === null || live.workSessionId !== workSessionId) return false;
      yield* sql`
        UPDATE fabric_work_session_threads
        SET detached_at = ${detachedAt}
        WHERE work_session_id = ${workSessionId}
          AND thread_id = ${threadId}
          AND detached_at IS NULL
      `.pipe(Effect.mapError(asStorageError("WorkSessionRepository.detachThread")));
      return true;
    });

  return {
    insert,
    update,
    get,
    list,
    listThreads,
    findLiveAttachment,
    attachThread,
    detachThread,
  } satisfies WorkSessionRepository["Service"];
});

export const layer = Layer.effect(WorkSessionRepository, make);
