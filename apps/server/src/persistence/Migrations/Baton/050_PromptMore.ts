import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A card's raw request, behind its Details; additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_phone_prompts ADD COLUMN more TEXT`;
});
