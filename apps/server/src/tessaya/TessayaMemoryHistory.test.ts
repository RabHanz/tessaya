// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { MEMORY_VERSIONS_KEPT } from "@t3tools/tessaya-shared/memory";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import {
  TessayaMemoryService,
  MemoryViewer,
  layer as memoryLayer,
} from "./TessayaMemoryService.ts";

const fresh = Layer.build(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory))).pipe(
  Effect.map((context) => Context.get(context, TessayaMemoryService)),
);

it.effect("keeps each earlier wording with who and why, and a restore is a new version", () =>
  Effect.gen(function* () {
    const memory = yield* fresh;
    const item = yield* memory.add({
      kind: "fact",
      text: "The shop deploys on Fridays",
      source: "user",
    });
    yield* memory.edit(item.id, { text: "The shop deploys on Thursdays" });
    yield* memory.rewrite(item.id, "Shop deploys happen on Thursdays");
    const versions = yield* memory.history(item.id);
    assert.deepStrictEqual(
      versions.map((v) => [v.version, v.text, v.by]),
      [
        [2, "The shop deploys on Thursdays", "rewrite"],
        [1, "The shop deploys on Fridays", "him"],
      ],
    );
    // Back to the first wording: it is the item's text again, and nothing earlier is lost.
    const back = yield* memory.restore(item.id, 1);
    assert.strictEqual(back.text, "The shop deploys on Fridays");
    const after = yield* memory.history(item.id);
    assert.strictEqual(after.length, 3);
    assert.strictEqual(after[0]!.text, "Shop deploys happen on Thursdays");
    assert.include(after[0]!.why, "restored version 1");
    assert.strictEqual(
      (yield* Effect.flip(memory.restore(item.id, 99))).reason,
      "there is no such version",
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "a superseded item stays as itself, never copied into another's history; the history is capped",
  () =>
    Effect.gen(function* () {
      const memory = yield* fresh;
      const old = yield* memory.add({ kind: "preference", text: "He likes tabs", source: "user" });
      const newer = yield* memory.add({
        kind: "preference",
        text: "He likes spaces now",
        source: "user",
        supersedes: old.id,
      });
      assert.deepStrictEqual(yield* memory.history(newer.id), []);
      // Forget the replaced one: its words are nowhere, not in the keeper's history either.
      yield* memory.forget(old.id);
      for (let i = 0; i < MEMORY_VERSIONS_KEPT + 5; i += 1)
        yield* memory.edit(newer.id, { text: `He likes spaces, take ${i}` });
      const kept = yield* memory.history(newer.id);
      assert.strictEqual(kept.length, MEMORY_VERSIONS_KEPT);
      assert.isFalse(kept.some((v) => v.text.includes("tabs")));
      // The oldest went first: the newest kept is the wording before the last edit.
      assert.strictEqual(kept[0]!.text, `He likes spaces, take ${MEMORY_VERSIONS_KEPT + 3}`);
      // Forgotten means forgotten, history and all.
      yield* memory.forget(newer.id);
      assert.isTrue(
        (yield* Effect.flip(memory.history(newer.id))).reason.includes("no such memory"),
      );
    }).pipe(Effect.scoped),
);

it.effect("a sync that changes the words keeps the ones it replaced", () =>
  Effect.gen(function* () {
    const a = yield* fresh;
    const b = yield* fresh;
    const item = yield* a.add({ kind: "fact", text: "Invoices go out monthly", source: "user" });
    const sync = (from: typeof a, to: typeof a) =>
      Effect.gen(function* () {
        const hello = yield* to.syncHello;
        const pulled = yield* from.changesSince(hello.cursors[from.origin] ?? null);
        return yield* to.applyChanges(pulled.origin, pulled.changes, pulled.upTo);
      });
    yield* sync(a, b);
    // Later than the first write, as a real edit is: the newer one wins on the other server.
    yield* TestClock.adjust("1 minute");
    yield* a.edit(item.id, { text: "Invoices go out weekly" });
    yield* sync(a, b);
    const onB = yield* b.history(item.id);
    assert.deepStrictEqual(
      onB.map((v) => [v.text, v.by]),
      [["Invoices go out monthly", "sync"]],
    );
    // A change of kind alone is kept too.
    yield* TestClock.adjust("1 minute");
    yield* a.edit(item.id, { kind: "decision" });
    yield* sync(a, b);
    assert.strictEqual((yield* b.history(item.id))[0]?.kind, "fact");
  }).pipe(Effect.scoped, Effect.provideService(MemoryViewer, "server")),
);

it.effect("walls apply to history as to the item", () => {
  const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-history-walls-"));
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
    const memory = yield* TessayaMemoryService;
    const walled = yield* memory.add({
      kind: "fact",
      text: "The shop key rotates weekly",
      source: "user",
      scope: "project",
      scopeRef: "shop",
    });
    yield* memory.edit(walled.id, { text: "The shop key rotates daily" });
    assert.strictEqual((yield* memory.history(walled.id, { agent: "engineering" })).length, 1);
    assert.include(
      (yield* Effect.flip(memory.history(walled.id, { agent: "operations" }))).reason,
      "no such memory",
    );
    // A global item that supersedes the walled one carries none of its words into its own history.
    const global = yield* memory.add({
      kind: "fact",
      text: "Keys rotate on a schedule",
      source: "user",
      supersedes: walled.id,
    });
    const asClient = yield* memory
      .history(global.id)
      .pipe(Effect.provideService(MemoryViewer, "client"));
    assert.isFalse(asClient.some((v) => v.text.includes("shop key")));
    // An outside agent reads as a client: no persona, nothing walled.
    assert.include(
      (yield* Effect.flip(
        memory.history(walled.id).pipe(Effect.provideService(MemoryViewer, "client")),
      )).reason,
      "no such memory",
    );
  }).pipe(
    Effect.provideService(MemoryViewer, "desktop"),
    Effect.provide(
      Layer.mergeAll(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)), config),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(userdata, { recursive: true, force: true }))),
  );
});
