import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The plan lease his yes on a job's plan issues (BatonPlanLease). Additive; null is none. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_job_terms ADD COLUMN lease_json TEXT`;
});
