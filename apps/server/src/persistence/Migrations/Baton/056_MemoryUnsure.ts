import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** "Not sure who" (the Director, 20 Nov): a memory from a voice not verified waits here, with where it came from. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(fabric_memory_items)`;
  if (!columns.some((c) => c.name === "unsure_json"))
    yield* sql`ALTER TABLE fabric_memory_items ADD COLUMN unsure_json TEXT`;
});
