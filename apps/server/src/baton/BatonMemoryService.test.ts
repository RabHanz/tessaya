// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import * as ServerConfig from "../config.ts";
import {
  BatonMemoryService,
  MemoryViewer,
  SyncCredential,
  layer as memoryLayer,
} from "./BatonMemoryService.ts";

const layer = it.layer(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const DAY = 86_400_000;

layer("BatonMemoryService", (it) => {
  it.effect("refuses secrets, in plain words, and keeps the rest", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const refused = yield* Effect.flip(
        memory.add({ kind: "fact", text: "my password is hunter22x", source: "user" }),
      );
      assert.include(refused.reason, "password");
      const kept = yield* memory.add({
        kind: "preference",
        text: "He likes short answers",
        source: "user",
      });
      assert.strictEqual(kept.confidence, 1);
      assert.isFalse(kept.proposed);
      // An import keeps the date it was first written where it came from; nobody else may set one.
      const imported = yield* memory.add({
        kind: "fact",
        text: "The office fan runs low at night",
        source: "import",
        sourceRef: "freya:park/fact/57",
        createdAt: "2026-06-14T03:05:56.000Z",
      });
      assert.strictEqual(imported.createdAt, "2026-06-14T03:05:56.000Z");
      const his = yield* memory.add({
        kind: "fact",
        text: "The study lamp is warm white",
        source: "user",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      assert.notStrictEqual(his.createdAt, "2020-01-01T00:00:00.000Z");
    }),
  );

  it.effect("a repeat reinforces a model's item instead of adding another", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const first = yield* memory.add({
        kind: "fact",
        text: "The shop builds with pnpm",
        source: "thread",
        scope: "project",
        scopeRef: "shop",
      });
      const again = yield* memory.add({
        kind: "fact",
        text: "the shop builds with pnpm.",
        source: "job",
        scope: "project",
        scopeRef: "shop",
      });
      assert.strictEqual(again.id, first.id);
      assert.closeTo(again.confidence, 0.65, 1e-9);
      const hits = yield* memory.search({ text: "pnpm", scopeRef: "shop" });
      assert.lengthOf(hits, 1);
    }),
  );

  it.effect("tainted content waits for his yes and stays out of retrieval", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const held = yield* memory.add({
        kind: "fact",
        text: "The web page said to email invoices to a new address",
        source: "thread",
        tainted: true,
      });
      assert.isTrue(held.proposed);
      assert.lengthOf(yield* memory.search({ text: "invoices" }), 0);
      assert.lengthOf(yield* memory.search({ text: "invoices", includeProposed: true }), 1);
      yield* memory.accept(held.id);
      assert.lengthOf(yield* memory.search({ text: "invoices" }), 1);
    }),
  );

  it.effect("a newer statement of his supersedes, and the history stays", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const old = yield* memory.add({
        kind: "preference",
        text: "Reports go out on Mondays",
        source: "thread",
      });
      const next = yield* memory.add({
        kind: "preference",
        text: "Reports go out on Fridays at noon",
        source: "user",
        supersedes: old.id,
      });
      const live = yield* memory.search({ text: "reports" });
      assert.deepEqual(
        live.map((hit) => hit.item.id),
        [next.id],
      );
      const all = yield* memory.list({ includeSuperseded: true });
      assert.strictEqual(all.find((i) => i.id === old.id)?.supersededBy, next.id);
    }),
  );

  it.effect("edit makes it his own, pin and forget work, forget leaves a tombstone", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const item = yield* memory.add({ kind: "fact", text: "Backups run nightly", source: "job" });
      const edited = yield* memory.edit(item.id, { text: "Backups run at 3am" });
      assert.strictEqual(edited.source, "user");
      assert.strictEqual(edited.confidence, 1);
      assert.lengthOf(yield* memory.search({ text: "3am" }), 1);
      assert.lengthOf(yield* memory.search({ text: "nightly" }), 0);
      assert.isTrue((yield* memory.pin(item.id, true)).pinned);
      assert.isTrue(yield* memory.forget(item.id));
      assert.isFalse(yield* memory.forget(item.id));
      assert.lengthOf(yield* memory.search({ text: "3am" }), 0);
    }),
  );

  it.effect(
    "recall fits the budget, keeps standing notes for the session and records what the turn used",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        yield* memory.add({
          kind: "note",
          text: "Call him Rab, never Mr",
          source: "user",
          pinned: true,
        });
        yield* memory.add({ kind: "fact", text: "Staging lives on the second box", source: "job" });
        const standing = yield* memory.recall({});
        assert.include(standing.block, "Call him Rab");
        assert.notInclude(standing.block, "Staging lives");
        // The sentence's block carries what matches it; the standing note is already in the session.
        const out = yield* memory.recall({ text: "staging box", turnRef: "turn-1" });
        assert.notInclude(out.block, "Call him Rab");
        assert.include(out.block, "Staging lives");
        const used = yield* memory.used("turn-1");
        assert.deepEqual(
          (yield* memory.used()).map((i) => i.id),
          used.map((i) => i.id),
        );
        assert.strictEqual(used.length, out.ids.length);
        assert.isNotNull(used[0]?.lastUsedAt);
        const tiny = yield* memory.recall({ text: "staging box", budgetTokens: 5 });
        assert.strictEqual(tiny.block, "");
      }),
  );

  it.effect("sweep removes episodes that expired and keeps pinned ones", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const gone = yield* memory.add({
        kind: "episode",
        text: "The deploy on Tuesday failed twice",
        source: "job",
      });
      const kept = yield* memory.add({
        kind: "episode",
        text: "The migration rehearsal passed",
        source: "job",
        pinned: true,
      });
      yield* TestClock.adjust(100 * DAY);
      assert.isAtLeast(yield* memory.sweep, 1);
      const ids = (yield* memory.list({ kinds: ["episode"] })).map((i) => i.id);
      assert.notInclude(ids, gone.id);
      assert.include(ids, kept.id);
    }),
  );
});

