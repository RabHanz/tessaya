// @effect-diagnostics globalJsonInEffect:off
import { withGrant } from "@t3tools/tessaya-shared/consent";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { TessayaDesktopSettings } from "./TessayaDesktopSettings.ts";

/**
 * Whether a turn is him for a standing yes: his voice verified (Voice ID's session hold counts), or typed on a device he
 * signed in (desktop, phone, web) with no voice on it. A guest's or an unverified voice, an agent and a job are not.
 */
export const hisOwnTurn = (origin: {
  readonly kind: string;
  readonly hisVoice?: boolean | undefined;
  readonly speaker?: unknown;
  readonly member?: string | null | undefined;
}): boolean =>
  origin.hisVoice === true ||
  (origin.speaker == null &&
    origin.member === OWNER_MEMBER_ID &&
    (origin.kind === "desktop" || origin.kind === "phone" || origin.kind === "web"));

export const CONSENT_KEY = "tessaya.alwaysAllowed";
const decodeKeys = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/** His standing yeses, the one list every vessel reads (the desktop keeps a copy); empty with no database. */
export const readGrants = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return [] as ReadonlyArray<string>;
  const rows = yield* sql.value<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${CONSENT_KEY}`.pipe(Effect.orDie);
  return rows[0] === undefined ? [] : Option.getOrElse(decodeKeys(rows[0].value), () => []);
});

/** Adds or revokes one standing yes; the list after. */
export const setGrant = Effect.fn("Consent.set")(function* (key: string, allow: boolean) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const keys = withGrant(yield* readGrants, key, allow);
  if (Option.isSome(sql))
    yield* sql.value`INSERT INTO fabric_settings (key, value) VALUES (${CONSENT_KEY}, ${JSON.stringify(keys)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
      Effect.orDie,
    );
  // The desktop's held settings sync carries the list, so a revoke made elsewhere reaches its copy now.
  const desk = yield* Effect.serviceOption(TessayaDesktopSettings);
  if (Option.isSome(desk)) yield* desk.value.nudge;
  return keys;
});

/**
 * His standing yeses on Tessaya's own database, for code that runs where upstream's SqlClient is the ambient one (the
 * room's tool runners): read there, `readGrants` died on "no such table: fabric_settings" and every card act failed.
 */
export class Consent extends Context.Service<
  Consent,
  {
    readonly read: Effect.Effect<ReadonlyArray<string>>;
    readonly set: (key: string, allow: boolean) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/tessaya/consent") {}

export const layer = Layer.effect(
  Consent,
  Effect.map(SqlClient.SqlClient, (sql) =>
    Consent.of({
      read: readGrants.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      set: Effect.fn("Consent.setOnTessaya")(function* (key: string, allow: boolean) {
        return yield* Effect.provideService(setGrant(key, allow), SqlClient.SqlClient, sql);
      }),
    }),
  ),
);
