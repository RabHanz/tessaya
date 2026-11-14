/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Storage for adopted sessions.
 *
 * Which pane belongs to which work is durable; the pane's *state* is only ever
 * what its runtime last said, and is overwritten on every refresh. Releasing a
 * session sets `detached_at` rather than deleting the row, so a work session's
 * history still shows that a terminal was once part of it.
 */
import {
  AdoptedRuntime,
  AdoptedSessionCapabilities,
  AdoptedSessionId,
  TessayaSessionState,
  IsoDateTime,
  TrimmedNonEmptyString,
  WorkSessionId,
} from "@t3tools/tessaya-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export const AdoptedSessionRow = Schema.Struct({
  id: AdoptedSessionId,
  runtime: AdoptedRuntime,
  workSessionId: Schema.NullOr(WorkSessionId),
  label: TrimmedNonEmptyString,
  workspace: TrimmedNonEmptyString,
  pane: TrimmedNonEmptyString,
  host: Schema.NullOr(TrimmedNonEmptyString),
  agentKind: Schema.NullOr(TrimmedNonEmptyString),
  state: TessayaSessionState,
  capabilities: AdoptedSessionCapabilities,
  observedAt: IsoDateTime,
  createdAt: IsoDateTime,
  detachedAt: Schema.NullOr(IsoDateTime),
});
export type AdoptedSessionRow = typeof AdoptedSessionRow.Type;

const DbRow = AdoptedSessionRow.mapFields(
  Struct.assign({ capabilities: Schema.fromJsonString(AdoptedSessionCapabilities) }),
);

const encodeCapabilities = Schema.encodeSync(Schema.fromJsonString(AdoptedSessionCapabilities));

const RefRow = Schema.Struct({ id: AdoptedSessionId });

export class AdoptedSessionRepository extends Context.Service<
  AdoptedSessionRepository,
  {
    /** Null when a row with this id already exists: registering twice is a retry. */
    readonly insert: (
      row: AdoptedSessionRow,
    ) => Effect.Effect<AdoptedSessionRow | null, ProjectionRepositoryError>;
    readonly update: (row: AdoptedSessionRow) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly get: (
      id: AdoptedSessionId,
    ) => Effect.Effect<AdoptedSessionRow | null, ProjectionRepositoryError>;
    readonly list: (input: {
      readonly workSessionId: WorkSessionId | null;
      readonly includeDetached: boolean;
    }) => Effect.Effect<ReadonlyArray<AdoptedSessionRow>, ProjectionRepositoryError>;
  }
>()("t3/tessaya/AdoptedSessionRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectById = SqlSchema.findOneOption({
    Request: RefRow,
    Result: DbRow,
    execute: ({ id }) => sql`
      SELECT
        id,
        runtime,
        work_session_id AS "workSessionId",
        label,
        workspace,
        pane,
        host,
        agent_kind AS "agentKind",
        state,
        capabilities_json AS "capabilities",
        observed_at AS "observedAt",
        created_at AS "createdAt",
        detached_at AS "detachedAt"
      FROM fabric_adopted_sessions
      WHERE id = ${id}
    `,
  });

  const selectAll = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: DbRow,
    execute: () => sql`
      SELECT
        id,
        runtime,
        work_session_id AS "workSessionId",
        label,
        workspace,
        pane,
        host,
        agent_kind AS "agentKind",
        state,
        capabilities_json AS "capabilities",
        observed_at AS "observedAt",
        created_at AS "createdAt",
        detached_at AS "detachedAt"
      FROM fabric_adopted_sessions
      ORDER BY created_at ASC, id ASC
    `,
  });

  const selectForWorkSession = SqlSchema.findAll({
    Request: Schema.Struct({ workSessionId: WorkSessionId }),
    Result: DbRow,
    execute: ({ workSessionId }) => sql`
      SELECT
        id,
        runtime,
        work_session_id AS "workSessionId",
        label,
        workspace,
        pane,
        host,
        agent_kind AS "agentKind",
        state,
        capabilities_json AS "capabilities",
        observed_at AS "observedAt",
        created_at AS "createdAt",
        detached_at AS "detachedAt"
      FROM fabric_adopted_sessions
      WHERE work_session_id = ${workSessionId}
      ORDER BY created_at ASC, id ASC
    `,
  });

  const fail = (operation: string) => toPersistenceSqlError(operation);

  const get: AdoptedSessionRepository["Service"]["get"] = (id) =>
    selectById({ id }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(fail("AdoptedSessionRepository.get")),
    );

  const insert: AdoptedSessionRepository["Service"]["insert"] = (row) =>
    Effect.gen(function* () {
      const existing = yield* get(row.id);
      if (existing !== null) return null;
      yield* sql`
        INSERT INTO fabric_adopted_sessions (
          id, runtime, work_session_id, label, workspace, pane, host,
          agent_kind, state, capabilities_json, observed_at, created_at, detached_at
        ) VALUES (
          ${row.id}, ${row.runtime}, ${row.workSessionId}, ${row.label},
          ${row.workspace}, ${row.pane}, ${row.host}, ${row.agentKind}, ${row.state},
          ${encodeCapabilities(row.capabilities)}, ${row.observedAt}, ${row.createdAt},
          ${row.detachedAt}
        )
      `.pipe(Effect.mapError(fail("AdoptedSessionRepository.insert")));
      return row;
    });

  const update: AdoptedSessionRepository["Service"]["update"] = (row) =>
    sql`
      UPDATE fabric_adopted_sessions SET
        work_session_id = ${row.workSessionId},
        label = ${row.label},
        state = ${row.state},
        capabilities_json = ${encodeCapabilities(row.capabilities)},
        observed_at = ${row.observedAt},
        detached_at = ${row.detachedAt}
      WHERE id = ${row.id}
    `.pipe(Effect.mapError(fail("AdoptedSessionRepository.update")), Effect.asVoid);

  const list: AdoptedSessionRepository["Service"]["list"] = ({ workSessionId, includeDetached }) =>
    (workSessionId === null ? selectAll({}) : selectForWorkSession({ workSessionId })).pipe(
      Effect.mapError(fail("AdoptedSessionRepository.list")),
      Effect.map((rows) =>
        includeDetached ? rows : rows.filter((row) => row.detachedAt === null),
      ),
    );

  return { insert, update, get, list } satisfies AdoptedSessionRepository["Service"];
});

export const layer = Layer.effect(AdoptedSessionRepository, make);
