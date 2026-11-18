import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The private tier of her one store (PrivateTier.ts): sealed files a persona layer keeps on the brain, ciphertext only,
 * one row per file name, each newer write a higher revision.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_private_tier (
      name TEXT PRIMARY KEY,
      rev INTEGER NOT NULL,
      at INTEGER NOT NULL,
      blob TEXT NOT NULL
    )
  `;
});
