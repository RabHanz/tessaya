import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each household member's own preferences (HOUSEHOLD-DESIGN §4): what to call them, her voice and persona for them,
 * units, the time format, their news and music. Kept in plain text beside the members table: a preference is how she
 * talks to them, not a secret. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_member_preferences (
      member_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (member_id, key)
    )
  `;
});
