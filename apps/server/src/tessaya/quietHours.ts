import { CommsQuietHours } from "@t3tools/tessaya-contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const QUIET_KEY = "comms.quietHours";
const decodeQuiet = Schema.decodeUnknownOption(Schema.fromJsonString(CommsQuietHours));

/** The household's one quiet hours, read alike by comms, her expression and the job flow; the desktop caches it. */
export const readQuietHours = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return null;
  const rows = yield* sql.value<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${QUIET_KEY}`.pipe(Effect.orDie);
  return rows[0] === undefined ? null : Option.getOrNull(decodeQuiet(rows[0].value));
});

export const DND_PREFIX = "comms.dnd.";
/** A member's do-not-disturb end (ms; Infinity until they turn it off), or null when off or over. */
export const readDndUntil = Effect.fn("quietHours.readDndUntil")(function* (member: string) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return null;
  const rows = yield* sql.value<{
    value: string;
  }>`SELECT value FROM fabric_settings WHERE key = ${DND_PREFIX + member}`.pipe(Effect.orDie);
  const v = rows[0]?.value ?? null;
  if (v === "on") return Number.POSITIVE_INFINITY;
  const until = v === null ? Number.NaN : Date.parse(v);
  return Number.isFinite(until) && until > (yield* Clock.currentTimeMillis) ? until : null;
});
