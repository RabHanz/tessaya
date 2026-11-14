import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Her working mood, one row per persona (EMOTION-SYSTEM §8.1, phase 1): the state, decayed when read. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_affect_state (
      persona TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
