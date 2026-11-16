import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A card that belongs to a batch card (several changes on one card); additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_phone_prompts ADD COLUMN batch TEXT`;
});
