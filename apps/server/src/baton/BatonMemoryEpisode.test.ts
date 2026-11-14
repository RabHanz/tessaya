import { assert, it } from "@effect/vitest";
import { ProjectId, WorkSessionId } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonJobService, layer as jobLayer } from "./BatonJobService.ts";
import { dailyEpisode, personaDayEpisodes } from "./BatonMemoryEpisode.ts";
import { layer as learningLayer } from "./BatonMemoryLearning.ts";
import { episodeFromSession } from "./BatonMemoryReactor.ts";
import { BatonMemoryService, MemoryViewer, layer as memoryLayer } from "./BatonMemoryService.ts";
import { BatonOneShot } from "./BatonOneShot.ts";
import { WorkSessionService, layer as workSessionLayer } from "./WorkSessionService.ts";

const layer = it.layer(
  memoryLayer.pipe(
    Layer.provideMerge(jobLayer),
    Layer.provideMerge(workSessionLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("dailyEpisode", (it) => {
  it.effect(
    "sums up yesterday's talks, jobs and sessions as one episode, once, and nothing on a quiet day",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const DAY = 86_400_000;
        assert.isNull(yield* dailyEpisode(DAY));
        // A tick that finds nothing yet does not mark the day as done.
        assert.isNull(yield* dailyEpisode(2 * DAY + 3_600_000));
        yield* memory.noteTalk("1970-01-02", "plan the shop launch");
        yield* (yield* BatonJobService).create({
          id: WorkSessionId.make("job-1"),
          projectId: ProjectId.make("p"),
          title: "Site",
          goal: "Rebuild the site",
          permissions: { folders: [], projects: [], tools: ["read"] },
        });
        yield* (yield* WorkSessionService).applySynopsis({
          workSessionId: WorkSessionId.make("job-1"),
          signals: [
            {
              kind: "written",
              at: "1970-01-02T15:00:00.000Z",
              currentAction: "The header is rebuilt and the tests pass",
              next: "Ship it",
            },
          ],
        });
        // Run at 09:00 on the 3rd: the whole of the 2nd, not the morning's first ten minutes.
        const episode = yield* dailyEpisode(2 * DAY + 9 * 3_600_000);
        assert.strictEqual(episode?.kind, "episode");
        assert.include(episode?.text ?? "", "1970-01-02");
        assert.include(episode?.text ?? "", "plan the shop launch");
        assert.include(episode?.text ?? "", "Site: The header is rebuilt");
        assert.isNotNull(episode?.expiresAt);
        // A restart the same day writes no second episode for the 2nd.
        assert.isNull(yield* dailyEpisode(2 * DAY + 10 * 3_600_000));
      }),
  );
});

layer("personaDayEpisodes (CS7)", (it) => {
  it.effect(
    "one episode per persona's day, counting every conversation but quoting none walled or private",
    () =>
      Effect.gen(function* () {
        const memory = yield* BatonMemoryService;
        const DAY = 86_400_000;
        const said = (persona: string, n: number, text: string, extra = {}) =>
          memory.add({
            kind: "episode",
            text: `Thursday, 1 January 1970, with Freya: ${text}`,
            source: "thread",
            sourceRef: `conversation:${persona}:${n}-${n + 1}`,
            ...extra,
          });
        yield* said("companion", 1, "He planned a ten kilometre run for Saturday morning");
        yield* said("companion", 3, "They chose a quieter bedtime playlist for the week");
        yield* said("companion", 5, "The merger numbers for the walled client deal", {
          scope: "project",
          scopeRef: "acme",
        });
        yield* said("companion", 7, "Sara told her about the surprise party plans", {
          persona: "companion",
          visibility: "persona",
          speaker: "sara",
        });
        // One conversation is already its own episode: no day for it.
        yield* said("research", 1, "Three sources on standing desks were compared");

        const [day, ...rest] = yield* personaDayEpisodes(DAY + 9 * 3_600_000);
        assert.lengthOf(rest, 0);
        assert.strictEqual(day?.persona, "companion");
        assert.strictEqual(day?.text.slice(0, 41), "1970-01-01, Freya's day: 4 conversations.");
        assert.include(day?.text ?? "", "ten kilometre run");
        assert.include(day?.text ?? "", "bedtime playlist");
        // Leak test: nothing of a walled or private conversation reaches a line every reader may recall.
        for (const word of ["merger", "acme", "Sara", "surprise"])
          assert.notInclude(day?.text ?? "", word);
        assert.strictEqual(day?.visibility, "household");
        // A member's or guest's view (the client's) reads the day, and it is the same safe line.
        const seen = yield* memory.list({ kinds: ["episode"] });
        assert.strictEqual(seen.find((e) => e.id === day?.id)?.text, day?.text);
        assert.isUndefined(seen.find((e) => e.text.includes("surprise")));
        // Once a day, even after a restart.
        assert.lengthOf(yield* personaDayEpisodes(DAY + 10 * 3_600_000), 0);
      }).pipe(Effect.provideService(MemoryViewer, "client")),
  );
});

let summary = "The scheduler refactor replaced the cron parser and ended settled.";
const sessionPrompts: string[] = [];
const sessionLayer = it.layer(
  learningLayer.pipe(
    Layer.provideMerge(memoryLayer),
    Layer.provideMerge(jobLayer),
    Layer.provideMerge(workSessionLayer),
    Layer.provideMerge(
      Layer.succeed(BatonOneShot, {
        run: ((input: { readonly prompt: string }) => (
          sessionPrompts.push(input.prompt),
          Effect.succeed({ summary } as never)
        )) as BatonOneShot["Service"]["run"],
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerConfig.ServerConfig, {
        dbPath: "/nowhere/statev2.sqlite",
      } as unknown as ServerConfig.ServerConfig["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(BatonEngine, {
        recentMessages: () => Effect.succeed([]),
        projects: Effect.succeed([{ id: "p", title: "shop" }]),
      } as unknown as BatonEngine["Service"]),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

sessionLayer("a work session's end (MEM-18)", (it) => {
  it.effect(
    "writes one episode when a session settles, none while active, and leaves a job to its own",
    () =>
      Effect.gen(function* () {
        const sessions = yield* WorkSessionService;
        const id = WorkSessionId.make("s-1");
        const active = yield* sessions.create({
          id,
          projectId: ProjectId.make("p"),
          title: "Scheduler refactor",
        });
        assert.isNull(yield* episodeFromSession(active));
        const settled = yield* sessions.settle({ id });
        const episode = (yield* episodeFromSession(settled))?.item;
        assert.strictEqual(episode?.kind, "episode");
        assert.include(
          episode?.text ?? "",
          'the session "Scheduler refactor": The scheduler refactor',
        );
        // Behind its project's wall, like any item learned there; the agent's words are framed as someone else's.
        assert.deepEqual([episode?.scope, episode?.scopeRef], ["project", "shop"]);
        assert.include(sessionPrompts.at(-1) ?? "", "written by an agent, not by him");
        // The same end again writes nothing.
        assert.strictEqual((yield* episodeFromSession(settled))?.outcome, "skip");
        yield* (yield* BatonJobService).create({
          id: WorkSessionId.make("job-2"),
          projectId: ProjectId.make("p"),
          title: "Shop",
          goal: "Ship the shop",
          permissions: { folders: [], projects: [], tools: ["read"] },
        });
        summary = "A job's session.";
        assert.isNull(
          yield* episodeFromSession(yield* sessions.settle({ id: WorkSessionId.make("job-2") })),
        );
      }),
  );
});
