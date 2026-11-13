import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Memory v2 step 5: whose memory an item is and where it came from. `visibility` household (every persona) or persona
 * (only `persona`); `surface` the vessel kind and `speaker` the voice that told it. Additive; a persona's conversation
 * episodes take their persona from their sourceRef (`conversation:<persona id>:...`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fabric_memory_items ADD COLUMN persona TEXT`;
  yield* sql`ALTER TABLE fabric_memory_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'household'`;
  yield* sql`ALTER TABLE fabric_memory_items ADD COLUMN surface TEXT`;
  yield* sql`ALTER TABLE fabric_memory_items ADD COLUMN speaker TEXT`;
  yield* sql`
    UPDATE fabric_memory_items
    SET persona = substr(source_ref, 14, instr(substr(source_ref, 14), ':') - 1)
    WHERE source_ref LIKE 'conversation:%:%'
  `;
});
