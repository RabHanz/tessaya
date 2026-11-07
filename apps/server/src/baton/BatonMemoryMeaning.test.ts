// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonMemoryEmbedder, layerNone, makeEmbedder } from "./BatonMemoryEmbedder.ts";
import { BatonMemoryService, MemoryViewer, layer as memoryLayer } from "./BatonMemoryService.ts";

/** A stand-in model: each word lands on one axis, so "pricing" and "costs" are near and "train" is far. */
const AXIS: Readonly<Record<string, number>> = {
  pricing: 0,
  price: 0,
  costs: 0,
  subscription: 0,
  train: 1,
  travel: 1,
};
const embedded: string[] = [];
const fakeModel = Layer.succeed(BatonMemoryEmbedder, {
  model: "fake-model",
  embed: (text) =>
    Effect.sync(() => {
      embedded.push(text);
      const v = new Float32Array(2);
      for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        const axis = AXIS[w];
        if (axis !== undefined) v[axis]! += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    }),
});

const withModel = (model: Layer.Layer<BatonMemoryEmbedder>, extra = Layer.empty) =>
  Layer.mergeAll(
    memoryLayer.pipe(Layer.provide(model), Layer.provideMerge(SqlitePersistenceMemory)),
    extra,
  );

const PRICE = "The subscription costs twenty pounds a month";
const TRAIN = "He takes the train on Mondays";
const ASK = "what did we decide about pricing";

it.effect(
  "recalls by meaning what shares no word with the sentence, once the background pass has embedded it",
  () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      yield* memory.add({ kind: "fact", text: PRICE, source: "user" });
      yield* memory.add({ kind: "fact", text: TRAIN, source: "user" });
      // Not embedded yet (the pass waits a minute after start): keywords alone find nothing.
      assert.notInclude((yield* memory.recall({ text: ASK })).block, "subscription");
      yield* TestClock.adjust("2 minutes");
      const block = (yield* memory.recall({ text: ASK })).block;
      assert.include(block, "subscription costs");
      assert.notInclude(block, "train");
      // An edit is embedded again after it commits, not in the edit's own path.
      const item = (yield* memory.list({ admin: true })).find((i) => i.text === TRAIN)!;
      embedded.length = 0;
      yield* memory.edit(item.id, { text: "He travels by train on Mondays" });
      assert.deepStrictEqual(embedded, []);
      yield* TestClock.adjust("1 second");
      assert.include(embedded, "He travels by train on Mondays");
    }).pipe(Effect.provide(withModel(fakeModel))),
);

it.effect("applies the walls before ranking by meaning: a walled item is never a candidate", () => {
  const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-meaning-walls-"));
  const pack = NodePath.join(userdata, "operating-system");
  NodeFS.mkdirSync(NodePath.join(pack, "roles"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(pack, "executive.md"), "---\nwalled: Shop\n---\n");
  NodeFS.writeFileSync(
    NodePath.join(pack, "roles", "engineering.md"),
    "---\nprojects: shop\n---\n",
  );
  const config = Layer.succeed(ServerConfig.ServerConfig, {
    dbPath: NodePath.join(userdata, "state.sqlite"),
  } as never);
  return Effect.gen(function* () {
    const memory = yield* BatonMemoryService;
    yield* memory.add({
      kind: "fact",
      text: "The shop subscription costs ten pounds",
      source: "user",
      scope: "project",
      scopeRef: "shop",
    });
    yield* TestClock.adjust("2 minutes");
    // Freya is not on the shop's team: the nearest item by meaning is behind the wall, so nothing comes back.
    assert.notInclude((yield* memory.recall({ text: ASK, agent: "operations" })).block, "shop");
    assert.include(
      (yield* memory.recall({ text: ASK, agent: "engineering" })).block,
      "shop subscription",
    );
  }).pipe(
    Effect.provideService(MemoryViewer, "desktop"),
    Effect.provide(withModel(fakeModel, config)),
  );
});

it.effect("without a model, recall is keyword recall as before", () =>
  Effect.gen(function* () {
    const memory = yield* BatonMemoryService;
    yield* memory.add({ kind: "fact", text: PRICE, source: "user" });
    yield* TestClock.adjust("2 minutes");
    assert.notInclude((yield* memory.recall({ text: ASK })).block, "subscription");
    assert.include((yield* memory.recall({ text: "subscription" })).block, "subscription costs");
  }).pipe(Effect.provide(withModel(layerNone))),
);

it.effect("never ranks by a vector made from older wording or by another model", () =>
  Effect.gen(function* () {
    const memory = yield* BatonMemoryService;
    const sql = yield* SqlClient.SqlClient;
    const item = yield* memory.add({ kind: "fact", text: PRICE, source: "user" });
    yield* TestClock.adjust("2 minutes");
    // As after an upgrade from the previous model: its vectors wait for the pass to embed them again.
    yield* sql`UPDATE fabric_memory_vectors SET model = ${"all-MiniLM-L6-v2-int8-old"}`;
    assert.notInclude((yield* memory.recall({ text: ASK })).block, "subscription");
    yield* TestClock.adjust("11 minutes");
    assert.include((yield* memory.recall({ text: ASK })).block, "subscription");
    // The words change underneath (as a sync can before the next pass): the old vector no longer speaks for it.
    yield* sql`UPDATE fabric_memory_items SET text = ${"He parks behind the station"} WHERE id = ${item.id}`;
    assert.notInclude((yield* memory.recall({ text: ASK })).block, "station");
  }).pipe(Effect.provide(withModel(fakeModel))),
);

it.effect(
  "keeps another project's items out of the nearest 20, so they take no place from this one's",
  () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      for (let i = 0; i < 25; i += 1) {
        yield* memory.add({
          kind: "fact",
          text: `Shop plan ${i}: the subscription costs ${i} pounds`,
          source: "user",
          scope: "project",
          scopeRef: "shop",
        });
      }
      yield* memory.add({
        kind: "fact",
        text: "Site plan: the subscription costs nine pounds",
        source: "user",
        scope: "project",
        scopeRef: "site",
      });
      yield* TestClock.adjust("2 minutes");
      assert.include((yield* memory.recall({ text: ASK, scopeRef: "site" })).block, "Site plan");
    }).pipe(Effect.provide(withModel(fakeModel))),
);

it.live("a child that cannot load the model answers null, and the server goes on", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-embed-broken-"));
    NodeFS.writeFileSync(NodePath.join(dir, "model_quantized.onnx"), "not a model");
    NodeFS.copyFileSync(
      new URL("../../resources/memory-model/vocab.txt", import.meta.url),
      NodePath.join(dir, "vocab.txt"),
    );
    const embedder = yield* makeEmbedder({ dir, ort: NodePath.join(dir, "no-onnxruntime.js") });
    assert.isNull(yield* embedder.embed("hello"));
    // It backs off: the next sentence is answered at once, keyword-only, without starting another child.
    assert.isNull(yield* embedder.embed("hello again"));
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }).pipe(Effect.scoped),
);
