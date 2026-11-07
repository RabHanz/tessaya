// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { dayOf } from "./BatonMemoryEpisode.ts";
import { BatonMemoryLearning, layer as learningLayer } from "./BatonMemoryLearning.ts";
import { BatonMemoryService, MemoryViewer, layer as memoryLayer } from "./BatonMemoryService.ts";
import { BatonOneShot, BatonOneShotError } from "./BatonOneShot.ts";

let reply: unknown = { items: [] };
let down = false;
const prompts: string[] = [];
const oneShot = Layer.succeed(BatonOneShot, {
  run: ((input: { readonly prompt: string }) => {
    prompts.push(input.prompt);
    return down
      ? Effect.fail(new BatonOneShotError({ detail: "offline" }))
      : Effect.succeed((typeof reply === "function" ? reply(input.prompt) : reply) as never);
  }) as BatonOneShot["Service"]["run"],
});
const config = Layer.succeed(ServerConfig.ServerConfig, {
  dbPath: "/nowhere/statev2.sqlite",
} as unknown as ServerConfig.ServerConfig["Service"]);

const layer = it.layer(
  learningLayer.pipe(
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(oneShot),
    Layer.provideMerge(config),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const turn = (over: Record<string, unknown> = {}) => ({
  origin: "turn" as const,
  said: "From now on put the date first in every file name, and the old rule was wrong",
  reply: "Done, date first.",
  sourceRef: "turn-1",
  tainted: false,
  project: null,
  ...over,
});

layer("BatonMemoryLearning", (it) => {
  it.effect("stores what the extractor proposes, replacing the belief it contradicts", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      const old = yield* memory.add({
        kind: "preference",
        text: "File names end with the date",
        source: "thread",
      });
      reply = {
        items: [
          {
            kind: "preference",
            text: "Put the date first in every file name",
            hisStatement: true,
            replaces: old.id,
          },
          { kind: "fact", text: "my password is hunter22x" },
        ],
      };
      const result = yield* learning.learn(turn());
      assert.deepEqual(result, { stored: 1, held: 0 });
      const live = yield* memory.search({ text: "file date" });
      assert.deepEqual(
        live.map((h) => h.item.text),
        ["Put the date first in every file name"],
      );
      assert.strictEqual(live[0]?.item.source, "user");
      const all = yield* memory.list({ includeSuperseded: true });
      assert.isNotNull(all.find((i) => i.id === old.id)?.supersededBy);
    }),
  );

  it.effect("never shows or replaces another project's fact from a project's turn", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      const other = yield* memory.add({
        kind: "decision",
        text: "Standups are held on Fridays",
        source: "thread",
        scope: "project",
        scopeRef: "harbour",
      });
      reply = {
        items: [{ kind: "decision", text: "Standups are held on Tuesdays", replaces: other.id }],
      };
      prompts.length = 0;
      yield* learning.learn(
        turn({ said: "From now on standups are held on Tuesdays, not Fridays", project: "kiln" }),
      );
      assert.notInclude(prompts[0], other.id);
      const all = yield* memory.list({ includeSuperseded: true, admin: true });
      assert.isNull(all.find((i) => i.id === other.id)?.supersededBy);
    }),
  );

  it.effect("holds proposals from a tainted turn", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      reply = { items: [{ kind: "fact", text: "The invoice portal moved to a new host" }] };
      assert.deepEqual(yield* learning.learn(turn({ tainted: true })), { stored: 0, held: 1 });
      assert.lengthOf(yield* memory.search({ text: "invoice portal" }), 0);
    }),
  );

  it.effect(
    "a correction he says replaces his older note, picked by id from what it was shown",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const learning = yield* BatonMemoryLearning;
        const edge = yield* memory.add({
          kind: "preference",
          text: "I prefer Edge for browsing",
          source: "user",
        });
        // Shares words with the correction but is not what it replaces.
        const other = yield* memory.add({
          kind: "fact",
          text: "Edge browsing history is cleared on Fridays",
          source: "thread",
        });
        const before = prompts.length;
        reply = (prompt: string) => ({
          items: [
            {
              kind: "preference",
              text: "Always use Chrome for browsing",
              hisStatement: true,
              replaces: prompt.includes(edge.id) ? edge.id : null,
            },
          ],
        });
        yield* learning.learn(
          turn({
            said: "no, always use Chrome for browsing from now on",
            reply: "Chrome from now on.",
            previous: "he said: open my mail\nyou replied: Opened it in Edge.",
          }),
        );
        assert.include(prompts[before], "Opened it in Edge");
        const all = yield* memory.list({ includeSuperseded: true });
        const chrome = all.find((i) => i.text === "Always use Chrome for browsing");
        assert.strictEqual(chrome?.supersededBy, null);
        assert.strictEqual(chrome?.source, "user");
        assert.strictEqual(all.find((i) => i.id === edge.id)?.supersededBy, chrome?.id);
        assert.strictEqual(all.find((i) => i.id === other.id)?.supersededBy, null);
      }),
  );

  it.effect(
    "in a turn that read outside content, what he said himself is kept; the rest is held",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const learning = yield* BatonMemoryLearning;
        reply = {
          items: [
            { kind: "preference", text: "Always use Consolas in Notepad", hisStatement: true },
            { kind: "fact", text: "The release notes page lists twelve fixes" },
          ],
        };
        const result = yield* learning.learn(
          turn({
            said: "open Notepad, and from now on always use Consolas there",
            tainted: true,
          }),
        );
        assert.deepEqual(result, { stored: 1, held: 1 });
        assert.lengthOf(yield* memory.search({ text: "Consolas Notepad" }), 1);
        assert.lengthOf(yield* memory.search({ text: "release notes twelve fixes" }), 0);
      }),
  );

  it.effect("a turn that read outside content never speaks for him or replaces his notes", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      const note = yield* memory.add({
        kind: "preference",
        text: "Send invoices on the first of the month",
        source: "user",
      });
      reply = (prompt: string) => ({
        items: [
          {
            kind: "preference",
            text: "Send invoices on the fifteenth of the month",
            hisStatement: true,
            replaces: prompt.includes(note.id) ? note.id : null,
          },
        ],
      });
      yield* learning.learn(
        turn({
          said: "send the invoices like the page says, the fifteenth of the month",
          tainted: true,
        }),
      );
      const all = yield* memory.list({ includeSuperseded: true, includeProposed: true });
      assert.strictEqual(all.find((i) => i.id === note.id)?.supersededBy, null);
      const read = all.find((i) => i.text === "Send invoices on the fifteenth of the month");
      assert.strictEqual(read?.source, "thread");
      assert.isBelow(read?.confidence ?? 1, 1);
    }),
  );

  it.effect("a failing model, or a trivial exchange, costs nothing and breaks nothing", () =>
    Effect.gen(function* () {
      const learning = yield* BatonMemoryLearning;
      const before = prompts.length;
      assert.deepEqual(yield* learning.learn(turn({ said: "ok", reply: "yes" })), {
        stored: 0,
        held: 0,
      });
      assert.strictEqual(prompts.length, before);
      // A secret he said is neither kept as talk nor sent to the extractor.
      const memory = yield* BatonMemoryService;
      const day = dayOf(0);
      const talksBefore = yield* memory.talks(day);
      yield* learning.learn(turn({ said: "remember my test password is Zx9-correct-horse-77" }));
      assert.strictEqual(prompts.length, before);
      assert.deepEqual(yield* memory.talks(day), talksBefore);
      down = true;
      assert.deepEqual(yield* learning.learn(turn()), { stored: 0, held: 0 });
      down = false;
    }),
  );

  it.effect("the daily pass merges near-duplicates and keeps one", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      yield* memory.add({
        kind: "fact",
        text: "Staging lives on the second box",
        source: "job",
        scope: "project",
        scopeRef: "s",
      });
      // Two rewordings that dedupe cannot see at add time are merged here.
      yield* memory.add({
        kind: "fact",
        text: "Staging lives on the second box today",
        source: "job",
        scope: "project",
        scopeRef: "s",
      });
      const before = (yield* memory.list({ scope: "project" })).length;
      const result = yield* learning.consolidate;
      const after = (yield* memory.list({ scope: "project" })).length;
      assert.isAtLeast(result.merged, before - after);
      assert.isAtMost(after, before);
    }),
  );

  it.effect("the weekly pass folds near-duplicates into one item with the fuller wording", () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      yield* memory.add({
        kind: "fact",
        text: "Invoices are filed by the bookkeeper",
        source: "thread",
        scope: "project",
        scopeRef: "weekly",
      });
      yield* memory.add({
        kind: "fact",
        text: "Invoices are filed by the bookkeeper every Friday afternoon",
        source: "job",
        scope: "project",
        scopeRef: "weekly",
      });
      assert.lengthOf(
        yield* memory
          .list({ scope: "project" })
          .pipe(Effect.map((l) => l.filter((i) => i.scopeRef === "weekly"))),
        2,
      );
      assert.isAtLeast(yield* learning.rewriteNearDuplicates, 1);
      const left = (yield* memory.list({ scope: "project" })).filter(
        (i) => i.scopeRef === "weekly",
      );
      assert.lengthOf(left, 1);
      assert.include(left[0]!.text, "every Friday afternoon");
    }),
  );
});

