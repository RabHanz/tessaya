import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each member's passkeys (ACCOUNTS-IDENTITY-DESIGN I-3): the public key a device made for this server, never a secret,
 * and its counter, so a copied key shows. A step-up with one is A3 on that device. Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_member_passkeys (
      credential_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      public_key_jwk TEXT NOT NULL,
      alg INTEGER NOT NULL,
      sign_count INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_member_passkeys_member ON tessaya_member_passkeys (member_id)`;
});
