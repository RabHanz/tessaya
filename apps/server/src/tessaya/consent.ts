// @effect-diagnostics globalJsonInEffect:off
import {
  type Grant,
  grantHolds,
  grantOf,
  liveKeys,
  withScopedGrant,
} from "@t3tools/tessaya-shared/consent";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import * as Clock from "effect/Clock";
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
const GrantRecord = Schema.Struct({
  key: Schema.String,
  member: Schema.String,
  device: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.Number),
});
const decodeGrants = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, GrantRecord]))),
);

/** Every standing yes with its scope, the one store every vessel reads; empty with no database. */
export const readScoped = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return [] as ReadonlyArray<Grant>;
  const rows = yield* sql.value<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${CONSENT_KEY}`.pipe(Effect.orDie);
  return rows[0] === undefined
    ? []
    : Option.getOrElse(decodeGrants(rows[0].value), () => []).map(grantOf);
});

/** The keys that stand now (Settings, the desktop's copy, the room's checks). */
export const readGrants = Effect.gen(function* () {
  return liveKeys(yield* readScoped, yield* Clock.currentTimeMillis);
});

/** What a grant covers beyond its key: the member (the owner unless named), a device, a persona, an end. */
export type GrantScope = Partial<Omit<Grant, "key">>;

/** Adds one standing yes, or revokes every grant of its key; the live keys after. */
export const setGrant = Effect.fn("Consent.set")(function* (
  key: string,
  allow: boolean,
  scope: GrantScope = {},
) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const grants = withScopedGrant(
    yield* readScoped,
    { member: OWNER_MEMBER_ID, ...scope, key },
    allow,
  );
  if (Option.isSome(sql))
    yield* sql.value`INSERT INTO fabric_settings (key, value) VALUES (${CONSENT_KEY}, ${JSON.stringify(grants)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
      Effect.orDie,
    );
  // The desktop's held settings sync carries the list, so a revoke made elsewhere reaches its copy now.
  const desk = yield* Effect.serviceOption(TessayaDesktopSettings);
  if (Option.isSome(desk)) yield* desk.value.nudge;
  return liveKeys(grants, yield* Clock.currentTimeMillis);
});

/** Who a turn is for a grant: his own turn (hisOwnTurn) is the owner's at A2; any other, its member at its level. */
export const grantWho = (origin: {
  readonly kind: string;
  readonly id?: string;
  readonly hisVoice?: boolean | undefined;
  readonly speaker?: unknown;
  readonly member?: string | null | undefined;
  readonly assurance?: number | undefined;
  readonly tainted?: boolean | undefined;
  readonly persona?: string | null | undefined;
}) => {
  const his = hisOwnTurn(origin);
  return {
    member: his ? OWNER_MEMBER_ID : (origin.member ?? null),
    assurance: his ? Math.max(2, origin.assurance ?? 0) : (origin.assurance ?? 0),
    tainted: origin.tainted === true,
    ...(origin.id === undefined ? {} : { device: origin.id }),
    persona: origin.persona ?? null,
  };
};

/** Whether a granted capability needs no ask on this turn. */
export const holds = Effect.fn("Consent.holds")(function* (
  key: string,
  origin: Parameters<typeof grantWho>[0] | null,
) {
  if (origin === null) return false;
  return grantHolds(yield* readScoped, key, grantWho(origin), yield* Clock.currentTimeMillis);
});

/**
 * His standing yeses on Tessaya's own database, for code that runs where upstream's SqlClient is the ambient one (the
 * room's tool runners): read there, `readGrants` died on "no such table: fabric_settings" and every card act failed.
 */
export class Consent extends Context.Service<
  Consent,
  {
    readonly read: Effect.Effect<ReadonlyArray<string>>;
    readonly set: (
      key: string,
      allow: boolean,
      scope?: GrantScope,
    ) => Effect.Effect<ReadonlyArray<string>>;
    readonly holds: (
      key: string,
      origin: Parameters<typeof grantWho>[0] | null,
    ) => Effect.Effect<boolean>;
  }
>()("t3/tessaya/consent") {}

export const layer = Layer.effect(
  Consent,
  Effect.map(SqlClient.SqlClient, (sql) =>
    Consent.of({
      read: readGrants.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      set: Effect.fn("Consent.setOnTessaya")(function* (
        key: string,
        allow: boolean,
        scope?: GrantScope,
      ) {
        return yield* Effect.provideService(setGrant(key, allow, scope), SqlClient.SqlClient, sql);
      }),
      holds: Effect.fn("Consent.holdsOnTessaya")(function* (
        key: string,
        origin: Parameters<typeof grantWho>[0] | null,
      ) {
        return yield* Effect.provideService(holds(key, origin), SqlClient.SqlClient, sql);
      }),
    }),
  ),
);
