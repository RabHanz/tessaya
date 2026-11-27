import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A child's limits, set by a guardian (identity I-5): quiet hours and who they may message. Null: none. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(tessaya_household_members)`;
  if (!columns.some((c) => c.name === "limits_json"))
    yield* sql`ALTER TABLE tessaya_household_members ADD COLUMN limits_json TEXT`;
});
