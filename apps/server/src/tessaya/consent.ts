// @effect-diagnostics globalJsonInEffect:off
import { withGrant } from "@t3tools/tessaya-shared/consent";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
  return keys;
});
