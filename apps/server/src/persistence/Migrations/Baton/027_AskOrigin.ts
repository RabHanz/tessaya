import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The device an ask was said to (his R1, his phone), so its answer and any approval name it. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_phone_asks ADD COLUMN origin TEXT`;
});
