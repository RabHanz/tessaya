import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The usage ledger becomes the one record of every paid call: who paid (billing, account), the list price and its
 * price-list date, and what it was for (feature, surface, persona, thread, turn, job, schedule, device, member) with
 * what started it (`origin`), and whether it worked (`outcome`: a failed call is still a call). `call_key` makes a provider turn's report count once. Additive; old rows keep their
 * role as their feature.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const column of [
    "feature TEXT NOT NULL DEFAULT ''",
    "origin TEXT NOT NULL DEFAULT ''",
    "surface TEXT",
    "persona TEXT",
    "thread_id TEXT",
    "turn_id TEXT",
    "job_id TEXT",
    "schedule_id TEXT",
    "device TEXT",
    "member TEXT",
    "billing TEXT NOT NULL DEFAULT 'subscription'",
    "account TEXT",
    "list_dollars REAL",
    "price_version TEXT",
    "call_key TEXT",
    "outcome TEXT NOT NULL DEFAULT 'ok'",
    "audio_ms INTEGER",
  ]) {
    yield* sql.unsafe(`ALTER TABLE tessaya_brain_usage ADD COLUMN ${column}`);
  }
  yield* sql`
    UPDATE tessaya_brain_usage SET feature = role, origin = 'unknown', list_dollars = dollars,
      billing = CASE WHEN credential LIKE 'apiKey:%' THEN 'apiKey' ELSE 'subscription' END
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tessaya_brain_usage_call_key
    ON tessaya_brain_usage (call_key) WHERE call_key IS NOT NULL
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_brain_usage_thread ON tessaya_brain_usage (thread_id)`;
});
