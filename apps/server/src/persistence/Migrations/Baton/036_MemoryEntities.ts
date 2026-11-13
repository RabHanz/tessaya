import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The people, projects and places his memories name (Memory v2 step 7): each entity with the other ways he refers to
 * it, and which items mention it. Derived on each server from the items themselves, so nothing extra syncs. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_memory_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS fabric_memory_entities_name ON fabric_memory_entities (lower(name))`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_memory_links (
      item_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (item_id, entity_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS fabric_memory_links_entity ON fabric_memory_links (entity_id)`;
});
