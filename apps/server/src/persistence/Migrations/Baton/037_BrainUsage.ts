import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per model call the brain makes (BRAIN-DESIGN §13.3, B1d): which role, provider, login and model, its tokens,
 * and dollars at list price for an API key (null on a subscription, which is paid by the plan). Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_brain_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      provider TEXT NOT NULL,
      credential TEXT NOT NULL,
      model TEXT NOT NULL,
      input INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      output INTEGER NOT NULL,
      dollars REAL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_brain_usage_at ON tessaya_brain_usage (at)`;
});
