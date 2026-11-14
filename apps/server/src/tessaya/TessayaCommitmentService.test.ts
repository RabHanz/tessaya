import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
