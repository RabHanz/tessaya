import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A terminal session's model, effort or account change waiting for it to go idle (ACCOUNTS-2). Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_live_queue (
      session_id TEXT PRIMARY KEY,
      change_json TEXT NOT NULL
    )
  `;
});
