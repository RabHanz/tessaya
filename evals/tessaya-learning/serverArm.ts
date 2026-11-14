/**
 * Tessaya's loop as a job runs it on the server: `BatonPlaybook.jobPlaybook` for the first message and
 * `learnFromOutcome` on his verdict, through the real memory service on an in-memory database. Only the model call goes
 * through this eval's `claude -p` runner instead of BrainRoutes. His verdict is the grade; his correction the feedback.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../apps/server/src/config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../apps/server/src/baton/BatonDatabase.ts";
import {
  BatonMemoryService,
  MemoryViewer,
  layer as memoryLayer,
} from "../../apps/server/src/baton/BatonMemoryService.ts";
import { BatonOneShot, BatonOneShotError } from "../../apps/server/src/baton/BatonOneShot.ts";
import {
  jobPlaybook,
  learnFromOutcome,
  playbookDomain,
} from "../../apps/server/src/baton/BatonPlaybook.ts";
import { instructionLike } from "../../packages/baton-shared/src/playbook.ts";
import { runClaude } from "./agent.ts";
import type { Arm } from "./arms.ts";

export const serverArm = (model: string, cwd: string): Arm => {
  let spent = { tokens: 0, costUsd: 0 };
  const run: BatonOneShot["Service"]["run"] = ({ prompt, outputSchema }) =>
    Effect.tryPromise({
      try: async () => {
        const answer = await runClaude({ cwd, model, tools: false, prompt });
        spent = { tokens: spent.tokens + answer.tokens, costUsd: spent.costUsd + answer.costUsd };
        return JSON.parse(/\{[\s\S]*\}/.exec(answer.final)?.[0] ?? "{}") as unknown;
      },
      catch: () => new BatonOneShotError({ detail: "the writer did not answer" }),
    }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(outputSchema)(value)),
      Effect.mapError(() => new BatonOneShotError({ detail: "the writer's answer did not fit" })),
    ) as never;
  const config = Layer.succeed(ServerConfig.ServerConfig, {
    dbPath: "/nowhere/statev2.sqlite",
  } as unknown as ServerConfig.ServerConfig["Service"]);
  const runtime = ManagedRuntime.make(
    memoryLayer.pipe(
      Layer.provideMerge(Layer.succeed(BatonOneShot, { run })),
      Layer.provideMerge(config),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  );
  return {
    id: "tessaya-server",
    system: (job) => runtime.runPromise(jobPlaybook(job.family)),
    prepare: () => {},
    learn: async (job, done, outcome) => {
      spent = { tokens: 0, costUsd: 0 };
      await runtime.runPromise(
        learnFromOutcome({
          domain: playbookDomain({ project: job.family })!,
          job: `${job.family}-${job.index}`,
          goal: job.goal,
          report: done.final,
          passed: outcome.pass,
          why: outcome.feedback,
          his: true,
          tainted: done.results.some(instructionLike),
        }).pipe(Effect.ignoreCause({ log: false })),
      );
      return spent;
    },
    memoryText: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const items = yield* (yield* BatonMemoryService).list({
            kinds: ["skill"],
            includeProposed: true,
          });
          return items.map((i) => i.text).join("\n");
        }).pipe(Effect.provideService(MemoryViewer, "server")),
      ),
  };
};
