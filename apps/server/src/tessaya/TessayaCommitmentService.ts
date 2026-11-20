/**
 * The commitments ledger on the server (D149), so every device he uses sees the same list. The
 * rules are the pure ones in `@t3tools/tessaya-shared/commitments`; this keeps rows. One rule lives
 * here because two devices race: a closed row is never reopened by a stale open copy. The rows live on her brain,
 * whose pulse alone raises them (M-103); a worker keeps a copy and queues writes until the brain answers.
 */
import { TessayaCommitment, TessayaCommitmentError } from "@t3tools/tessaya-contracts";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { brainOn, makeBrainLink } from "./BrainHost.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

interface Row {
  readonly id: string;
  readonly text: string;
  readonly owner: string;
  readonly due: number | null;
  readonly status: string;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly closed_at: number | null;
  readonly ref: string | null;
}

const fromRow = (r: Row): TessayaCommitment => ({
  id: r.id,
  text: r.text,
  owner: r.owner as TessayaCommitment["owner"],
  due: r.due,
  status: r.status as TessayaCommitment["status"],
  source: r.source as TessayaCommitment["source"],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.closed_at === null ? {} : { closedAt: r.closed_at }),
  ...(r.ref === null ? {} : { ref: r.ref }),
});

/** Closed rows older than this are dropped on the way, like the file on a device. */
const KEEP_CLOSED_MS = 30 * 86_400_000;

export class TessayaCommitmentService extends Context.Service<
  TessayaCommitmentService,
  {
    readonly list: Effect.Effect<ReadonlyArray<TessayaCommitment>>;
    readonly upsert: (
      items: ReadonlyArray<TessayaCommitment>,
    ) => Effect.Effect<number, TessayaCommitmentError>;
    /** This server's own rows, for the brain applying a worker's ask (never forwarded again). */
    readonly local: {
      readonly list: Effect.Effect<ReadonlyArray<TessayaCommitment>>;
      readonly upsert: (
        items: ReadonlyArray<TessayaCommitment>,
      ) => Effect.Effect<number, TessayaCommitmentError>;
    };
  }
>()("t3/tessaya/TessayaCommitmentService") {}

/** What a worker asks of the brain's ledger. */
export const CommitmentAsk = Schema.Union([
  Schema.Struct({ m: Schema.Literal("list") }),
  Schema.Struct({ m: Schema.Literal("upsert"), items: Schema.Array(TessayaCommitment) }),
]);
const decodeRows = Schema.decodeUnknownOption(Schema.Array(TessayaCommitment));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const brain = yield* makeBrainLink;
  const brainOnLabel = brainOn.pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const localList = sql<Row>`SELECT * FROM fabric_commitments ORDER BY created_at, id`.pipe(
    Effect.map((rows) => rows.map(fromRow)),
    Effect.orDie,
  );

  const localUpsert = Effect.fn("BatonCommitmentService.upsert")(function* (
    items: ReadonlyArray<TessayaCommitment>,
  ) {
    let applied = 0;
    for (const c of items) {
      const stamp = c.updatedAt ?? c.closedAt ?? c.createdAt;
      const held = yield* sql<Row>`SELECT * FROM fabric_commitments WHERE id = ${c.id}`.pipe(
        Effect.orDie,
      );
      const old = held[0];
      if (old !== undefined) {
        // A stale open copy never reopens a closed row; otherwise the newer edit wins.
        if (old.status !== "open" && c.status === "open") continue;
        if (old.status === c.status && old.updated_at >= stamp) continue;
      }
      yield* sql`
        INSERT OR REPLACE INTO fabric_commitments
          (id, text, owner, due, status, source, created_at, updated_at, closed_at, ref)
        VALUES (${c.id}, ${c.text}, ${c.owner}, ${c.due}, ${c.status}, ${c.source},
                ${c.createdAt}, ${stamp}, ${c.closedAt ?? null}, ${c.ref ?? null})
      `.pipe(Effect.orDie);
      applied += 1;
    }
    const cutoff = (yield* Clock.currentTimeMillis) - KEEP_CLOSED_MS;
    yield* sql`
      DELETE FROM fabric_commitments WHERE status != 'open' AND COALESCE(closed_at, updated_at) < ${cutoff}
    `.pipe(Effect.orDie);
    return applied;
  });

  // The brain this server last moved its own rows up to: a brain that moves gets them again (upsert is idempotent).
  let movedTo: string | null = null;
  const moveUp = Effect.gen(function* () {
    const label = yield* brainOnLabel;
    if (label === null || movedTo === label) return;
    const mine = (yield* localList).filter((c) => c.status === "open");
    if (
      mine.length > 0 &&
      Option.isNone(yield* brain.send("commitments", { m: "upsert", items: mine }))
    )
      return;
    movedTo = label;
  });

  const list = Effect.gen(function* () {
    if (yield* brain.isBrain) return yield* localList;
    yield* moveUp;
    yield* brain.replay();
    const there = Option.flatMap(yield* brain.send("commitments", { m: "list" }), decodeRows);
    // the brain away: the copy here, never a second truth
    return Option.isSome(there) ? there.value : yield* localList;
  });

  const upsert = Effect.fn("TessayaCommitmentService.upsert")(function* (
    items: ReadonlyArray<TessayaCommitment>,
  ) {
    // kept here too: the copy a worker reads while the brain is away
    const applied = yield* localUpsert(items);
    if (yield* brain.isBrain) return applied;
    yield* moveUp;
    const sent = yield* brain.sendOrQueue("commitments", { m: "upsert", items });
    return Option.isSome(sent) && typeof sent.value === "number" ? sent.value : applied;
  });

  // a worker that holds rows of its own (it was the brain, or was apart) moves them up without waiting for a call
  yield* moveUp.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  return TessayaCommitmentService.of({
    list,
    upsert,
    local: { list: localList, upsert: localUpsert },
  });
});

export const layer = Layer.effect(TessayaCommitmentService, make);
