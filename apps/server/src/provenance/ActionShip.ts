/**
 * A worker's own events reach her brain's Record (provenance in the bones, 21 Nov: the laptop held 72k and onnyx 50k
 * the brain never saw). Every minute a worker sends what it stored since the last one the brain took, oldest first;
 * the brain keeps each once under its own id and origin. Not sent: a Tessel's room and device events, which the brain
 * already hears from her hub itself, and his private events' pointers, which never leave the server that sealed them.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBrainLink } from "../tessaya/BrainHost.ts";
import { ActionLog } from "./ActionLog.ts";

const CURSOR_KEY = "provenance.shippedTo";
const BATCH = 500;

/** Whether a worker sends this event to its brain. Pure. */
export const shipsToBrain = (kind: string) =>
  !kind.startsWith("room.") && !kind.startsWith("device.") && kind !== "private";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const log = yield* ActionLog;
    const sql = yield* SqlClient.SqlClient;
    const brain = yield* makeBrainLink;
    const ship = Effect.gen(function* () {
      if (yield* brain.isBrain) return;
      const kept = yield* sql<{ value: string }>`SELECT value FROM fabric_settings WHERE key = ${CURSOR_KEY}`;
      const [at = 0, id = ""] = (kept[0]?.value ?? "0|").split("|");
      for (let cursor = { at: Number(at), id }; ; ) {
        const rows = yield* log.rowsAfter(cursor.at, cursor.id, BATCH);
        const last = rows.at(-1);
        if (last === undefined) return;
        const sent = yield* brain.send("actions", { rows: rows.filter((r) => shipsToBrain(r.kind)) });
        if (Option.isNone(sent)) return;
        cursor = { at: last.at, id: last.id };
        yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${CURSOR_KEY}, ${`${last.at}|${last.id}`})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
        if (rows.length < BATCH) return;
      }
    }).pipe(Effect.ignoreCause({ log: true }));
    yield* ship.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  }),
);