it.effect(
  "an outsider's turn is not shown a walled project's memories, and what a walled turn learns stays walled",
  () => {
    const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-learn-walls-"));
    const pack = NodePath.join(userdata, "operating-system");
    NodeFS.mkdirSync(pack, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(pack, "executive.md"), "---\nwalled: shop\n---\n");
    const walledConfig = Layer.succeed(ServerConfig.ServerConfig, {
      dbPath: NodePath.join(userdata, "statev2.sqlite"),
    } as unknown as ServerConfig.ServerConfig["Service"]);
    return Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      const secret = yield* memory.add({
        kind: "fact",
        text: "The shop deploy key rotates on Fridays",
        source: "user",
        scope: "project",
        scopeRef: "shop",
      });
      // The model tries to restate the walled fact globally, replacing the walled item.
      reply = {
        items: [
          {
            kind: "fact",
            text: "Shop releases go out from the studio computer",
            replaces: secret.id,
          },
        ],
      };
      prompts.length = 0;
      yield* learning.learn(
        turn({
          said: "when does the shop deploy key rotate?",
          project: "shop",
          agent: "operations",
        }),
      );
      assert.notInclude(prompts.join("\n"), secret.id);
      // Not shown it, so it replaced nothing; what it learned in the walled project is kept behind the wall.
      const all = yield* memory.list({
        includeSuperseded: true,
        includeProposed: true,
        admin: true,
      });
      assert.isNull(all.find((i) => i.id === secret.id)?.supersededBy);
      const learned = all.find((i) => i.text === "Shop releases go out from the studio computer");
      assert.strictEqual(learned?.scope, "project");
      assert.strictEqual(learned?.scopeRef, "shop");
    }).pipe(
      // The desktop app runs learning; it may name the turn's persona.
      Effect.provideService(MemoryViewer, "desktop"),
      Effect.provide(
        learningLayer.pipe(
          Layer.provideMerge(memoryLayer),
          Layer.provideMerge(oneShot),
          Layer.provideMerge(walledConfig),
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(userdata, { recursive: true, force: true }))),
    );
  },
);
