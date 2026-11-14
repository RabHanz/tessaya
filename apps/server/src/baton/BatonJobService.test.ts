import {
  ProjectId,
  ThreadId,
  WorkSessionId,
  type BatonFleetEntry,
} from "@t3tools/tessaya-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { BatonJobService, layer as jobLayer } from "./BatonJobService.ts";
import { layer as workSessionLayer } from "./WorkSessionService.ts";

const layer = it.layer(
  jobLayer.pipe(Layer.provideMerge(workSessionLayer), Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.make("project-site");
const permissions = {
  folders: ["~/dev/site"],
  projects: ["Site"],
  tools: ["read", "edit"] as const,
};

const entry = (id: WorkSessionId, over: Partial<BatonFleetEntry> = {}): BatonFleetEntry =>
  ({
    workSessionId: id,
    title: "Rebuild the site",
    projectId,
    lifecycle: "active",
    state: "working",
    needsUser: false,
    activeThreadId: ThreadId.make(`${id}-t`),
    threads: [],
    adopted: [],
    synopsis: null,
    updatedAt: "2026-11-02T10:00:00.000Z",
    ...over,
  }) as BatonFleetEntry;

layer("BatonJobService", (it) => {
  it.effect("makes a job as a work session with terms, and a retry changes nothing", () =>
    Effect.gen(function* () {
      const jobs = yield* BatonJobService;
      const id = WorkSessionId.make("job-1");
      const first = yield* jobs.create({
        id,
        projectId,
        title: "Rebuild the site",
        goal: "Rebuild the site",
        permissions: { ...permissions, tools: [...permissions.tools] },
      });
      assert.strictEqual(first.limits.wallClockMinutes, 120);
      assert.strictEqual(first.limits.workerTurns, 40);
      assert.isNull(first.limits.dollars);
      const again = yield* jobs.create({
        id,
        projectId,
        title: "Different",
        goal: "Different",
        permissions: { ...permissions, tools: ["read"] },
      });
      assert.strictEqual(again.goal, "Rebuild the site");
      assert.lengthOf(
        (yield* jobs.allTerms()).filter((t) => t.workSessionId === id),
        1,
      );
    }),
  );

  it.effect("a standing permission is explicit, per job, revocable, and kept as a log", () =>
    Effect.gen(function* () {
      const jobs = yield* BatonJobService;
      const a = WorkSessionId.make("job-2");
      const b = WorkSessionId.make("job-3");
      for (const id of [a, b]) {
        yield* jobs.create({
          id,
          projectId,
          title: "Job",
          goal: "g",
          permissions: { ...permissions, tools: ["read"] },
        });
      }
      yield* jobs.grant(a, "email");
      assert.lengthOf((yield* jobs.terms(a))!.grants, 1);
      assert.lengthOf((yield* jobs.terms(b))!.grants, 0);
      const revoked = (yield* jobs.revoke(a, "email"))!;
      assert.strictEqual(revoked.grants[0]?.channel, "email");
      assert.isNotNull(revoked.grants[0]?.revokedAt);
      assert.isNull(yield* jobs.grant(WorkSessionId.make("nope"), "chat"));
    }),
  );

  it.effect(
    "reads each job's group and permissions from the fleet's state, never from a stored status",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BatonJobService;
        const id = WorkSessionId.make("job-4");
        yield* jobs.create({
          id,
          projectId,
          title: "Rebuild the site",
          goal: "g",
          permissions: { ...permissions, tools: [...permissions.tools] },
        });
        yield* jobs.setSchedule(id, "task-9");
        const running = (yield* jobs.view({ entries: [entry(id)] })).find(
          (j) => j.workSessionId === id,
        )!;
        assert.strictEqual(running.group, "running");
        assert.strictEqual(running.terms.scheduleTaskId, "task-9");
        assert.include(running.permissionsSummary, "Works in the Site project and ~/dev/site.");
        const asks = (yield* jobs.view({ entries: [entry(id, { state: "needs_input" })] })).find(
          (j) => j.workSessionId === id,
        )!;
        assert.strictEqual(asks.group, "needs_you");
        const capped = (yield* jobs.view({
          entries: [entry(id)],
          turns: new Map([[id, 40]]),
        })).find((j) => j.workSessionId === id)!;
        assert.strictEqual(capped.limitReached, "turns");
        // A job whose work session the fleet no longer lists is not shown.
        assert.lengthOf(yield* jobs.view({ entries: [] }), 0);
      }),
  );

  it.effect(
    "goes from planning to waiting to approved only on his agreement, and keeps what he says",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BatonJobService;
        const id = WorkSessionId.make("job-5");
        const made = yield* jobs.create({
          id,
          projectId,
          title: "Plan it",
          goal: "Plan it",
          permissions: { ...permissions, tools: [...permissions.tools] },
        });
        assert.strictEqual(made.phase, "drafting_plan");
        assert.strictEqual((yield* jobs.agree(id))!.phase, "drafting_plan");
        assert.strictEqual((yield* jobs.planReady(id))!.phase, "awaiting_agreement");
        const view = (yield* jobs.view({ entries: [entry(id, { state: "idle" })] })).find(
          (j) => j.workSessionId === id,
        )!;
        assert.strictEqual(view.group, "needs_you");
        assert.strictEqual(view.phase, "awaiting_agreement");
        const refined = (yield* jobs.refine(id, {
          by: "him",
          at: "2026-11-02T10:00:00.000Z",
          via: "voice",
          text: "Keep the old logo",
        }))!;
        assert.strictEqual(refined.phase, "drafting_plan");
        assert.deepEqual(
          refined.revisions.map((r) => r.text),
          ["Keep the old logo"],
        );
        yield* jobs.planReady(id);
        assert.strictEqual((yield* jobs.agree(id))!.phase, "approved");
      }),
  );

  it.effect(
    "a job with a standing permission to start skips the wait, and a job without one does not",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BatonJobService;
        const a = WorkSessionId.make("job-6");
        const b = WorkSessionId.make("job-7");
        for (const id of [a, b]) {
          yield* jobs.create({
            id,
            projectId,
            title: "Job",
            goal: "g",
            permissions: { ...permissions, tools: ["read"] },
          });
        }
        yield* jobs.grant(a, "start");
        assert.strictEqual((yield* jobs.planReady(a))!.phase, "approved");
        assert.strictEqual((yield* jobs.planReady(b))!.phase, "awaiting_agreement");
        const widened = (yield* jobs.refine(
          a,
          { by: "him", at: "2026-11-02T10:00:00.000Z", via: "text", text: "you may use the web" },
          true,
        ))!;
        assert.strictEqual(widened.phase, "awaiting_agreement");
      }),
  );
});
