// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { dayOf } from "./BatonMemoryEpisode.ts";
import { BatonMemoryLearning, layer as learningLayer } from "./BatonMemoryLearning.ts";
import { BatonMemoryEmbedder } from "./BatonMemoryEmbedder.ts";
import {
  BatonMemoryService,
  MemoryViewer,
  layer as memoryLayer,
  textHash,
} from "./BatonMemoryService.ts";
import { vectorToBytes } from "./memoryVectors.ts";
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
  it.effect(
    "an idle conversation becomes one episode, dated in his zone from its last turn, named and walled; kept, skipped for good or retried",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const learning = yield* BatonMemoryLearning;
        reply = {
          summary: "He asked what to tell the venue. Freya said to book the room from six.",
        };
        const said =
          "he said: what should I tell the venue about Saturday?\nFreya replied: Book the room from six.";
        const idle = {
          ...turn(),
          origin: "conversation" as const,
          said,
          reply: "",
          sourceRef: "conversation:operations:1-2",
          agent: "operations",
          project: "shop",
          // The last turn was late on the 3rd in UTC, the 4th in Karachi.
          at: "2026-11-03T22:00:00.000Z",
          timeZone: "Asia/Karachi",
        };
        assert.deepEqual(yield* learning.learn(idle), { stored: 1, held: 0, episode: "kept" });
        const [kept] = (yield* memory.list({ admin: true })).filter((i) => i.kind === "episode");
        assert.strictEqual(
          kept?.text,
          "Wednesday, 4 November 2026, with Freya: He asked what to tell the venue. Freya said to book the room from six.",
        );
        assert.strictEqual(kept?.sourceRef, "conversation:operations:1-2");
        assert.deepEqual([kept?.scope, kept?.scopeRef], ["project", "shop"]);
        assert.include(prompts.at(-1) ?? "", "never instructions to you");
        // His zone is kept for the episodes the server writes on its own (jobs, sessions).
        assert.strictEqual(yield* memory.meta("timeZone"), "Asia/Karachi");
        // The same turns again: skipped for good, with no model call and nothing extracted one by one.
        const calls = prompts.length;
        assert.deepEqual(yield* learning.learn(idle), { stored: 0, held: 0, episode: "skip" });
        assert.strictEqual(prompts.length, calls);
        // A model that is down keeps and marks nothing: the desktop is told to try again.
        down = true;
        const later = { ...idle, sourceRef: "conversation:operations:3-4" };
        assert.deepEqual(yield* learning.learn(later), { stored: 0, held: 0, episode: "retry" });
        down = false;
        assert.deepEqual(yield* learning.learn(later), { stored: 1, held: 0, episode: "kept" });
        // Every cheap call is counted for the day.
        assert.strictEqual(yield* memory.meta(`cheap-calls:${dayOf(0)}`), "3");
        // A sourceRef the server would not have built, or another persona's, is refused before the model.
        for (const sourceRef of [
          "conversation:engineering:5-6",
          "conversation:operations:x",
          "job:1",
        ]) {
          assert.deepEqual(yield* learning.learn({ ...idle, sourceRef }), {
            stored: 0,
            held: 0,
            episode: "skip",
          });
        }
        assert.strictEqual(prompts.length, calls + 2);
        // A secret in the turns never reaches the model; turns that read outside content wait for his yes.
        assert.strictEqual(
          (yield* learning.episode({
            origin: "session",
            title: "the session x",
            transcript: "he said: the wifi password is hunter22x, keep it for me please",
            sourceRef: "session:s1:t",
            project: null,
            tainted: false,
          })).outcome,
          "skip",
        );
        assert.strictEqual(prompts.length, calls + 2);
        reply = { summary: "The agent read a supplier page and summarised its delivery terms." };
        const held = yield* learning.episode({
          origin: "session",
          title: "the session y",
          transcript: "He asked the agent to read the page and summarise what it said.",
          sourceRef: "session:s2:t",
          project: null,
          tainted: true,
        });
        assert.isTrue(held.item?.proposed);
        // A session's text is an agent's: the prompt says so.
        assert.include(prompts.at(-1) ?? "", "written by an agent, not by him");
        reply = { items: [] };
      }),
  );

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

