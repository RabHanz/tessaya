import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The action log (B-046): one envelope per action. Private events are sealed whole to his store's box key in their
 * own table; the public table keeps only their id. Usage rows and Record rows point at their event. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_action_events (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      certainty REAL NOT NULL,
      cause_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      persona TEXT,
      subject TEXT NOT NULL,
      outcome TEXT NOT NULL,
      data_json TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_action_events_at ON tessaya_action_events (at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_action_events_kind ON tessaya_action_events (kind, at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_private_events (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      store_id TEXT NOT NULL,
      sealed_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_private_events_at ON tessaya_private_events (store_id, at)`;
  yield* sql`ALTER TABLE tessaya_brain_usage ADD COLUMN event_id TEXT`;
  yield* sql`ALTER TABLE fabric_record ADD COLUMN event_id TEXT`;
});
