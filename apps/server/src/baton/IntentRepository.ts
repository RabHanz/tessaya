/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Storage for the intent log.
 *
 * Small on purpose: an intent is written once and never updated. What it did is
 * already durable wherever it did it — a thread, a rule, a firing — and a row
 * that could be edited afterwards would stop being a record of what was asked.
 */
import {
  BatonIntentId,
  BatonIntentOutcome,
  BatonIntentRefusalReason,
  BatonIntentRisk,
  BatonIntentSource,
  IsoDateTime,
  TrimmedNonEmptyString,
  TrimmedString,
  WorkSessionId,
} from "@t3tools/tessaya-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

export const BatonIntentRow = Schema.Struct({
  id: BatonIntentId,
  text: TrimmedNonEmptyString,
  outcome: BatonIntentOutcome,
  commandKind: Schema.NullOr(TrimmedNonEmptyString),
  workSessionId: Schema.NullOr(WorkSessionId),
  description: TrimmedString,
  reply: TrimmedString,
  risk: BatonIntentRisk,
  refusalReason: Schema.NullOr(BatonIntentRefusalReason),
  at: IsoDateTime,
  /** Who read the sentence: the grammar, a learned phrasing, or a model. */
  source: BatonIntentSource,
  /** The model that read it, when one did. */
  model: Schema.NullOr(TrimmedNonEmptyString),
});
export type BatonIntentRow = typeof BatonIntentRow.Type;

export class BatonIntentRepository extends Context.Service<
  BatonIntentRepository,
  {
    readonly insert: (row: BatonIntentRow) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly list: (input: {
      readonly workSessionId: WorkSessionId | null;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<BatonIntentRow>, ProjectionRepositoryError>;
    /**
     * Just enough of every row for the retention rule to judge it: when it
     * happened and whether it was a refusal. Deliberately not the whole row —
     * the point of pruning is to touch less, not more.
     */
    readonly listForRetention: () => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly at: string; readonly refused: boolean }>,
      ProjectionRepositoryError
    >;
    readonly deleteByIds: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<number, ProjectionRepositoryError>;
  }
>()("t3/baton/IntentRepository/BatonIntentRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRecent = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Int }),
    Result: BatonIntentRow,
    execute: ({ limit }) => sql`
      SELECT
        id,
        text,
        outcome,
        command_kind AS "commandKind",
        work_session_id AS "workSessionId",
        description,
        reply,
        risk,
        refusal_reason AS "refusalReason",
        at,
        source,
        model
      FROM fabric_intents
      ORDER BY at DESC, id DESC
      LIMIT ${limit}
    `,
  });

  const selectForSession = SqlSchema.findAll({
    Request: Schema.Struct({ workSessionId: WorkSessionId, limit: Schema.Int }),
    Result: BatonIntentRow,
    execute: ({ workSessionId, limit }) => sql`
      SELECT
        id,
        text,
        outcome,
        command_kind AS "commandKind",
        work_session_id AS "workSessionId",
        description,
        reply,
        risk,
        refusal_reason AS "refusalReason",
        at,
        source,
        model
      FROM fabric_intents
      WHERE work_session_id = ${workSessionId}
      ORDER BY at DESC, id DESC
      LIMIT ${limit}
    `,
  });

  const selectRetention = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: Schema.Struct({ id: BatonIntentId, at: IsoDateTime, outcome: BatonIntentOutcome }),
    execute: () => sql`SELECT id, at, outcome FROM fabric_intents`,
  });

  const fail = (operation: string) => toPersistenceSqlError(operation);

  const insert: BatonIntentRepository["Service"]["insert"] = (row) =>
    sql`
      INSERT INTO fabric_intents (
        id, text, outcome, command_kind, work_session_id,
        description, reply, risk, refusal_reason, at, source, model
      ) VALUES (
        ${row.id}, ${row.text}, ${row.outcome}, ${row.commandKind}, ${row.workSessionId},
        ${row.description}, ${row.reply}, ${row.risk}, ${row.refusalReason}, ${row.at},
        ${row.source}, ${row.model}
      )
    `.pipe(Effect.mapError(fail("BatonIntentRepository.insert")), Effect.asVoid);

  const list: BatonIntentRepository["Service"]["list"] = ({ workSessionId, limit }) =>
    (workSessionId === null
      ? selectRecent({ limit })
      : selectForSession({ workSessionId, limit })
    ).pipe(Effect.mapError(fail("BatonIntentRepository.list")));

  const listForRetention: BatonIntentRepository["Service"]["listForRetention"] = () =>
    selectRetention({}).pipe(
      Effect.mapError(fail("BatonIntentRepository.listForRetention")),
      Effect.map((rows) =>
        rows.map((row) => ({ id: row.id, at: row.at, refused: row.outcome === "refused" })),
      ),
    );

  const deleteByIds: BatonIntentRepository["Service"]["deleteByIds"] = (ids) =>
    ids.length === 0
      ? Effect.succeed(0)
      : sql`DELETE FROM fabric_intents WHERE id IN ${sql.in(ids)}`.pipe(
          Effect.mapError(fail("BatonIntentRepository.deleteByIds")),
          Effect.as(ids.length),
        );

  return {
    insert,
    list,
    listForRetention,
    deleteByIds,
  } satisfies BatonIntentRepository["Service"];
});

export const layer = Layer.effect(BatonIntentRepository, make);
