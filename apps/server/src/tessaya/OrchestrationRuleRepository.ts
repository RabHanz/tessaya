/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Storage for orchestration rules and the record of every time one fired.
 *
 * The firing count lives in the database rather than in memory because it is a
 * safety bound, and a bound that resets on restart is not one. A runaway rule
 * would otherwise get a fresh three firings every time the server came back,
 * which is exactly when it would do the most damage.
 */
import {
  TessayaSessionState,
  IsoDateTime,
  OrchestrationAction,
  OrchestrationFiringId,
  OrchestrationFiringOutcome,
  OrchestrationFollowUp,
  OrchestrationRuleId,
  OrchestrationRuleStatus,
  OrchestrationTrigger,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
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

export const OrchestrationRuleRow = Schema.Struct({
  id: OrchestrationRuleId,
  workSessionId: WorkSessionId,
  source: TrimmedString,
  trigger: OrchestrationTrigger,
  action: OrchestrationAction,
  followUp: Schema.NullOr(OrchestrationFollowUp),
  status: OrchestrationRuleStatus,
  maxFirings: Schema.Int,
  firedCount: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastFiredAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationRuleRow = typeof OrchestrationRuleRow.Type;

export const OrchestrationFiringRow = Schema.Struct({
  id: OrchestrationFiringId,
  ruleId: OrchestrationRuleId,
  workSessionId: WorkSessionId,
  triggeredBy: TrimmedNonEmptyString,
  outcome: OrchestrationFiringOutcome,
  producedThreadId: Schema.NullOr(ThreadId),
  detail: TrimmedString,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationFiringRow = typeof OrchestrationFiringRow.Type;

const RuleDbRow = OrchestrationRuleRow.mapFields(
  Struct.assign({
    trigger: Schema.fromJsonString(OrchestrationTrigger),
    action: Schema.fromJsonString(OrchestrationAction),
    followUp: Schema.NullOr(Schema.fromJsonString(OrchestrationFollowUp)),
  }),
);

const encodeTrigger = Schema.encodeSync(Schema.fromJsonString(OrchestrationTrigger));
const encodeAction = Schema.encodeSync(Schema.fromJsonString(OrchestrationAction));
const encodeFollowUp = Schema.encodeSync(Schema.fromJsonString(OrchestrationFollowUp));

const RuleRefRow = Schema.Struct({ id: OrchestrationRuleId });
const WorkSessionRefRow = Schema.Struct({ workSessionId: WorkSessionId });
const FiringRefRow = Schema.Struct({ id: OrchestrationFiringId });

export class OrchestrationRuleRepository extends Context.Service<
  OrchestrationRuleRepository,
  {
    readonly insertRule: (
      row: OrchestrationRuleRow,
    ) => Effect.Effect<OrchestrationRuleRow | null, ProjectionRepositoryError>;
    readonly updateRule: (
      row: OrchestrationRuleRow,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getRule: (
      id: OrchestrationRuleId,
    ) => Effect.Effect<OrchestrationRuleRow | null, ProjectionRepositoryError>;
    readonly listRules: (input: {
      readonly workSessionId: WorkSessionId | null;
      readonly includeDisabled: boolean;
    }) => Effect.Effect<ReadonlyArray<OrchestrationRuleRow>, ProjectionRepositoryError>;
    /** Enabled rules for one work session; the reactor's hot path. */
    readonly listEnabledForWorkSession: (
      workSessionId: WorkSessionId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationRuleRow>, ProjectionRepositoryError>;
    readonly insertFiring: (
      row: OrchestrationFiringRow,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly updateFiring: (
      row: OrchestrationFiringRow,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getFiring: (
      id: OrchestrationFiringId,
    ) => Effect.Effect<OrchestrationFiringRow | null, ProjectionRepositoryError>;
    readonly listFiringsForRule: (
      ruleId: OrchestrationRuleId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<OrchestrationFiringRow>, ProjectionRepositoryError>;
    /** Every firing on a work session, for the self-trigger check. */
    readonly listFiringsForWorkSession: (
      workSessionId: WorkSessionId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationFiringRow>, ProjectionRepositoryError>;
    /**
     * The state this work session was last seen in, or null when it has never
     * been evaluated. A trigger names a transition, so the reactor has to know
     * where the work session was before it can decide that it has arrived.
     */
    readonly getObservedState: (
      workSessionId: WorkSessionId,
    ) => Effect.Effect<TessayaSessionState | null, ProjectionRepositoryError>;
    readonly setObservedState: (input: {
      readonly workSessionId: WorkSessionId;
      readonly state: TessayaSessionState;
      readonly observedAt: string;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/tessaya/OrchestrationRuleRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRuleById = SqlSchema.findOneOption({
    Request: RuleRefRow,
    Result: RuleDbRow,
    execute: ({ id }) => sql`
      SELECT
        id,
        work_session_id AS "workSessionId",
        source,
        trigger_json AS "trigger",
        action_json AS "action",
        follow_up_json AS "followUp",
        status,
        max_firings AS "maxFirings",
        fired_count AS "firedCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_fired_at AS "lastFiredAt"
      FROM fabric_orchestration_rules
      WHERE id = ${id}
    `,
  });

  const selectRulesForSession = SqlSchema.findAll({
    Request: WorkSessionRefRow,
    Result: RuleDbRow,
    execute: ({ workSessionId }) => sql`
      SELECT
        id,
        work_session_id AS "workSessionId",
        source,
        trigger_json AS "trigger",
        action_json AS "action",
        follow_up_json AS "followUp",
        status,
        max_firings AS "maxFirings",
        fired_count AS "firedCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_fired_at AS "lastFiredAt"
      FROM fabric_orchestration_rules
      WHERE work_session_id = ${workSessionId}
      ORDER BY created_at ASC, id ASC
    `,
  });

  const selectEnabledForSession = SqlSchema.findAll({
    Request: WorkSessionRefRow,
    Result: RuleDbRow,
    execute: ({ workSessionId }) => sql`
      SELECT
        id,
        work_session_id AS "workSessionId",
        source,
        trigger_json AS "trigger",
        action_json AS "action",
        follow_up_json AS "followUp",
        status,
        max_firings AS "maxFirings",
        fired_count AS "firedCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_fired_at AS "lastFiredAt"
      FROM fabric_orchestration_rules
      WHERE work_session_id = ${workSessionId} AND status = 'enabled'
      ORDER BY created_at ASC, id ASC
    `,
  });

  const selectAllRules = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: RuleDbRow,
    execute: () => sql`
      SELECT
        id,
        work_session_id AS "workSessionId",
        source,
        trigger_json AS "trigger",
        action_json AS "action",
        follow_up_json AS "followUp",
        status,
        max_firings AS "maxFirings",
        fired_count AS "firedCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_fired_at AS "lastFiredAt"
      FROM fabric_orchestration_rules
      ORDER BY created_at ASC, id ASC
    `,
  });

  const selectFiringById = SqlSchema.findOneOption({
    Request: FiringRefRow,
    Result: OrchestrationFiringRow,
    execute: ({ id }) => sql`
      SELECT
        id,
        rule_id AS "ruleId",
        work_session_id AS "workSessionId",
        triggered_by AS "triggeredBy",
        outcome,
        produced_thread_id AS "producedThreadId",
        detail,
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM fabric_orchestration_firings
      WHERE id = ${id}
    `,
  });

  const selectFiringsForRule = SqlSchema.findAll({
    Request: Schema.Struct({ ruleId: OrchestrationRuleId, limit: Schema.Int }),
    Result: OrchestrationFiringRow,
    execute: ({ ruleId, limit }) => sql`
      SELECT
        id,
        rule_id AS "ruleId",
        work_session_id AS "workSessionId",
        triggered_by AS "triggeredBy",
        outcome,
        produced_thread_id AS "producedThreadId",
        detail,
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM fabric_orchestration_firings
      WHERE rule_id = ${ruleId}
      ORDER BY started_at DESC, id DESC
      LIMIT ${limit}
    `,
  });

  const selectFiringsForSession = SqlSchema.findAll({
    Request: WorkSessionRefRow,
    Result: OrchestrationFiringRow,
    execute: ({ workSessionId }) => sql`
      SELECT
        id,
        rule_id AS "ruleId",
        work_session_id AS "workSessionId",
        triggered_by AS "triggeredBy",
        outcome,
        produced_thread_id AS "producedThreadId",
        detail,
        started_at AS "startedAt",
        completed_at AS "completedAt"
      FROM fabric_orchestration_firings
      WHERE work_session_id = ${workSessionId}
      ORDER BY started_at ASC, id ASC
    `,
  });

  const selectObservedState = SqlSchema.findOneOption({
    Request: WorkSessionRefRow,
    Result: Schema.Struct({ state: TessayaSessionState }),
    execute: ({ workSessionId }) => sql`
      SELECT state
      FROM fabric_work_session_observed_state
      WHERE work_session_id = ${workSessionId}
    `,
  });

  const fail = (operation: string) => toPersistenceSqlError(operation);

  const getRule: OrchestrationRuleRepository["Service"]["getRule"] = (id) =>
    selectRuleById({ id }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(fail("OrchestrationRuleRepository.getRule")),
    );

  const insertRule: OrchestrationRuleRepository["Service"]["insertRule"] = (row) =>
    Effect.gen(function* () {
      const existing = yield* getRule(row.id);
      // Creating twice with one id is a retry, not a second rule. A duplicate
      // rule would double every firing and halve the bound's meaning.
      if (existing !== null) return null;
      yield* sql`
        INSERT INTO fabric_orchestration_rules (
          id, work_session_id, source, trigger_json, action_json, follow_up_json,
          status, max_firings, fired_count, created_at, updated_at, last_fired_at
        ) VALUES (
          ${row.id}, ${row.workSessionId}, ${row.source},
          ${encodeTrigger(row.trigger)}, ${encodeAction(row.action)},
          ${row.followUp === null ? null : encodeFollowUp(row.followUp)},
          ${row.status}, ${row.maxFirings}, ${row.firedCount},
          ${row.createdAt}, ${row.updatedAt}, ${row.lastFiredAt}
        )
      `.pipe(Effect.mapError(fail("OrchestrationRuleRepository.insertRule")));
      return row;
    });

  const updateRule: OrchestrationRuleRepository["Service"]["updateRule"] = (row) =>
    sql`
      UPDATE fabric_orchestration_rules SET
        source = ${row.source},
        trigger_json = ${encodeTrigger(row.trigger)},
        action_json = ${encodeAction(row.action)},
        follow_up_json = ${row.followUp === null ? null : encodeFollowUp(row.followUp)},
        status = ${row.status},
        max_firings = ${row.maxFirings},
        fired_count = ${row.firedCount},
        updated_at = ${row.updatedAt},
        last_fired_at = ${row.lastFiredAt}
      WHERE id = ${row.id}
    `.pipe(Effect.mapError(fail("OrchestrationRuleRepository.updateRule")), Effect.asVoid);

  const listRules: OrchestrationRuleRepository["Service"]["listRules"] = ({
    workSessionId,
    includeDisabled,
  }) =>
    (workSessionId === null ? selectAllRules({}) : selectRulesForSession({ workSessionId })).pipe(
      Effect.mapError(fail("OrchestrationRuleRepository.listRules")),
      Effect.map((rows) =>
        includeDisabled ? rows : rows.filter((row) => row.status !== "disabled"),
      ),
    );

  const listEnabledForWorkSession: OrchestrationRuleRepository["Service"]["listEnabledForWorkSession"] =
    (workSessionId) =>
      selectEnabledForSession({ workSessionId }).pipe(
        Effect.mapError(fail("OrchestrationRuleRepository.listEnabledForWorkSession")),
      );

  const insertFiring: OrchestrationRuleRepository["Service"]["insertFiring"] = (row) =>
    sql`
      INSERT INTO fabric_orchestration_firings (
        id, rule_id, work_session_id, triggered_by, outcome,
        produced_thread_id, detail, started_at, completed_at
      ) VALUES (
        ${row.id}, ${row.ruleId}, ${row.workSessionId}, ${row.triggeredBy}, ${row.outcome},
        ${row.producedThreadId}, ${row.detail}, ${row.startedAt}, ${row.completedAt}
      )
    `.pipe(Effect.mapError(fail("OrchestrationRuleRepository.insertFiring")), Effect.asVoid);

  const updateFiring: OrchestrationRuleRepository["Service"]["updateFiring"] = (row) =>
    sql`
      UPDATE fabric_orchestration_firings SET
        outcome = ${row.outcome},
        produced_thread_id = ${row.producedThreadId},
        detail = ${row.detail},
        completed_at = ${row.completedAt}
      WHERE id = ${row.id}
    `.pipe(Effect.mapError(fail("OrchestrationRuleRepository.updateFiring")), Effect.asVoid);

  const getFiring: OrchestrationRuleRepository["Service"]["getFiring"] = (id) =>
    selectFiringById({ id }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(fail("OrchestrationRuleRepository.getFiring")),
    );

  const listFiringsForRule: OrchestrationRuleRepository["Service"]["listFiringsForRule"] = (
    ruleId,
    limit,
  ) =>
    selectFiringsForRule({ ruleId, limit }).pipe(
      Effect.mapError(fail("OrchestrationRuleRepository.listFiringsForRule")),
    );

  const listFiringsForWorkSession: OrchestrationRuleRepository["Service"]["listFiringsForWorkSession"] =
    (workSessionId) =>
      selectFiringsForSession({ workSessionId }).pipe(
        Effect.mapError(fail("OrchestrationRuleRepository.listFiringsForWorkSession")),
      );

  const getObservedState: OrchestrationRuleRepository["Service"]["getObservedState"] = (
    workSessionId,
  ) =>
    selectObservedState({ workSessionId }).pipe(
      Effect.map((row) => (Option.isSome(row) ? row.value.state : null)),
      Effect.mapError(fail("OrchestrationRuleRepository.getObservedState")),
    );

  const setObservedState: OrchestrationRuleRepository["Service"]["setObservedState"] = (input) =>
    sql`
      INSERT INTO fabric_work_session_observed_state (work_session_id, state, observed_at)
      VALUES (${input.workSessionId}, ${input.state}, ${input.observedAt})
      ON CONFLICT(work_session_id) DO UPDATE SET
        state = excluded.state,
        observed_at = excluded.observed_at
    `.pipe(Effect.mapError(fail("OrchestrationRuleRepository.setObservedState")), Effect.asVoid);

  return {
    insertRule,
    updateRule,
    getRule,
    listRules,
    listEnabledForWorkSession,
    insertFiring,
    updateFiring,
    getFiring,
    listFiringsForRule,
    listFiringsForWorkSession,
    getObservedState,
    setObservedState,
  } satisfies OrchestrationRuleRepository["Service"];
});

export const layer = Layer.effect(OrchestrationRuleRepository, make);
