/**
 * The commitments ledger on the server (D149), so every device he uses sees the same list. The
 * rules are the pure ones in `@t3tools/tessaya-shared/commitments`; this keeps rows. One rule lives
 * here because two devices race: a closed row is never reopened by a stale open copy.
 */
import { BatonCommitmentError, type BatonCommitment } from "@t3tools/tessaya-contracts";
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

const fromRow = (r: Row): BatonCommitment => ({
  id: r.id,
  text: r.text,
  owner: r.owner as BatonCommitment["owner"],
  due: r.due,
  status: r.status as BatonCommitment["status"],
  source: r.source as BatonCommitment["source"],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.closed_at === null ? {} : { closedAt: r.closed_at }),
  ...(r.ref === null ? {} : { ref: r.ref }),
});

/** Closed rows older than this are dropped on the way, like the file on a device. */
const KEEP_CLOSED_MS = 30 * 86_400_000;

export class BatonCommitmentService extends Context.Service<
  BatonCommitmentService,
  {
    readonly list: Effect.Effect<ReadonlyArray<BatonCommitment>>;
    readonly upsert: (
      items: ReadonlyArray<BatonCommitment>,
    ) => Effect.Effect<number, BatonCommitmentError>;
  }
>()("t3/baton/BatonCommitmentService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = sql<Row>`SELECT * FROM fabric_commitments ORDER BY created_at, id`.pipe(
    Effect.map((rows) => rows.map(fromRow)),
    Effect.orDie,
  );

  const upsert = Effect.fn("BatonCommitmentService.upsert")(function* (
    items: ReadonlyArray<BatonCommitment>,
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

  return BatonCommitmentService.of({ list, upsert });
});

export const layer = Layer.effect(BatonCommitmentService, make);
