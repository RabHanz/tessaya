import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The people graph in the one memory (HOUSEHOLD-DESIGN §11): an entity may be a person heard by voice (a known guest,
 * or an unknown voice clustered across sessions), with a voice centroid and a retention date; edges join people to
 * each other and to events, each from the item that said so; sightings are the turns a non-member voice was heard.
 * A forgotten person waits in a bin (`forgotten_json`) until restored or purged. Voices and sightings stay on this server (no sync yet, B-044). Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const has = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(fabric_memory_entities)`).map((c) => c.name),
  );
  for (const [name, type] of [
    ["kind", "TEXT"],
    ["status", "TEXT"],
    ["member_id", "TEXT"],
    ["voice_model", "TEXT"],
    ["voice_centroid", "TEXT"],
    ["voice_samples", "INTEGER NOT NULL DEFAULT 0"],
    ["first_seen", "TEXT"],
    ["last_seen", "TEXT"],
    ["keep_until", "TEXT"],
    ["ask_name", "INTEGER NOT NULL DEFAULT 1"],
    ["asked_at", "TEXT"],
    ["impression", "TEXT"],
    ["forgotten_json", "TEXT"],
  ] as const)
    if (!has.has(name))
      yield* sql.unsafe(`ALTER TABLE fabric_memory_entities ADD COLUMN ${name} ${type}`);
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_memory_edges (
      from_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      to_id TEXT NOT NULL,
      item_id TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1,
      at TEXT NOT NULL,
      PRIMARY KEY (from_id, relation, to_id, item_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS fabric_memory_edges_to ON fabric_memory_edges (to_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS fabric_memory_edges_item ON fabric_memory_edges (item_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fabric_memory_sightings (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      at TEXT NOT NULL,
      vessel TEXT NOT NULL,
      said TEXT NOT NULL,
      model TEXT NOT NULL,
      vector TEXT NOT NULL,
      ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fabric_memory_sightings_entity ON fabric_memory_sightings (entity_id, at)
  `;
});
