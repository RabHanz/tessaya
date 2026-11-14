/**
 * The Record: one timeline of what happened, who did it, for which project. Writers append; the
 * assistant, agents and the watch read it back. Every text is stored as one capped line and shown to
 * a model only as quoted data (`describeAuditTrail`).
 */
import type { BatonRecordEntry } from "@t3tools/tessaya-contracts";
import { recordText } from "@t3tools/tessaya-shared/audit";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

/** Kept this long, and never more than this many rows, whichever is less. */
const KEEP_DAYS = 30;
const KEEP_ROWS = 10_000;

export interface RecordAppend {
  readonly kind: string;
  readonly actor: string;
  readonly project?: string | null;
  readonly ref?: string | null;
  readonly subject: string;
  readonly outcome: string;
  readonly detail?: string;
}

export class BatonRecordService extends Context.Service<
  BatonRecordService,
  {
    readonly append: (entry: RecordAppend) => Effect.Effect<void>;
    /** A row a client sent: an approval is kept as reported by it, so a remote client cannot pass one off as the server's. */
    readonly appendFromClient: (entry: RecordAppend) => Effect.Effect<void>;
    /** Newest first. */
    readonly query: (input: {
      readonly since?: string;
      readonly project?: string;
      readonly kind?: string;
      readonly actor?: string;
      readonly outcome?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<BatonRecordEntry>>;
  }
>()("t3/baton/BatonRecordService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const append = Effect.fn("BatonRecordService.append")(function* (entry: RecordAppend) {
    const now = yield* Clock.currentTimeMillis;
    const at = DateTime.formatIso(DateTime.makeUnsafe(now));
    const horizon = DateTime.formatIso(DateTime.makeUnsafe(now - KEEP_DAYS * 86_400_000));
    yield* sql`
      INSERT INTO fabric_record (at, kind, actor, project, ref, subject, outcome, detail)
      VALUES (${at}, ${recordText(entry.kind, 40)}, ${recordText(entry.actor, 60)},
              ${entry.project == null ? null : recordText(entry.project, 200)},
              ${entry.ref == null ? null : recordText(entry.ref, 200)},
              ${recordText(entry.subject, 300)}, ${recordText(entry.outcome, 60)},
              ${recordText(entry.detail ?? "", 1000)})
    `;
    yield* sql`DELETE FROM fabric_record WHERE at < ${horizon}`;
    yield* sql`DELETE FROM fabric_record WHERE id <= (SELECT MAX(id) FROM fabric_record) - ${KEEP_ROWS}`;
  }, Effect.orDie);

  const query = Effect.fn("BatonRecordService.query")(function* (input: {
    readonly since?: string;
    readonly project?: string;
    readonly kind?: string;
    readonly actor?: string;
    readonly outcome?: string;
    readonly limit?: number;
  }) {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    // A "since" that does not parse is ignored rather than answering "nothing happened".
    const sinceMs = input.since === undefined ? NaN : Date.parse(input.since);
    const since = Number.isNaN(sinceMs) ? null : DateTime.formatIso(DateTime.makeUnsafe(sinceMs));
    return yield* sql<BatonRecordEntry>`
      SELECT id, at, kind, actor, project, ref, subject, outcome, detail FROM fabric_record
      WHERE ${since === null ? sql`1 = 1` : sql`at > ${since}`}
        AND ${input.project === undefined ? sql`1 = 1` : sql`project = ${input.project} COLLATE NOCASE`}
        AND ${input.kind === undefined ? sql`1 = 1` : sql`kind = ${input.kind}`}
        AND ${input.actor === undefined ? sql`1 = 1` : sql`actor = ${input.actor}`}
        AND ${input.outcome === undefined ? sql`1 = 1` : sql`outcome = ${input.outcome}`}
      ORDER BY at DESC, id DESC
      LIMIT ${limit}
    `;
  }, Effect.orDie);

  const appendFromClient = (entry: RecordAppend) =>
    append(entry.kind === "approval" ? { ...entry, kind: "approval_reported_by_client" } : entry);

  return BatonRecordService.of({ append, appendFromClient, query });
});

export const layer = Layer.effect(BatonRecordService, make);
