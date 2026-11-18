import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { runtimeLayer, TessayaRuntime } from "./TessayaRpcHandlers.ts";
import { scratchpad } from "./TessayaScratchpad.ts";

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

// .189's room gate: the Tessel's note tools run in the routes' runtime, whose ambient SqlClient was upstream's.
it.effect(
  "the routes' runtime keeps his notes in baton.sqlite, beside upstream's own database",
  () =>
    Effect.gen(function* () {
      const runtime = yield* TessayaRuntime;
      assert.isNotNull(runtime);
      const act = (a: Parameters<typeof scratchpad>[0]) =>
        scratchpad(a).pipe(Effect.provideContext(runtime!));
      yield* act({ op: "add", notes: [note("a", 1, "the replay suite ran")] });
      assert.deepStrictEqual(
        yield* act({ op: "search", query: "replay" }),
        Option.some({ notes: [note("a", 1, "the replay suite ran")] }),
      );
    }).pipe(
      Effect.provide(
        // Its services are not read here; only the database the runtime carries.
        (
          runtimeLayer as unknown as Layer.Layer<
            never,
            Layer.Error<typeof runtimeLayer>,
            ServerConfig.ServerConfig
          >
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratchpad-runtime-" }),
          ),
          // Upstream's own client, without her tables: the ambient one the routes run beside.
          Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
