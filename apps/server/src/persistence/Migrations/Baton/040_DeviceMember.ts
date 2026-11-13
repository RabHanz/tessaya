import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Whose a client vessel is (identity §2.4): the member whose signed-in session first reported it, so a member's own
 * phone or desktop is theirs for comms. Null for room vessels and for rows from before; those stay the owner's. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_devices ADD COLUMN member TEXT`;
});
