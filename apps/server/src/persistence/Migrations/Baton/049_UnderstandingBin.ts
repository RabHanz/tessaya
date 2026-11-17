import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Facts forgotten from her understanding of someone (G4), restorable for the people bin's days, then purged. Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_understanding_bin (
      id TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      fact TEXT NOT NULL,
      at TEXT NOT NULL,
      by TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_understanding_bin_ref ON tessaya_understanding_bin (scope_ref)`;
});
