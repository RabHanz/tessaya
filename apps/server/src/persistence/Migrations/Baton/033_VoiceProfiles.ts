import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One voice profile per member and voice model, on the home server beside the members: enrolled once on any vessel,
 * copied to every vessel (ACCOUNTS-IDENTITY-DESIGN §2.4). Numbers only, never audio. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_voice_profiles (
      member_id TEXT NOT NULL,
      model TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      centroid TEXT NOT NULL,
      samples INTEGER NOT NULL,
      sources_json TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      consent_note TEXT,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (member_id, model)
    )
  `;
});
