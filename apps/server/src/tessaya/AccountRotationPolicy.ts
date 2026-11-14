/**
 * Whether a working thread moves to another account by itself at its account's limit (L-76). A setting
 * he changes in Settings, not an env var. The env var is read once, so a box that ran with it keeps
 * rotating after the upgrade; from then on the setting rules.
 */
import type { TessayaOnLimitSetting } from "@t3tools/tessaya-contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// Legacy name (D71): set by fabric-on-limit.conf on the boxes, so the variable keeps "FABRIC".
export const BATON_ON_LIMIT_ENV = "T3CODE_FABRIC_ON_LIMIT";
const KEY = "on_limit";

export class AccountRotationPolicy extends Context.Service<
  AccountRotationPolicy,
  {
    readonly read: Effect.Effect<TessayaOnLimitSetting>;
    readonly set: (policy: TessayaOnLimitSetting) => Effect.Effect<TessayaOnLimitSetting>;
  }
>()("t3/tessaya/AccountRotationPolicy") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fromEnv = (yield* HostProcess.Environment)[BATON_ON_LIMIT_ENV] === "auto" ? "auto" : "ask";
  yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${KEY}, ${fromEnv}) ON CONFLICT (key) DO NOTHING`.pipe(
    Effect.orDie,
  );

  const read = sql<{
    readonly value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${KEY}`.pipe(
    Effect.map((rows): TessayaOnLimitSetting => (rows[0]?.value === "auto" ? "auto" : "ask")),
    Effect.orDie,
  );
  const set = Effect.fn("AccountRotationPolicy.set")(function* (policy: TessayaOnLimitSetting) {
    yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${KEY}, ${policy})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.orDie);
    return policy;
  });
  return AccountRotationPolicy.of({ read, set });
});

export const layer = Layer.effect(AccountRotationPolicy, make);
