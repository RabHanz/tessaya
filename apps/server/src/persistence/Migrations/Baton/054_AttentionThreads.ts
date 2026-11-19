import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Her attention on the brain (architecture §1.3): live threads and the conversations they hold, kept over a restart. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_live_threads (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      row TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_conversations (
      key TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      turns TEXT NOT NULL
    )
  `;
});
