import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The R1 a job was asked on, so its plan-ready and done lines are said there. Additive; null is his desktop or phone. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_job_terms ADD COLUMN origin TEXT`;
});
