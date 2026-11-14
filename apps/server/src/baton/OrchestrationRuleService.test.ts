/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
import {
  OrchestrationRuleId,
  ProviderInstanceId,
  ThreadId,
  WorkSessionId,
  type BatonSessionState,
  type OrchestrationRule,
} from "@t3tools/tessaya-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import {
  layer as ruleServiceLayer,
  OrchestrationRuleService,
  shouldFire,
  triggerMatchesState,
} from "./OrchestrationRuleService.ts";

const layer = it.layer(ruleServiceLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const workSessionId = WorkSessionId.make("ws-scheduler");
const codex = ProviderInstanceId.make("codex");

let sequence = 0;
const nextRuleId = () => OrchestrationRuleId.make(`rule-${(sequence += 1)}`);

const reviewAction = {
  kind: "start_provider_session" as const,
  providerInstanceId: codex,
  model: "gpt-5",
  role: "review" as const,
  runtimeMode: "approval-required" as const,
  prompt: "Review the change.",
  title: "Review",
};

const rule = (overrides?: Partial<OrchestrationRule>): OrchestrationRule => ({
  id: nextRuleId(),
  workSessionId,
  source: "When Claude finishes this, have Codex review it.",
  trigger: { kind: "on_done" },
  action: reviewAction,
  followUp: null,
  status: "enabled",
  maxFirings: 3,
  firedCount: 0,
  createdAt: "2026-09-18T05:00:00.000Z",
  updatedAt: "2026-09-18T05:00:00.000Z",
  lastFiredAt: null,
  ...overrides,
});

// --- the safety decision, tested on its own ------------------------------

it("maps each trigger onto the states §10 derives, and nothing else", () => {
  const matches = (kind: OrchestrationRule["trigger"]["kind"], state: BatonSessionState) =>
    triggerMatchesState(
      kind === "after_rule" ? { kind, ruleId: OrchestrationRuleId.make("x") } : { kind },
      state,
    );
  assert.isTrue(matches("on_done", "done_unseen"));
  assert.isTrue(matches("on_done", "idle"));
  assert.isFalse(matches("on_done", "working"));
  assert.isTrue(matches("on_needs_user", "needs_approval"));
  assert.isTrue(matches("on_needs_user", "needs_input"));
  assert.isFalse(matches("on_needs_user", "done_unseen"));
  assert.isTrue(matches("on_failed", "failed"));
  // A sequenced rule is released by its predecessor, never by a state change.
  assert.isFalse(matches("after_rule", "done_unseen"));
});

it("refuses to fire once the bound is spent", () => {
  const decision = shouldFire({
    rule: rule({ firedCount: 3, maxFirings: 3 }),
    state: "done_unseen",
    changedThreadId: ThreadId.make("t1"),
    firings: [],
    stateChanged: true,
  });
  assert.deepStrictEqual(decision, { fire: false, reason: "exhausted" });
});

it("refuses to fire on a thread its own firing created", () => {
  // §22's loop, exactly: the review session finishing would otherwise satisfy
  // the same on_done trigger that started it, forever.
  const produced = ThreadId.make("review-thread");
  const decision = shouldFire({
    rule: rule(),
    state: "done_unseen",
    changedThreadId: produced,
    firings: [
      {
        ruleId: OrchestrationRuleId.make("rule-0"),
        producedThreadId: produced,
        outcome: "completed",
      },
    ],
    stateChanged: true,
  });
  assert.deepStrictEqual(decision, { fire: false, reason: "would_self_trigger" });
});

it("checks self-triggering before the trigger, so a matching state cannot slip past", () => {
  const produced = ThreadId.make("review-thread");
  const decision = shouldFire({
    rule: rule({ trigger: { kind: "on_failed" } }),
    state: "failed",
    changedThreadId: produced,
    firings: [
      {
        ruleId: OrchestrationRuleId.make("rule-0"),
        producedThreadId: produced,
        outcome: "completed",
      },
    ],
    stateChanged: true,
  });
  assert.strictEqual(decision.fire, false);
  assert.strictEqual(decision.fire === false ? decision.reason : null, "would_self_trigger");
});

it("holds a sequenced rule until its predecessor completed", () => {
  const first = OrchestrationRuleId.make("rule-first");
  const sequenced = rule({ trigger: { kind: "after_rule", ruleId: first } });
  assert.deepStrictEqual(
    shouldFire({
      rule: sequenced,
      state: "done_unseen",
      changedThreadId: null,
      firings: [],
      stateChanged: true,
    }),
    { fire: false, reason: "predecessor_not_completed" },
  );
  // An unanswered confirmation gate is `awaiting_confirmation`, not completed,
  // so what is queued behind it stays queued.
  assert.deepStrictEqual(
    shouldFire({
      rule: sequenced,
      state: "done_unseen",
      changedThreadId: null,
      firings: [{ ruleId: first, producedThreadId: null, outcome: "awaiting_confirmation" }],
      stateChanged: true,
    }),
    { fire: false, reason: "predecessor_not_completed" },
  );
  assert.deepStrictEqual(
    shouldFire({
      rule: sequenced,
      state: "done_unseen",
      changedThreadId: null,
      firings: [{ ruleId: first, producedThreadId: null, outcome: "completed" }],
      stateChanged: true,
    }),
    { fire: true },
  );
});

it("fires a sequenced rule once per predecessor completion, not once per event", () => {
  // Caught by the live proof: "has the predecessor completed?" stays true
  // forever, so this rule fired on every subsequent event until the bound
  // stopped it at three. The bound is a safety net; it is not the schedule.
  const first = OrchestrationRuleId.make("rule-first");
  const sequenced = rule({
    id: OrchestrationRuleId.make("rule-second"),
    trigger: { kind: "after_rule", ruleId: first },
  });
  const predecessorCompleted = {
    ruleId: first,
    producedThreadId: null,
    outcome: "completed" as const,
  };
  const ownFiring = {
    ruleId: sequenced.id,
    producedThreadId: null,
    outcome: "completed" as const,
  };

  assert.deepStrictEqual(
    shouldFire({
      rule: sequenced,
      state: "done_unseen",
      changedThreadId: null,
      firings: [predecessorCompleted, ownFiring],
      stateChanged: true,
    }),
    { fire: false, reason: "predecessor_not_completed" },
  );

  // A second predecessor completion releases it again, which is what makes
  // implement → review → fix → review work.
  assert.deepStrictEqual(
    shouldFire({
      rule: sequenced,
      state: "done_unseen",
      changedThreadId: null,
      firings: [predecessorCompleted, ownFiring, predecessorCompleted],
      stateChanged: true,
    }),
    { fire: true },
  );
});

it("refuses a disabled rule and a state the trigger does not match", () => {
  assert.deepStrictEqual(
    shouldFire({
      rule: rule({ status: "disabled" }),
      state: "done_unseen",
      changedThreadId: null,
      firings: [],
      stateChanged: true,
    }),
    { fire: false, reason: "disabled" },
  );
  assert.deepStrictEqual(
    shouldFire({
      rule: rule(),
      state: "working",
      changedThreadId: null,
      firings: [],
      stateChanged: true,
    }),
    { fire: false, reason: "trigger_not_matched" },
  );
});

it("fires on entering a state, not while it stays true", () => {
  // A trigger names a transition. A work session that sits idle for an hour
  // has not finished a hundred times, and before this the bound was the only
  // thing stopping it from saying so — the shape D20 already called wrong.
  assert.deepStrictEqual(
    shouldFire({
      rule: rule({ firedCount: 1 }),
      state: "idle",
      changedThreadId: null,
      firings: [],
      stateChanged: true,
    }),
    { fire: true },
  );
  assert.deepStrictEqual(
    shouldFire({
      rule: rule({ firedCount: 1 }),
      state: "idle",
      changedThreadId: null,
      firings: [],
      stateChanged: false,
    }),
    { fire: false, reason: "state_unchanged" },
  );
});

it("lets a rule that has never fired act on a state it finds already true", () => {
  // "When this finishes, have it reviewed", said about work that has just
  // finished, has to do something. Only its second firing waits for a new
  // transition.
  assert.deepStrictEqual(
    shouldFire({
      rule: rule({ firedCount: 0 }),
      state: "done_unseen",
      changedThreadId: null,
      firings: [],
      stateChanged: false,
    }),
    { fire: true },
  );
});

// --- the service ----------------------------------------------------------

layer("OrchestrationRuleService", (it) => {
  const create = (overrides?: { id?: OrchestrationRuleId; maxFirings?: number }) =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      return yield* service.create({
        id: overrides?.id ?? nextRuleId(),
        workSessionId,
        source: "When Claude finishes this, have Codex review it.",
        trigger: { kind: "on_done" },
        action: reviewAction,
        ...(overrides?.maxFirings === undefined ? {} : { maxFirings: overrides.maxFirings }),
      });
    });

  it.effect("creates an enabled rule with the default bound", () =>
    Effect.gen(function* () {
      const created = yield* create();
      assert.strictEqual(created.status, "enabled");
      assert.strictEqual(created.maxFirings, 3);
      assert.strictEqual(created.firedCount, 0);
      assert.isNull(created.lastFiredAt);
    }),
  );

  it.effect("creating twice with one id is a retry, not a second rule", () =>
    Effect.gen(function* () {
      // A duplicate would double every firing and halve the bound's meaning.
      const service = yield* OrchestrationRuleService;
      const id = nextRuleId();
      const first = yield* create({ id });
      const second = yield* create({ id });
      assert.strictEqual(second.createdAt, first.createdAt);
      const listed = yield* service.list({ workSessionId });
      assert.lengthOf(
        listed.filter((entry) => entry.rule.id === id),
        1,
      );
    }),
  );

  it.effect("counts firings durably and exhausts the rule at its bound", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      const created = yield* create({ maxFirings: 2 });

      const first = yield* service.beginFiring({
        rule: created,
        triggeredBy: "on_done:done_unseen",
      });
      assert.strictEqual(first.outcome, "started");
      const afterFirst = (yield* service.list({ workSessionId })).find(
        (entry) => entry.rule.id === created.id,
      );
      assert.strictEqual(afterFirst?.rule.firedCount, 1);
      assert.strictEqual(afterFirst?.rule.status, "enabled");

      yield* service.beginFiring({ rule: afterFirst!.rule, triggeredBy: "on_done:done_unseen" });
      const afterSecond = (yield* service.list({ workSessionId, includeDisabled: true })).find(
        (entry) => entry.rule.id === created.id,
      );
      // A rule that has spent its bound says so, rather than staying "enabled"
      // and silently never firing again.
      assert.strictEqual(afterSecond?.rule.firedCount, 2);
      assert.strictEqual(afterSecond?.rule.status, "exhausted");
      assert.isFalse(
        shouldFire({
          rule: afterSecond!.rule,
          state: "done_unseen",
          changedThreadId: null,
          firings: [],
          stateChanged: true,
        }).fire,
      );
    }),
  );

  it.effect("records what a firing produced, so the loop check has something to read", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      const created = yield* create();
      const firing = yield* service.beginFiring({ rule: created, triggeredBy: "on_done:idle" });
      const produced = ThreadId.make("review-thread-1");
      const completed = yield* service.completeFiring({
        firingId: firing.id,
        outcome: "completed",
        producedThreadId: produced,
        detail: "Started codex as review.",
      });
      assert.strictEqual(completed?.outcome, "completed");
      assert.strictEqual(completed?.producedThreadId, produced);
      assert.isNotNull(completed?.completedAt);

      const { firings } = yield* service.candidatesFor(workSessionId);
      assert.isTrue(firings.some((entry) => entry.producedThreadId === produced));
    }),
  );

  it.effect("leaves a confirmation gate open rather than stamping it complete", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      const created = yield* create();
      const firing = yield* service.beginFiring({ rule: created, triggeredBy: "on_done:idle" });
      const parked = yield* service.completeFiring({
        firingId: firing.id,
        outcome: "awaiting_confirmation",
        producedThreadId: null,
        detail: "Restart the worker?",
      });
      // A gate is not finished; it is waiting. Stamping it complete would let
      // a sequenced rule run before the user answered.
      assert.strictEqual(parked?.outcome, "awaiting_confirmation");
      assert.isNull(parked?.completedAt);
    }),
  );

  it.effect("disabling stops a rule, and enabling brings it back", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      const created = yield* create();
      const disabled = yield* service.setStatus({ id: created.id, status: "disabled" });
      assert.strictEqual(disabled.status, "disabled");
      const hidden = yield* service.list({ workSessionId });
      assert.isFalse(hidden.some((entry) => entry.rule.id === created.id));
      const shown = yield* service.list({ workSessionId, includeDisabled: true });
      assert.isTrue(shown.some((entry) => entry.rule.id === created.id));
      const enabled = yield* service.setStatus({ id: created.id, status: "enabled" });
      assert.strictEqual(enabled.status, "enabled");
    }),
  );

  it.effect("announces creation, triggering and completion as §28 events", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      const subscription = yield* service.subscribe;
      const created = yield* create();
      const firing = yield* service.beginFiring({ rule: created, triggeredBy: "on_done:idle" });
      yield* service.completeFiring({
        firingId: firing.id,
        outcome: "completed",
        producedThreadId: null,
        detail: "done",
      });
      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.take(3),
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        [
          "fabric.orchestration.ruleCreated",
          "fabric.orchestration.ruleTriggered",
          "fabric.orchestration.ruleCompleted",
        ],
      );
    }),
  );

  it.effect("lists only this work session's rules", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      const mine = yield* create();
      yield* service.create({
        id: nextRuleId(),
        workSessionId: WorkSessionId.make("ws-other"),
        trigger: { kind: "on_failed" },
        action: { kind: "notify", message: "the other work failed" },
      });
      const listed = yield* service.list({ workSessionId });
      assert.isTrue(listed.every((entry) => entry.rule.workSessionId === workSessionId));
      assert.isTrue(listed.some((entry) => entry.rule.id === mine.id));
    }),
  );

  it.effect("returns null rather than failing when a firing is gone", () =>
    Effect.gen(function* () {
      const service = yield* OrchestrationRuleService;
      assert.isNull(yield* service.getFiring("never-existed" as never));
      assert.isNull(
        yield* service.completeFiring({
          firingId: "never-existed" as never,
          outcome: "completed",
          producedThreadId: null,
          detail: "",
        }),
      );
    }),
  );

  it.effect("remembers the state a work session was last seen in", () =>
    Effect.gen(function* () {
      // Durable rather than in memory, for the reason the firing count is: a
      // restart would otherwise call every matched state a fresh transition,
      // and a restart is when a runaway does the most damage.
      const service = yield* OrchestrationRuleService;
      const id = WorkSessionId.make("ws-observed");
      assert.isNull(yield* service.observeState({ workSessionId: id, state: "working" }));
      assert.strictEqual(
        yield* service.observeState({ workSessionId: id, state: "working" }),
        "working",
      );
      assert.strictEqual(
        yield* service.observeState({ workSessionId: id, state: "idle" }),
        "working",
      );
      assert.strictEqual(yield* service.observeState({ workSessionId: id, state: "idle" }), "idle");
    }),
  );
});
