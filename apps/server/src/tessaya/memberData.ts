/**
 * Every table on the home that holds a member's own data (ACCOUNTS-IDENTITY §5.1, I-6): what "Export my data" reads
 * and what leaving destroys or signs over to "a former member". `memberData.test.ts` lists every member-keyed column the
 * migrations make and fails on one that is in neither this list nor `NOT_PERSONAL`.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

type Rows = ReadonlyArray<Record<string, unknown>>;
interface MemberTable {
  readonly table: string;
  readonly column: string;
  /** Their rows, for their export. */
  readonly read: (sql: SqlClient.SqlClient, id: string) => Effect.Effect<Rows, SqlError.SqlError>;
  /** When their data is destroyed: theirs goes; what the home keeps loses their name. */
  readonly leave: (
    sql: SqlClient.SqlClient,
    id: string,
  ) => Effect.Effect<unknown, SqlError.SqlError>;
}

const own = (table: string, column: string): MemberTable => ({
  table,
  column,
  read: (sql, id) => sql`SELECT * FROM ${sql(table)} WHERE ${sql(column)} = ${id}`,
  leave: (sql, id) => sql`DELETE FROM ${sql(table)} WHERE ${sql(column)} = ${id}`,
});

export const MEMBER_DATA: ReadonlyArray<MemberTable> = [
  own("tessaya_household_members", "id"),
  own("tessaya_voice_profiles", "member_id"),
  own("tessaya_member_preferences", "member_id"),
  own("tessaya_member_passkeys", "member_id"),
  own("tessaya_affect_ledger", "member"),
  own("tessaya_room_transcript", "who"),
  own("tessaya_comms_receipts", "person"),
  {
    table: "tessaya_comms_consent",
    column: "caller",
    read: (sql, id) =>
      sql`SELECT * FROM tessaya_comms_consent WHERE caller = ${id} OR target = ${`person:${id}`}`,
    leave: (sql, id) =>
      sql`DELETE FROM tessaya_comms_consent WHERE caller = ${id} OR target = ${`person:${id}`}`,
  },
  {
    // Notes they sent stay with whoever got them, from "a former member".
    table: "tessaya_comms_notes",
    column: "from_member",
    read: (sql, id) => sql`SELECT * FROM tessaya_comms_notes WHERE from_member = ${id}`,
    leave: (sql, id) =>
      sql`UPDATE tessaya_comms_notes SET from_member = NULL, from_label = 'a former member' WHERE from_member = ${id}`,
  },
  {
    table: "tessaya_comms_legs",
    column: "person",
    read: (sql, id) => sql`SELECT * FROM tessaya_comms_legs WHERE person = ${id}`,
    leave: (sql, id) => sql`UPDATE tessaya_comms_legs SET person = NULL WHERE person = ${id}`,
  },
  {
    // A persona's memory of them is theirs and goes; what they told the whole home stays, unsigned.
    table: "fabric_memory_items",
    column: "speaker",
    read: (sql, id) => sql`SELECT * FROM fabric_memory_items WHERE speaker = ${id}`,
    leave: (sql, id) =>
      sql`DELETE FROM fabric_memory_items WHERE speaker = ${id} AND visibility = 'persona'`.pipe(
        Effect.andThen(sql`UPDATE fabric_memory_items SET speaker = NULL WHERE speaker = ${id}`),
      ),
  },
  {
    // The people graph keeps the person (others' memories mention them); only the link to a member goes.
    table: "fabric_memory_entities",
    column: "member_id",
    read: (sql, id) => sql`SELECT * FROM fabric_memory_entities WHERE member_id = ${id}`,
    leave: (sql, id) =>
      sql`UPDATE fabric_memory_entities SET member_id = NULL WHERE member_id = ${id}`,
  },
  {
    // What their turns cost stays in the home's totals, unsigned.
    table: "tessaya_brain_usage",
    column: "member",
    read: (sql, id) => sql`SELECT * FROM tessaya_brain_usage WHERE member = ${id}`,
    leave: (sql, id) => sql`UPDATE tessaya_brain_usage SET member = NULL WHERE member = ${id}`,
  },
  {
    // Their phone or desktop becomes the household's the moment they are removed (`release`).
    table: "fabric_devices",
    column: "member",
    read: (sql, id) =>
      sql`SELECT id, kind, name, last_seen FROM fabric_devices WHERE member = ${id}`,
    leave: (sql, id) => sql`UPDATE fabric_devices SET member = NULL WHERE member = ${id}`,
  },
];

/** Member-keyed columns that are not a member's data here, and why. */
export const NOT_PERSONAL: Readonly<Record<string, string>> = {
  "tessaya_private_stores.person_id":
    "the private store: shredded and exported (with their PIN) by TessayaPrivateMemoryService",
  "tessaya_private_audit.by_whom":
    "the store's hash-chained audit: rewriting it would break the chain",
};

/** Everything of theirs on the home, table by table: their export. */
export const exportOf = Effect.fn("memberData.exportOf")(function* (
  sql: SqlClient.SqlClient,
  id: string,
) {
  const out: Record<string, Rows> = {};
  for (const t of MEMBER_DATA) out[t.table] = yield* t.read(sql, id).pipe(Effect.orDie);
  return out;
});

/** Their data destroyed, the home's signed over: the end of the export window, or "remove now". */
export const destroyOf = Effect.fn("memberData.destroyOf")(function* (
  sql: SqlClient.SqlClient,
  id: string,
) {
  yield* sql
    .withTransaction(Effect.forEach(MEMBER_DATA, (t) => t.leave(sql, id), { discard: true }))
    .pipe(Effect.orDie);
});

/**
 * At removal, before the window: what reaches them ends now (drop-in consents, their devices pass to the home, the
 * profiles they linked in other homes).
 */
export const releaseOf = Effect.fn("memberData.releaseOf")(function* (
  sql: SqlClient.SqlClient,
  id: string,
) {
  yield* sql
    .withTransaction(
      Effect.forEach(
        MEMBER_DATA.filter(
          (t) => t.table === "tessaya_comms_consent" || t.table === "fabric_devices",
        ),
        (t) => t.leave(sql, id),
        { discard: true },
      ).pipe(
        Effect.andThen(
          sql`UPDATE tessaya_household_members SET profile_links_json = NULL WHERE id = ${id}`,
        ),
      ),
    )
    .pipe(Effect.orDie);
});
