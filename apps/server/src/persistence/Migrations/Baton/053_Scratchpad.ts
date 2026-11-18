import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** His Scratchpad on her brain, the one store the desktop caches and the Tessel reads (ONE-SPINE-MAP §14). Additive. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_scratchpad (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      text TEXT NOT NULL
    )
  `;
});
