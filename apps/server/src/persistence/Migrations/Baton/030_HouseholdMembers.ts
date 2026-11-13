import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The household's members (ACCOUNTS-IDENTITY-DESIGN I-1, HOUSEHOLD-DESIGN 5b-i), grown from the private stores' people:
 * the owner's row keeps the id his voice profile and private store use, and each saved person with a store becomes an
 * adult with their store's id. Sessions name their member in their subject, so no session row changes. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_household_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'adult', 'child', 'guest')),
      machine INTEGER NOT NULL DEFAULT 0,
      guardians_json TEXT NOT NULL DEFAULT '[]',
      born TEXT,
      adult_age INTEGER,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      purge_after TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tessaya_household_one_owner
      ON tessaya_household_members (role) WHERE role = 'owner'
  `;
  yield* sql`
    INSERT OR IGNORE INTO tessaya_household_members (id, name, role, created_at)
    SELECT person_id, name, CASE kind WHEN 'owner' THEN 'owner' ELSE 'adult' END, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM tessaya_private_stores
  `;
  yield* sql`
    INSERT OR IGNORE INTO tessaya_household_members (id, name, role, created_at)
    SELECT 'owner', 'Owner', 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE NOT EXISTS (SELECT 1 FROM tessaya_household_members WHERE role = 'owner')
  `;
});
