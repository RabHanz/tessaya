import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** When a member said yes to what she keeps about them (identity I-4); null: not yet, or taken back. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(tessaya_household_members)`;
  if (!columns.some((c) => c.name === "consented_at"))
    yield* sql`ALTER TABLE tessaya_household_members ADD COLUMN consented_at TEXT`;
});
