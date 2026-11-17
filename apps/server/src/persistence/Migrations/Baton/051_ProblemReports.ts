import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Problem reports to the developers (tessaya-contracts problemReport.ts): one row per report, mirrored between his
 * servers by `updated_at` (last writer wins); a deleted one keeps its row, without its bundle, so the delete mirrors.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_problem_reports (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      origin TEXT NOT NULL,
      at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      bundle_json TEXT,
      issue_url TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_problem_reports_updated ON tessaya_problem_reports (updated_at)`;
});
