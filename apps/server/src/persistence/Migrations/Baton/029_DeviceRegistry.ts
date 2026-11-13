import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The device registry (R1-P13): each vessel's manifest and the last value of each item. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_devices (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      firmware TEXT,
      via TEXT NOT NULL,
      version TEXT,
      manifest TEXT NOT NULL,
      last_seen INTEGER,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_device_state (
      device_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      value TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (device_id, item_id)
    )
  `;
});
