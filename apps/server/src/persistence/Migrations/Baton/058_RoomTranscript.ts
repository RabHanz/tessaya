import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Every room exchange, his words and hers, by time (the Director, 20 Nov: "her earlier replies at 07:26 are gone"): the
 * day's transcript for her recall and his review. A private moment keeps only that it happened. Kept 30 days.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_room_transcript (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      vessel TEXT NOT NULL,
      conversation TEXT NOT NULL,
      role TEXT NOT NULL,
      who TEXT,
      text TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_room_transcript_at ON tessaya_room_transcript (at)`;
});
