import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Private memory stores (tessaya-ops research/PRIVATE-MEMORIES.md). Items are sealed blobs: no text, no dates and no
 * search index in clear. A store's keys are kept only wrapped. Never synced; backed up as ciphertext. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_private_stores (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      recall_off INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      wait_until INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_opened_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_private_items (
      id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      sealed_json TEXT NOT NULL,
      inbox INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (store_id, id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_private_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      by_whom TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL,
      hash TEXT NOT NULL
    )
  `;
});
