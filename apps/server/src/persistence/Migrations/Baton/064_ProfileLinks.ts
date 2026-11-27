import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** "Link my profiles" (identity I-8): the other homes she says she is in, as JSON on her member row. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(tessaya_household_members)`;
  if (!columns.some((c) => c.name === "profile_links_json"))
    yield* sql`ALTER TABLE tessaya_household_members ADD COLUMN profile_links_json TEXT`;
});
