import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HOME_KEY } from "./BrainHost.ts";
import { receiveAtBrain } from "./BrainReceive.ts";

import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import { TessayaCommitmentService, layer as commitmentLayer } from "./TessayaCommitmentService.ts";

const layer = it.layer(commitmentLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const open = (id: string, updatedAt: number, due: number | null = null) => ({
  id,
  text: `task ${id}`,
  owner: "tessaya" as const,
  due,
  status: "open" as const,
  source: "voice" as const,
  createdAt: 1,
  updatedAt,
});

layer("BatonCommitmentService", (it) => {
  it.effect("keeps what a device pushes, and the newer edit wins", () =>
    Effect.gen(function* () {
      const svc = yield* TessayaCommitmentService;
      assert.strictEqual(yield* svc.upsert([open("a", 10), open("b", 10)]), 2);
      assert.strictEqual(yield* svc.upsert([open("a", 5, 99)]), 0);
      assert.strictEqual(yield* svc.upsert([open("a", 20, 99)]), 1);
      const items = yield* svc.list;
      assert.deepStrictEqual(
        items.map((c) => c.id),
        ["a", "b"],
      );
      assert.strictEqual(items[0]?.due, 99);
    }),
  );

  it.effect("a stale open copy never reopens a closed commitment", () =>
    Effect.gen(function* () {
      const svc = yield* TessayaCommitmentService;
      yield* svc.upsert([open("c", 10)]);
      yield* svc.upsert([
        { ...open("c", 30), status: "done" as const, closedAt: 2_000_000_000_000 },
      ]);
      assert.strictEqual(yield* svc.upsert([open("c", 99)]), 0);
      const c = (yield* svc.list).find((x) => x.id === "c");
      assert.strictEqual(c?.status, "done");
    }),
  );
});

it.effect(
  "one brain (M-103): a worker's reminders land on the brain, what it held moves up, and a brain that moves gets them",
  () =>
    Effect.gen(function* () {
      const brainCtx = yield* Layer.build(
        commitmentLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      );
      const onBrain = Context.get(brainCtx, TessayaCommitmentService);
      let reachable = true;
      const workerCtx = yield* Layer.build(
        commitmentLayer.pipe(
          Layer.provideMerge(
            Layer.succeed(PeerLinks.PeerLinks, {
              enabled: Effect.succeed(true),
              list: Effect.succeed([
                { ...descriptorOf("env-brain", "brain"), label: "brain", status: "ok" } as never,
              ]),
            } as never),
          ),
          Layer.provideMerge(
            Layer.succeed(
              PeerMcpClient.PeerMcpClient,
              PeerMcpClient.PeerMcpClient.of({
                call: (input) =>
                  (reachable
                    ? receiveAtBrain(
                        input.arguments["op"] as never,
                        input.arguments["payload"],
                      ).pipe(Effect.provideContext(brainCtx))
                    : Effect.fail("away")) as never,
              }),
            ),
          ),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      );
      const worker = Context.get(workerCtx, TessayaCommitmentService);
      const sql = Context.get(workerCtx, SqlClient.SqlClient);
      // made here while this server was her brain, then the brain moved
      yield* worker.upsert([open("before", 10, 500)]);
      yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'brain')`;
      yield* worker.upsert([open("after", 10, 600)]);
      assert.deepStrictEqual(
        (yield* onBrain.list).map((c) => c.id),
        ["after", "before"].toSorted(),
      );
      assert.deepStrictEqual((yield* worker.list).map((c) => c.id).toSorted(), ["after", "before"]);
      // the brain away: the write waits in the outbox, then lands once
      reachable = false;
      yield* worker.upsert([open("away", 10, 700)]);
      assert.notInclude(
        (yield* onBrain.list).map((c) => c.id),
        "away",
      );
      reachable = true;
      assert.include(
        (yield* worker.list).map((c) => c.id),
        "away",
      );
      assert.include(
        (yield* onBrain.list).map((c) => c.id),
        "away",
      );
    }).pipe(Effect.scoped),
);
