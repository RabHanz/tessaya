import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const note = (id: string, at: number, text: string) => ({ id, at, text });

it.layer(SqlitePersistenceMemory)("his Scratchpad on the brain", (it) => {
  it.effect("keeps each note once by id, finds by every word, removes; a worker keeps none", () =>
    Effect.gen(function* () {
      const act = (a: unknown) => receiveAtBrain("scratchpad", a);
      yield* act({ op: "add", notes: [note("a", 1, "invoice due Friday")] });
      // A desktop replaying what it wrote offline sends the same id again.
      yield* act({
        op: "add",
        notes: [note("a", 1, "invoice due Friday"), note("b", 2, "call the plumber")],
      });
      assert.deepStrictEqual(yield* act({ op: "list" }), {
        ok: true,
        value: { notes: [note("b", 2, "call the plumber"), note("a", 1, "invoice due Friday")] },
      });
      assert.deepStrictEqual(yield* act({ op: "search", query: "Friday invoice" }), {
        ok: true,
        value: { notes: [note("a", 1, "invoice due Friday")] },
      });
      yield* act({ op: "remove", ids: ["a"] });
      assert.deepStrictEqual(yield* act({ op: "list" }), {
        ok: true,
        value: { notes: [note("b", 2, "call the plumber")] },
      });
      assert.isFalse((yield* act({ op: "add", notes: [note("c", 3, "")] })).ok);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'home-box')`;
      assert.isFalse((yield* act({ op: "list" })).ok);
      yield* sql`DELETE FROM fabric_settings WHERE key = ${HOME_KEY}`;
    }),
  );
});