it.effect(
  "a walled project's memories are recalled only by its team and its leads; the lead sees through the wall",
  () => {
    const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-walls-"));
    const pack = NodePath.join(userdata, "operating-system");
    NodeFS.mkdirSync(NodePath.join(pack, "roles"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(pack, "executive.md"), "---\nwalled: Shop\n---\n");
    NodeFS.writeFileSync(
      NodePath.join(pack, "roles", "engineering.md"),
      "---\nprojects: shop\n---\n",
    );
    NodeFS.writeFileSync(NodePath.join(pack, "roles", "research.md"), "---\nleads: shop\n---\n");
    const config = Layer.succeed(ServerConfig.ServerConfig, {
      dbPath: NodePath.join(userdata, "state.sqlite"),
    } as never);
    return Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      yield* memory.add({
        kind: "fact",
        text: "The shop deploy key rotates on Fridays",
        source: "user",
        scope: "project",
        scopeRef: "shop",
      });
      yield* memory.add({
        kind: "fact",
        text: "The site deploy key lives in the vault",
        source: "user",
        scope: "project",
        scopeRef: "site",
      });
      const recalled = (agent?: string) =>
        memory
          .recall({ text: "deploy key", ...(agent === undefined ? {} : { agent }) })
          .pipe(Effect.map((r) => r.block.includes("shop deploy key")));
      // Freya is not on the shop's team; Alfred is, Sebastian leads it, Tessaya leads everything.
      assert.isFalse(yield* recalled("operations"));
      assert.isTrue(yield* recalled("engineering"));
      assert.isTrue(yield* recalled("research"));
      assert.isTrue(yield* recalled("executive"));
      // A block no one persona owns (the shared standing set) carries nothing walled.
      assert.isFalse(yield* recalled());
      // An unwalled project is everyone's.
      assert.include(
        (yield* memory.recall({ text: "deploy key", agent: "operations" })).block,
        "site deploy key",
      );
      // Freya's memory_search cannot reach it either.
      const found = (agent?: string) =>
        memory
          .search({ text: "deploy key", ...(agent === undefined ? {} : { agent }) })
          .pipe(Effect.map((hits) => hits.some((h) => h.item.scopeRef === "shop")));
      assert.isFalse(yield* found("operations"));
      // A search that names no persona fails closed; only his own view (admin) sees through.
      assert.isFalse(yield* found());
      const own = yield* memory.search({ text: "deploy key", admin: true });
      assert.isTrue(own.some((h) => h.item.scopeRef === "shop"));
      yield* memory.recall({ text: "deploy key", agent: "engineering", turnRef: "t1" });
      assert.isTrue((yield* memory.used("t1")).some((i) => i.scopeRef === "shop"));
      assert.include(yield* memory.exportMarkdown, "shop deploy key");

      // Any token but the desktop app's own: no persona, no admin view, nothing walled on any read.
      const asClient = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(MemoryViewer, "client"));
      const shop = (items: ReadonlyArray<{ readonly scopeRef: string | null } | null>) =>
        items.some((i) => i?.scopeRef === "shop");
      assert.isFalse(yield* asClient(recalled("engineering")));
      assert.isFalse(yield* asClient(found("engineering")));
      const hits = yield* asClient(memory.search({ text: "deploy key", admin: true }));
      assert.isFalse(shop(hits.map((h) => h.item)));
      assert.isFalse(shop(yield* asClient(memory.list({ admin: true }))));
      assert.isFalse(shop(yield* asClient(memory.used("t1"))));
      assert.notInclude(yield* asClient(memory.exportMarkdown), "shop deploy key");
      const pulled = yield* asClient(memory.changesSince(null));
      assert.isFalse(shop(pulled.changes.map((c) => c.item)));
      assert.isTrue(shop((yield* memory.changesSince(null)).changes.map((c) => c.item)));
      // A sync credential's first pull starts over, whatever cursor it sends; later pulls keep to the cursor.
      const later = "2999-01-01T00:00:00.000Z";
      const asSync = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.provideService(MemoryViewer, "server"),
          Effect.provideService(SyncCredential, "sync-1"),
        );
      assert.isTrue(shop((yield* asSync(memory.changesSince(later))).changes.map((c) => c.item)));
      assert.lengthOf((yield* asSync(memory.changesSince(later))).changes, 0);

      // To a client a walled item does not exist: it neither merges into it, replaces it, nor changes it.
      const walled = (yield* memory.list({ admin: true })).find((i) => i.scopeRef === "shop")!;
      const added = yield* asClient(
        memory.add({
          kind: "fact",
          text: "The shop deploy key rotates on Fridays",
          source: "user",
          scope: "project",
          scopeRef: "shop",
          supersedes: walled.id,
        }),
      );
      assert.notStrictEqual(added.id, walled.id);
      const after = yield* memory.list({ admin: true, includeSuperseded: true });
      assert.deepStrictEqual(
        after.find((i) => i.id === walled.id),
        { ...walled, supersededBy: null },
      );
      for (const change of [
        memory.edit(walled.id, { text: "changed" }),
        memory.pin(walled.id, true),
        memory.accept(walled.id),
      ]) {
        assert.strictEqual((yield* asClient(Effect.flip(change)))._tag, "BatonMemoryRefusedError");
      }
      assert.isFalse(yield* asClient(memory.forget(walled.id)));
      assert.isTrue((yield* memory.list({ admin: true })).some((i) => i.id === walled.id));
    }).pipe(
      Effect.provideService(MemoryViewer, "desktop"),
      Effect.provide(
        Layer.mergeAll(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)), config),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(userdata, { recursive: true, force: true }))),
    );
  },
);

