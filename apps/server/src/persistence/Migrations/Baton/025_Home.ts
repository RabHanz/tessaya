import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Home Assistant: what Tessaya did in the house (for undo and approvals) and the automations she made. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_home_actions (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      surface TEXT NOT NULL,
      why TEXT NOT NULL,
      request TEXT NOT NULL,
      status TEXT NOT NULL,
      tier TEXT NOT NULL,
      reasons TEXT NOT NULL,
      undo_scene TEXT,
      prompt_id TEXT,
      expires_at INTEGER NOT NULL,
      line TEXT NOT NULL DEFAULT ''
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS fabric_home_actions_at ON fabric_home_actions (at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_home_automations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      expires_at INTEGER,
      once INTEGER NOT NULL DEFAULT 0,
      actor TEXT NOT NULL,
      surface TEXT NOT NULL,
      request TEXT NOT NULL,
      config TEXT NOT NULL,
      previous TEXT,
      last_op TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});
