import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { pullAction, pullLearnings, searchHistory } from "./BatonMemoryPull.ts";
import { BatonMemoryService, layer as memoryLayer, MemoryViewer } from "./BatonMemoryService.ts";
import { BatonMemorySync } from "./BatonMemorySync.ts";

// The paired peer that holds the index, when a test gives it one.
let peerIndex: string | null = null;
const asked: Array<unknown> = [];
const peers = Layer.mock(BatonMemorySync)({
  history: (ask) =>
    Effect.sync(() => {
      asked.push(ask);
      return Option.fromNullishOr(peerIndex);
    }),
});
const layer = it.layer(
  Layer.mergeAll(memoryLayer, peers).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const env = { BATON_HISTORY_SEARCH: "/x/search.sh" };
const out =
  "cc828d1b  venture: shopfront  Learned the supplier needs the invoice before shipping starts\n";

layer("learnings pull", (it) => {
  it.effect("proposes quotes with their session, held for his yes, once", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const first = yield* pullLearnings(env, async () => out);
      assert.deepEqual({ found: first.found, held: first.held }, { found: 1, held: 1 });
      assert.lengthOf(yield* memory.search({ text: "supplier invoice" }), 0);
      const held = (yield* memory.list({ includeProposed: true }))[0]!;
      assert.isTrue(held.proposed);
      assert.strictEqual(held.scopeRef, "shopfront");
      assert.strictEqual(held.sourceRef, "session:cc828d1b");
      assert.include(held.text, "supplier needs the invoice");
      const again = yield* pullLearnings(env, async () => out);
      assert.strictEqual(again.found, 0);
    }),
  );

  it.effect("says so plainly without the index, and the switch is kept", () =>
    Effect.gen(function* () {
      const none = yield* pullLearnings({});
      assert.include(none.why ?? "", "No server with the history index could be reached");
      assert.isFalse((yield* pullAction("status")).enabled);
      assert.isTrue((yield* pullAction("enable")).enabled);
      assert.isFalse((yield* pullAction("disable")).enabled);
    }),
  );

  it.effect(
    "without its own index, asks the paired server that holds it; a peer's ask is never passed on",
    () =>
      Effect.gen(function* () {
        peerIndex = out;
        asked.length = 0;
        const there = yield* searchHistory({ query: "supplier" }, {});
        assert.deepEqual(there, { ok: true, text: out });
        assert.deepEqual(asked, [{ query: "supplier" }]);
        // The pull lands what the peer's index found here, held for his yes.
        assert.strictEqual((yield* pullLearnings({})).why, null);
        const fromPeer = yield* searchHistory({ query: "supplier" }, {}).pipe(
          Effect.provideService(MemoryViewer, "server"),
        );
        assert.isFalse(fromPeer.ok);
        assert.lengthOf(asked, 1 + 4);
        // With its own index, the peers are not asked.
        yield* searchHistory({ query: "supplier" }, env, async () => out);
        assert.lengthOf(asked, 5);
        peerIndex = null;
      }),
  );
});