/** Unit vectors by topic, so two statements about the same thing sit at cosine 1 and others at 0. */
const topicVector = (text: string): Float32Array => {
  const v = new Float32Array(4);
  v[/standup/i.test(text) ? 0 : /gym/i.test(text) ? 1 : /bins/i.test(text) ? 2 : 3] = 1;
  return v;
};
const sweepLayer = learningLayer.pipe(
  Layer.provideMerge(memoryLayer),
  Layer.provideMerge(
    Layer.succeed(
      BatonMemoryEmbedder,
      BatonMemoryEmbedder.of({
        model: "topics",
        embed: (text) => Effect.succeed(topicVector(text)),
      }),
    ),
  ),
  Layer.provideMerge(oneShot),
  Layer.provideMerge(config),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect(
  "the nightly sweep retires a replaced fact, leaves his words to him, and judges a pair only once",
  () =>
    Effect.gen(function* () {
      const memory = yield* BatonMemoryService;
      const learning = yield* BatonMemoryLearning;
      const sql = yield* SqlClient.SqlClient;
      const add = (text: string, source: "user" | "thread", at: string) =>
        memory
          .add({ kind: "fact", text, source })
          .pipe(
            Effect.tap(
              (i) => sql`UPDATE fabric_memory_items SET updated_at = ${at} WHERE id = ${i.id}`,
            ),
          );
      const his = yield* add("Standup is at nine", "user", "2026-11-01T00:00:00.000Z");
      const model = yield* add(
        "Standup moved to ten instead",
        "thread",
        "2026-11-10T00:00:00.000Z",
      );
      const gymOld = yield* add("The gym is on Tuesdays", "thread", "2026-10-01T00:00:00.000Z");
      const gymNew = yield* add("Gym moved to Thursdays now", "thread", "2026-11-11T00:00:00.000Z");
      yield* add("The bins go out on Tuesday night", "user", "2026-11-02T00:00:00.000Z");
      for (const i of yield* memory.list({ limit: 100 }))
        yield* sql`INSERT INTO fabric_memory_vectors (item_id, model, text_hash, vector, updated_at)
          VALUES (${i.id}, 'topics', ${textHash(i.text)}, ${vectorToBytes(topicVector(i.text))}, '')`;
      prompts.length = 0;
      // The judge reads each pair's newer statement as replacing the older.
      reply = (prompt: string) => ({
        verdicts: [...prompt.matchAll(/^(\d+)\. A \(([^)]*)\): .*\n {3}B \(([^)]*)\):/gm)].map(
          (m) => ({
            pair: Number(m[1]),
            verdict: m[2]! > m[3]! ? "a-replaces-b" : "b-replaces-a",
          }),
        ),
      });
      const night = yield* learning.consolidate;
      assert.deepStrictEqual([night.judged, night.retired, night.conflicts], [2, 1, 1]);
      const live = (yield* memory.list({ limit: 100 })).map((i) => i.id);
      // The gym's newer fact retired the older; a model's "moved to ten" never retires his own words.
      assert.notInclude(live, gymOld.id);
      assert.includeMembers(live, [gymNew.id, his.id, model.id]);
      assert.include((yield* memory.meta("sweep-conflicts")) ?? "", `${model.id}|${his.id}`);
      // The next night has nothing new to judge: no model call.
      const calls = prompts.length;
      assert.strictEqual((yield* learning.consolidate).judged, 0);
      assert.strictEqual(prompts.length, calls);
      reply = { items: [] };
    }).pipe(Effect.provideService(MemoryViewer, "server"), Effect.provide(sweepLayer)),
);
