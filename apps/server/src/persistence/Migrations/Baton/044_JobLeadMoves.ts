import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who led a job before (TessayaJobLeadMove, oldest first). Additive; null is none. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_job_terms ADD COLUMN lead_moves_json TEXT`;
});
