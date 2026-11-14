import { ProjectId, ProviderInstanceId, ThreadId, WorkSessionId } from "@t3tools/tessaya-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { layer as workSessionServiceLayer, WorkSessionService } from "./WorkSessionService.ts";

const layer = it.layer(workSessionServiceLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const projectId = ProjectId.make("project-vantageos");
const claudeA = ProviderInstanceId.make("claude-a");
const claudeB = ProviderInstanceId.make("claude-b");

let sequence = 0;
const nextId = () => WorkSessionId.make(`work-session-${(sequence += 1)}`);

const create = (overrides?: { id?: WorkSessionId; title?: string }) =>
  Effect.gen(function* () {
    const service = yield* WorkSessionService;
    return yield* service.create({
      id: overrides?.id ?? nextId(),
      projectId,
      title: overrides?.title ?? "Scheduler reconnect race",
    });
  });

layer("WorkSessionService", (it) => {
  it.effect("creates work with a derived active status and no provider", () =>
    Effect.gen(function* () {
      const created = yield* create({ title: "Scheduler reconnect race" });
      assert.strictEqual(created.status, "active");
      assert.strictEqual(created.title, "Scheduler reconnect race");
      assert.isNull(created.activeThreadId);
      assert.isNull(created.settledAt);
      assert.isNull(created.archivedAt);
      assert.lengthOf(created.providerSessions, 0);
    }),
  );

  it.effect("creating twice with one id is a retry, not a second piece of work", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const id = nextId();
      const first = yield* create({ id, title: "Original" });
      const second = yield* service.create({ id, projectId, title: "Different title" });
      assert.strictEqual(second.id, first.id);
      assert.strictEqual(second.title, "Original");
      assert.strictEqual(second.createdAt, first.createdAt);
      const listed = yield* service.list({});
      assert.lengthOf(
        listed.filter((entry) => entry.id === id),
        1,
      );
    }),
  );

  it.effect("attaching a thread records the account and makes it active", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      const attached = yield* service.attachThread({
        id: created.id,
        threadId,
        providerInstanceId: claudeA,
      });
      assert.strictEqual(attached.activeThreadId, threadId);
      assert.lengthOf(attached.providerSessions, 1);
      const [session] = attached.providerSessions;
      assert.strictEqual(session?.providerInstanceId, claudeA);
      assert.strictEqual(session?.role, "implementation");
      assert.strictEqual(session?.origin, "attached");
      assert.isNull(session?.detachedAt ?? null);
    }),
  );

  it.effect("attaching the same thread twice is idempotent", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      yield* service.attachThread({ id: created.id, threadId, providerInstanceId: claudeA });
      const again = yield* service.attachThread({
        id: created.id,
        threadId,
        providerInstanceId: claudeA,
      });
      assert.lengthOf(again.providerSessions, 1);
    }),
  );

  it.effect("a thread cannot belong to two work sessions at once", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const first = yield* create();
      const second = yield* create();
      const threadId = ThreadId.make(`${first.id}-contested-thread`);
      yield* service.attachThread({ id: first.id, threadId, providerInstanceId: claudeA });
      const failure = yield* service
        .attachThread({ id: second.id, threadId, providerInstanceId: claudeB })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WorkSessionThreadConflictError");
    }),
  );

  it.effect("a review session attaches without stealing the active thread", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const implementation = ThreadId.make(`${created.id}-impl`);
      const review = ThreadId.make(`${created.id}-review`);
      yield* service.attachThread({
        id: created.id,
        threadId: implementation,
        providerInstanceId: claudeA,
      });
      const withReview = yield* service.attachThread({
        id: created.id,
        threadId: review,
        providerInstanceId: claudeB,
        role: "review",
      });
      assert.strictEqual(withReview.activeThreadId, implementation);
      assert.lengthOf(withReview.providerSessions, 2);
    }),
  );

  it.effect("detaching keeps the work and its history, and clears the active thread", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      yield* service.attachThread({ id: created.id, threadId, providerInstanceId: claudeA });
      const detached = yield* service.detachThread({ id: created.id, threadId });
      assert.strictEqual(detached.status, "active");
      assert.isNull(detached.activeThreadId);
      assert.lengthOf(detached.providerSessions, 1);
      // The stretch Claude A ran is still on the timeline, with an end.
      assert.strictEqual(detached.providerSessions[0]?.providerInstanceId, claudeA);
      assert.isNotNull(detached.providerSessions[0]?.detachedAt);
    }),
  );

  it.effect("a detached thread can be attached again, and both stretches survive", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      yield* service.attachThread({ id: created.id, threadId, providerInstanceId: claudeA });
      yield* service.detachThread({ id: created.id, threadId });
      const reattached = yield* service.attachThread({
        id: created.id,
        threadId,
        providerInstanceId: claudeB,
      });
      assert.lengthOf(reattached.providerSessions, 2);
      assert.strictEqual(reattached.activeThreadId, threadId);
      const live = reattached.providerSessions.filter((session) => session.detachedAt === null);
      assert.lengthOf(live, 1);
      assert.strictEqual(live[0]?.providerInstanceId, claudeB);
    }),
  );

  it.effect("detaching a thread this work session does not hold is refused", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const failure = yield* service
        .detachThread({ id: created.id, threadId: ThreadId.make(`${created.id}-absent`) })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WorkSessionThreadNotAttachedError");
    }),
  );

  it.effect("the work session outlives its provider thread ending", () =>
    // The Phase 2 exit criterion. Detaching is how a thread ends as far as the
    // work is concerned; what must survive is the work, its objective, its
    // worktree, and the record of who ran it.
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const id = nextId();
      yield* service.create({
        id,
        projectId,
        title: "Scheduler reconnect race",
        objective: "Stop a reconnect between commit and ack duplicating dispatch",
        acceptanceCriteria: ["reconnect integration test passes"],
        primaryWorktreePath: "/w/vantageos-scheduler-reconnect",
        baseBranch: "main",
      });
      const threadId = ThreadId.make(`${id}-thread-a`);
      yield* service.attachThread({ id, threadId, providerInstanceId: claudeA });
      yield* service.detachThread({ id, threadId });

      const survivor = yield* service.get(id);
      assert.strictEqual(survivor.status, "active");
      assert.strictEqual(
        survivor.objective,
        "Stop a reconnect between commit and ack duplicating dispatch",
      );
      assert.deepStrictEqual(survivor.acceptanceCriteria, ["reconnect integration test passes"]);
      assert.strictEqual(survivor.primaryWorktreePath, "/w/vantageos-scheduler-reconnect");
      assert.strictEqual(survivor.baseBranch, "main");
      assert.isNull(survivor.activeThreadId);
      assert.lengthOf(survivor.providerSessions, 1);
    }),
  );

  it.effect("settling and archiving are separate, reversible, and both keep the timeline", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      yield* service.attachThread({ id: created.id, threadId, providerInstanceId: claudeA });

      const settled = yield* service.settle({ id: created.id });
      assert.strictEqual(settled.status, "settled");
      assert.isNotNull(settled.settledAt);
      assert.lengthOf(settled.providerSessions, 1);

      const archived = yield* service.archive({ id: created.id });
      assert.strictEqual(archived.status, "archived");
      assert.isNotNull(archived.settledAt);
      assert.lengthOf(archived.providerSessions, 1);

      const unarchived = yield* service.unarchive({ id: created.id });
      assert.strictEqual(unarchived.status, "settled");

      const unsettled = yield* service.unsettle({ id: created.id });
      assert.strictEqual(unsettled.status, "active");
      assert.isNull(unsettled.settledAt);
      assert.lengthOf(unsettled.providerSessions, 1);
    }),
  );

  it.effect("archiving is independent of the thread: the thread may still be attached", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      yield* service.attachThread({ id: created.id, threadId, providerInstanceId: claudeA });
      const archived = yield* service.archive({ id: created.id });
      assert.strictEqual(archived.activeThreadId, threadId);
      assert.isNull(archived.providerSessions[0]?.detachedAt ?? null);
    }),
  );

  it.effect("the default list hides archived work and includeArchived brings it back", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      yield* service.archive({ id: created.id });
      const visible = yield* service.list({});
      assert.isFalse(visible.some((entry) => entry.id === created.id));
      const everything = yield* service.list({ includeArchived: true });
      assert.isTrue(everything.some((entry) => entry.id === created.id));
    }),
  );

  it.effect("reading an unknown work session fails rather than inventing one", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const failure = yield* service.get(WorkSessionId.make("never-created")).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WorkSessionNotFoundError");
    }),
  );

  it.effect("update leaves absent keys alone and applies an explicit null", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const id = nextId();
      yield* service.create({
        id,
        projectId,
        title: "Original",
        objective: "Original objective",
        baseBranch: "main",
      });
      const renamed = yield* service.update({ id, title: "Renamed" });
      assert.strictEqual(renamed.title, "Renamed");
      assert.strictEqual(renamed.objective, "Original objective");
      assert.strictEqual(renamed.baseBranch, "main");

      const cleared = yield* service.update({ id, baseBranch: null });
      assert.isNull(cleared.baseBranch);
      assert.strictEqual(cleared.title, "Renamed");
    }),
  );

  it.effect("folds synopsis signals and leaves the record's own timestamp alone", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      assert.isNull(created.synopsis ?? null);

      const synopsis = yield* service.applySynopsis({
        workSessionId: created.id,
        signals: [
          { kind: "turn-started", at: "2026-09-18T04:00:00.000Z", prompt: "Find the race" },
          { kind: "files-changed", at: "2026-09-18T04:01:00.000Z", paths: ["src/scheduler.ts"] },
        ],
      });
      assert.strictEqual(synopsis?.currentAction, "Find the race");
      assert.deepStrictEqual(synopsis?.changedFiles, ["src/scheduler.ts"]);

      const reloaded = yield* service.get(created.id);
      assert.strictEqual(reloaded.synopsis?.updatedAt, "2026-09-18T04:01:00.000Z");
      // Watching a work session is not working on it. The record's own
      // timestamp is what the fleet's recency ordering falls back to, so a
      // synopsis write must not fake activity on it.
      assert.strictEqual(reloaded.updatedAt, created.updatedAt);
    }),
  );

  it.effect("does nothing for an empty signal list or a work session that is gone", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      assert.isNull(yield* service.applySynopsis({ workSessionId: created.id, signals: [] }));
      // A reactor can outlive the work it was following; that is not an error.
      assert.isNull(
        yield* service.applySynopsis({
          workSessionId: WorkSessionId.make("never-created"),
          signals: [{ kind: "turn-completed", at: "2026-09-18T04:00:00.000Z" }],
        }),
      );
    }),
  );

  it.effect("finds the work session holding a thread, and nothing once it is detached", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const threadId = ThreadId.make(`${created.id}-thread-a`);
      assert.isNull(yield* service.findForThread(threadId));
      yield* service.attachThread({ id: created.id, threadId, providerInstanceId: claudeA });
      assert.strictEqual(yield* service.findForThread(threadId), created.id);
      yield* service.detachThread({ id: created.id, threadId });
      assert.isNull(yield* service.findForThread(threadId));
    }),
  );

  it.effect("announces a synopsis update on its own event, not as a work-session update", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const created = yield* create();
      const subscription = yield* service.subscribe;
      yield* service.applySynopsis({
        workSessionId: created.id,
        signals: [{ kind: "turn-completed", at: "2026-09-18T04:00:00.000Z" }],
      });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual(events[0]?.kind, "fabric.synopsis.updated");
    }),
  );

  it.effect("subscribers receive a snapshot and then the events they caused", () =>
    Effect.gen(function* () {
      const service = yield* WorkSessionService;
      const existing = yield* create({ title: "Already here" });
      const subscription = yield* service.subscribe;
      const id = nextId();
      const threadId = ThreadId.make(`${id}-thread-a`);

      yield* service.create({ id, projectId, title: "New work" });
      yield* service.attachThread({ id, threadId, providerInstanceId: claudeA });
      yield* service.settle({ id });

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(3),
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        [
          "fabric.workSession.created",
          "fabric.workSession.providerAttached",
          "fabric.workSession.statusChanged",
        ],
      );
      // The events carry the whole record, so a client applies them without a
      // follow-up read.
      const [created, attached, changed] = events;
      assert.strictEqual(
        created?.kind === "fabric.workSession.created" ? created.workSession.title : null,
        "New work",
      );
      assert.strictEqual(
        attached?.kind === "fabric.workSession.providerAttached"
          ? attached.workSession.activeThreadId
          : null,
        threadId,
      );
      assert.strictEqual(
        changed?.kind === "fabric.workSession.statusChanged" ? changed.previousStatus : null,
        "active",
      );
      assert.strictEqual(
        changed?.kind === "fabric.workSession.statusChanged" ? changed.workSession.status : null,
        "settled",
      );
      assert.isTrue(existing.id !== id);
    }),
  );
});
