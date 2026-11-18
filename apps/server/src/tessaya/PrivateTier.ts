/**
 * The private tier of her one store (PRIVATE-LAYER-REORIENT, step 2): a persona layer's sealed files, kept on the brain
 * so the standby replicates them with everything else. Ciphertext only: the keys never leave the layer, and nothing
 * here is logged but a file's name and revision. A write older than what is kept is refused, so two vessels never
 * overwrite each other with a stale copy.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The most one sealed file may weigh here: her store, audit and events, never body models. */
export const TIER_MAX_BYTES = 24 * 1024 * 1024;

const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,79}$/));
export const PrivateTierAct = Schema.Union([
  Schema.Struct({ get: Name }),
  // Every file's revision and no bytes, so a vessel fetches only what changed.
  Schema.Struct({ revs: Schema.Literal(true) }),
  Schema.Struct({
    put: Schema.Struct({
      name: Name,
      rev: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      // Base64 ciphertext.
      blob: Schema.String.check(
        Schema.isMaxLength(Math.ceil(TIER_MAX_BYTES / 3) * 4),
        Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
      ),
    }),
  }),
]);
export type PrivateTierAct = typeof PrivateTierAct.Type;

export interface TierFile {
  readonly rev: number;
  readonly blob: string;
}

/** Her one store's database; none here (no Tessaya database) means the tier is not on this server. */
const tierSql = Effect.flatMap(Effect.serviceOption(SqlClient.SqlClient), Effect.fromOption);

/** One sealed file, or null. */
export const tierGet = Effect.fn("PrivateTier.get")(function* (name: string) {
  const sql = yield* tierSql;
  const rows =
    yield* sql<TierFile>`SELECT rev, blob FROM tessaya_private_tier WHERE name = ${name}`;
  return rows[0] ?? null;
});

/** Each kept file's revision by name. */
export const tierRevs = Effect.fn("PrivateTier.revs")(function* () {
  const sql = yield* tierSql;
  const rows = yield* sql<{
    name: string;
    rev: number;
  }>`SELECT name, rev FROM tessaya_private_tier`;
  return Object.fromEntries(rows.map((r) => [r.name, r.rev]));
});

/** Keeps `blob` when `rev` is newer than what is kept; the revision kept afterwards either way. */
export const tierPut = Effect.fn("PrivateTier.put")(function* (
  name: string,
  rev: number,
  blob: string,
  at: number,
) {
  const sql = yield* tierSql;
  yield* sql`
    INSERT INTO tessaya_private_tier (name, rev, at, blob) VALUES (${name}, ${rev}, ${at}, ${blob})
    ON CONFLICT (name) DO UPDATE SET rev = excluded.rev, at = excluded.at, blob = excluded.blob
    WHERE excluded.rev > tessaya_private_tier.rev
  `;
  const rows = yield* sql<{
    rev: number;
  }>`SELECT rev FROM tessaya_private_tier WHERE name = ${name}`;
  const kept = rows[0]?.rev ?? 0;
  yield* Effect.logDebug("private tier", { name, rev, kept });
  return { kept: kept === rev, rev: kept };
});

/** A tier act as the brain applies it, here or for a worker. */
export const tierAct = Effect.fn("PrivateTier.act")(function* (act: PrivateTierAct, at: number) {
  if ("revs" in act) return yield* tierRevs();
  return "get" in act
    ? yield* tierGet(act.get)
    : yield* tierPut(act.put.name, act.put.rev, act.put.blob, at);
});
