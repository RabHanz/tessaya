import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One truth on her brain, nothing lost (one-self moves): a worker's changes wait here, in order, while the brain can't
 * be reached, and the brain remembers which it applied, so a replay lands each exactly once.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_brain_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      op TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_brain_applied (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    )
  `;
});
