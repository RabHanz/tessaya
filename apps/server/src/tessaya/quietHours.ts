import { CommsQuietHours } from "@t3tools/tessaya-contracts";
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
