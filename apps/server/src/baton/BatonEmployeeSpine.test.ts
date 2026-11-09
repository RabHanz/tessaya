/**
 * The employee spine, end to end with no model: a job goes plan -> agreement -> work -> periodic
 * report -> failure -> automatic retry under a standing grant -> cost on the card -> cap stop ->
 * handoff -> finish, through the real job, work-session and flow services and a fake worker.
 * If this breaks, something between "hand it a job" and "it reports back" broke.
 */
import { ProjectId, WorkSessionId } from "@t3tools/baton-contracts";
import {
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonEngine, layerStatic } from "./BatonEngine.ts";
import { agreeJob, autoRetry, enforceCaps, postReports, startJob } from "./BatonJobFlow.ts";
import { BatonJobService, layer as jobLayer } from "./BatonJobService.ts";
import { BatonMemoryService } from "./BatonMemoryService.ts";
import { layer as workSessionLayer } from "./WorkSessionService.ts";

const sent: Array<{ threadId: ThreadId; text: string }> = [];
const shells: OrchestrationV2ThreadShell[] = [];
const interrupted: ThreadId[] = [];
const switched: Array<{ threadId: ThreadId; tag: string }> = [];
const runs = new Map<string, ReadonlyArray<{ status: string }>>();

const layer = it.layer(
  Layer.mergeAll(
    jobLayer,
    Layer.succeed(ScheduledTaskService, {} as never),
    Layer.succeed(BatonMemoryService, {
      recall: () => Effect.succeed({ block: "", ids: [] }),
    } as never),
    Layer.succeed(ServerConfig.ServerConfig, {
      dbPath: NodePath.join(NodeOS.tmpdir(), "baton-spine-test", "state.sqlite"),
    } as never),
    layerStatic({ launch: (l) => l.threadId ?? null, sent, shells, runs, interrupted, switched }),
  ).pipe(Layer.provideMerge(workSessionLayer), Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("employee spine", (it) => {
  it.effect("runs a job from plan to finish and keeps the whole record", () =>
    Effect.gen(function* () {
      const jobs = yield* BatonJobService;
      const engine = yield* BatonEngine;
      const id = WorkSessionId.make("spine-1");
      const { threadId } = yield* startJob({
        id,
        projectId: ProjectId.make("project-site"),
        title: "Spine job",
        goal: "Fix the flaky test",
        permissions: { folders: [], projects: [], tools: ["read"] },
        limits: {
          retries: 2,
          reportEveryMinutes: 1,
          workerTurns: 3,
          wallClockMinutes: 600,
          dollars: 1,
        },
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
        runtimeMode: "approval-required",
      });
      const card = (state: string, extra: Record<string, unknown> = {}) =>
        [
          {
            workSessionId: id,
            title: "Spine job",
            lifecycle: state === "idle" ? "settled" : "active",
            state,
            needsUser: false,
            updatedAt: "2026-11-03T10:00:00.000Z",
            threads: [{ threadId }],
            synopsis: {
              currentAction: "running the tests",
              recentFindings: [],
              changedFiles: [],
              next: [],
              validation: [],
              needsUser: false,
            },
            ...extra,
          },
        ] as never;

      // Plan, then his agreement: nothing runs before it, and it goes once.
      shells.push({ id: threadId, status: "completed" } as OrchestrationV2ThreadShell);
      assert.strictEqual((yield* jobs.terms(id))?.phase, "drafting_plan");
      yield* jobs.planReady(id);
      assert.strictEqual((yield* jobs.terms(id))?.phase, "awaiting_agreement");
      assert.lengthOf(sent, 0);
      yield* agreeJob(id);
      assert.strictEqual((yield* jobs.terms(id))?.phase, "approved");
      assert.lengthOf(sent, 1);

      // A periodic report appears in the record without a worker turn.
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual(yield* postReports(card("working")), [id]);
      assert.lengthOf(sent, 1);

      // The worker fails: nothing retries without the grant; with it, once per budget slot.
      assert.deepStrictEqual(yield* autoRetry(card("failed")), []);
      yield* jobs.grant(id, "retry");
      assert.deepStrictEqual(yield* autoRetry(card("failed")), [id]);
      assert.include(sent.at(-1)?.text ?? "", "Retry 1 of 2");

      // Cost accounting reaches the card, and the dollar cap trips on what was priced.
      const priced = yield* jobs.view({
        entries: card("working"),
        spend: new Map([[id, { tokens: 1200, dollars: 1.5, partial: false }]]),
      });
      assert.strictEqual(priced[0]?.limitReached, "spend");
      assert.deepInclude(priced[0]?.usage ?? {}, { tokens: 1200, dollars: 1.5 });

      // The turn cap stops a worker that is still going, and says why in the record.
      runs.set(threadId, [
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
      ]);
      assert.deepStrictEqual(yield* enforceCaps(card("working")), [id]);
      assert.deepStrictEqual(interrupted, [threadId]);

      // Handoff to another worker keeps the thread.
      yield* engine.switchProvider({
        tag: "handoff",
        threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
      } as never);
      assert.deepStrictEqual(switched, [{ threadId, tag: "handoff" }]);

      // Finished: the card is done and the whole story is in the record, in order.
      runs.set(threadId, []);
      const finished = yield* jobs.view({ entries: card("idle") });
      assert.strictEqual(finished[0]?.group, "done");
      const texts = (yield* jobs.terms(id))!.revisions.map((r) => r.text);
      const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
      assert.isAbove(at("Report:"), -1);
      assert.isAbove(at("Retry 1 of 2"), at("Report:"));
      assert.isAbove(at("reached its"), at("Retry 1 of 2"));
    }),
  );
});