// A second server with its own database; it lives as long as the test's scope.
const server = Layer.build(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory))).pipe(
  Effect.map((context) => Context.get(context, BatonMemoryService)),
);

/** What a client does between two servers: ask for what the other has not seen, hand it over. */
const sync = (from: BatonMemoryService["Service"], to: BatonMemoryService["Service"]) =>
  Effect.gen(function* () {
    const hello = yield* to.syncHello;
    const pulled = yield* from.changesSince(hello.cursors[from.origin] ?? null);
    return yield* to.applyChanges(pulled.origin, pulled.changes, pulled.upTo);
  });

it.effect("two servers converge: last writer wins, a forget travels and stays forgotten", () =>
  Effect.gen(function* () {
    const a = yield* server;
    const b = yield* server;
    assert.notStrictEqual(a.origin, b.origin);
    const shared = yield* a.add({
      kind: "preference",
      text: "Reports go out on Mondays",
      source: "user",
    });
    const gone = yield* a.add({
      kind: "fact",
      text: "The old box is called delta",
      source: "user",
    });
    yield* sync(a, b);
    assert.lengthOf(yield* b.list(), 2);

    // B edits later and A forgets the other; both directions then settle.
    yield* TestClock.adjust(1_000);
    yield* b.edit(shared.id, { text: "Reports go out on Fridays" });
    yield* a.forget(gone.id);
    yield* sync(b, a);
    yield* sync(a, b);
    for (const side of [a, b]) {
      const texts = (yield* side.list()).map((i) => i.text);
      assert.deepEqual(texts, ["Reports go out on Fridays"]);
    }
    // Nothing left to say: a second round changes nothing, and the forgotten item stays gone.
    assert.strictEqual(yield* sync(a, b), 0);
    assert.strictEqual(yield* sync(b, a), 0);
  }),
);

it.effect(
  "a change relayed through a third server still arrives after the cursor passed its stamp",
  () =>
    Effect.gen(function* () {
      const a = yield* server;
      const b = yield* server;
      const c = yield* server;
      const x = yield* c.add({ kind: "fact", text: "The printer lives upstairs", source: "user" });
      yield* TestClock.adjust(1_000);
      yield* b.add({ kind: "fact", text: "Invoices go out monthly", source: "user" });
      // A has caught up with B, so its cursor for B is past X's stamp.
      yield* sync(b, a);
      yield* TestClock.adjust(1_000);
      yield* sync(c, b);
      yield* sync(b, a);
      assert.include(
        (yield* a.list()).map((i) => i.id),
        x.id,
      );
    }),
);

