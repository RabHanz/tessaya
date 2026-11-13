import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who answered an approval card, and how sure (A0-A4): the Record says "Approved by Sara (A3, her phone)". Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_phone_prompts ADD COLUMN answered_by TEXT`;
  yield* sql`ALTER TABLE fabric_phone_prompts ADD COLUMN answered_level INTEGER`;
});
