import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Every change to a person's relationship with a persona, against the event it came from (the Director, 20 Nov): "that
 * wasn't me" reverses it and gives it to whoever it was.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_affect_ledger (
      id TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      vessel TEXT,
      persona TEXT NOT NULL,
      member TEXT NOT NULL,
      assumed INTEGER NOT NULL DEFAULT 0,
      event_json TEXT NOT NULL,
      delta_json TEXT NOT NULL,
      at INTEGER NOT NULL,
      moved_to TEXT,
      moved_at INTEGER
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_affect_ledger_ref ON tessaya_affect_ledger (ref)`;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_affect_ledger_member ON tessaya_affect_ledger (member, at)`;
});