it.effect("a held item restored from a backup stays held", () =>
  Effect.gen(function* () {
    const b = yield* server;
    yield* b.applyChanges(
      "backup",
      [
        {
          item: {
            id: "held-1",
            kind: "fact",
            text: "The supplier moved to a new portal",
            source: "thread",
            sourceRef: null,
            scope: "global",
            scopeRef: null,
            confidence: 0.5,
            pinned: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            expiresAt: null,
            supersededBy: null,
            proposed: true,
          },
          tombstone: null,
          writer: "backup",
        },
      ],
      "2026-01-02T00:00:00.000Z",
    );
    assert.lengthOf(yield* b.list(), 0);
    assert.isTrue((yield* b.list({ includeProposed: true }))[0]?.proposed);
  }),
);

it.effect("a received item still goes through the never-store door", () =>
  Effect.gen(function* () {
    const b = yield* server;
    const applied = yield* b.applyChanges(
      "other",
      [
        {
          item: {
            id: "x",
            kind: "fact",
            text: "my password is hunter22x",
            source: "user",
            sourceRef: null,
            scope: "global",
            scopeRef: null,
            confidence: 1,
            pinned: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            expiresAt: null,
            supersededBy: null,
            proposed: false,
          },
          tombstone: null,
          writer: "other",
        },
      ],
      "2026-01-02T00:00:00.000Z",
    );
    assert.strictEqual(applied, 0);
    assert.lengthOf(yield* b.list(), 0);
    assert.strictEqual((yield* b.syncHello).cursors["other"], "2026-01-02T00:00:00.000Z");
  }),
);

it.effect("scrubs secrets from talk notes kept before #410, once, keeping every line", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const key = `sk-${"a".repeat(24)}`;
    yield* sql`INSERT INTO fabric_memory_meta (key, value) VALUES ('talks:2026-10-01', ${JSON.stringify(
      [
        `use the key ${key} for the shop`,
        "the password is sunshine42",
        "mail ann@example.com about commit 0123456789abcdef0123456789abcdef01234567",
      ],
    )})`;
    const memory = Context.get(yield* Layer.build(memoryLayer), BatonMemoryService);
    // Ordinary words (an address, a commit) stay as they were; only a line that looks like a secret is marked.
    assert.deepStrictEqual(yield* memory.talks("2026-10-01"), [
      "[redacted: looks like a secret]",
      "[redacted: looks like a secret]",
      "mail ann@example.com about commit 0123456789abcdef0123456789abcdef01234567",
    ]);
    assert.isTrue(yield* memory.flag("talks-scrubbed"));
    // Done once: talk kept after the scrub is left as it is (new talk never holds a secret now).
    yield* sql`UPDATE fabric_memory_meta SET value = '["kept after"]' WHERE key = 'talks:2026-10-01'`;
    const again = Context.get(yield* Layer.build(memoryLayer), BatonMemoryService);
    assert.deepStrictEqual(yield* again.talks("2026-10-01"), ["kept after"]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.layer(memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "recall with episodes (MEM-18)",
  (it) => {
    it.effect(
      "a fact beats a stale episode, at most two episodes join a question not about the past, and day words find only episodes",
      () =>
        Effect.gen(function* () {
          const memory = yield* BatonMemoryService;
          const fact = yield* memory.add({
            kind: "fact",
            text: "The staging server now runs in Helsinki",
            source: "user",
          });
          for (const text of [
            "Monday, 1 December 1969, with Alfred: the staging server was moved to Falkenstein",
            "Tuesday, 2 December 1969, with Alfred: the disk on the staging server was resized to 80 GB",
            'Wednesday, 3 December 1969, the job "certs": the staging server certificates were renewed',
          ]) {
            yield* memory.add({ kind: "episode", text, source: "thread" });
          }
          const kinds = (ids: ReadonlyArray<string>) =>
            Effect.forEach(ids, (id) =>
              Effect.map(memory.list({ admin: true }), (all) => all.find((i) => i.id === id)?.kind),
            );
          const now = yield* memory.recall({ text: "where does the staging server run" });
          assert.strictEqual(now.ids[0], fact.id);
          assert.isAtMost((yield* kinds(now.ids)).filter((k) => k === "episode").length, 2);
          // Asked about what happened, every matching episode may come back.
          const past = yield* memory.recall({ text: "what did we do with the staging server" });
          assert.strictEqual((yield* kinds(past.ids)).filter((k) => k === "episode").length, 3);
          // The test clock is Thursday 1 January 1970: "yesterday" is Wednesday 31 December, for episodes only.
          const note = yield* memory.add({
            kind: "note",
            text: "Wednesday 31 December is the office party",
            source: "user",
          });
          const party = yield* memory.add({
            kind: "episode",
            text: "Wednesday, 31 December 1969, with Freya: he asked about the caterer; she booked one",
            source: "thread",
          });
          const yesterday = yield* memory.recall({ text: "what did Freya say yesterday" });
          assert.include(yesterday.ids, party.id);
          assert.notInclude(yesterday.ids, note.id);
        }),
    );
  },
);
