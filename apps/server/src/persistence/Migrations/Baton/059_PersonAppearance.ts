import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** How a person looks, in words he approved (M-114): what her camera turns compare a description against. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(fabric_memory_entities)`;
  if (!columns.some((c) => c.name === "appearance"))
    yield* sql`ALTER TABLE fabric_memory_entities ADD COLUMN appearance TEXT`;
});
