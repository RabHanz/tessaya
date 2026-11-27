import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A removed member's one-use export link (identity I-6): its token's SHA-256, cleared once used. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(tessaya_household_members)`;
  if (!columns.some((c) => c.name === "export_token"))
    yield* sql`ALTER TABLE tessaya_household_members ADD COLUMN export_token TEXT`;
});
