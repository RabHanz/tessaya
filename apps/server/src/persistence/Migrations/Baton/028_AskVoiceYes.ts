import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** An ask said in his own verified voice on the device it came through: his yes for a look it needs. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_phone_asks ADD COLUMN his_voice INTEGER`;
});
