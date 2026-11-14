/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
import {
  OrchestrationRuleId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkSessionId,
  type OrchestrationAction,
  type OrchestrationV2ThreadShell,
} from "@t3tools/tessaya-contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { finishedShell, workingShell } from "./__fixtures__/v2ThreadShell.ts";
import { TessayaEngine } from "./TessayaEngine.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import {
  TessayaOrchestrationReactor,
  layer as reactorLayer,
  OrchestrationEffectsService,
  type OrchestrationEffects,
} from "./OrchestrationReactor.ts";
import { layer as ruleServiceLayer, OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import { layer as workSessionLayer, WorkSessionService } from "./WorkSessionService.ts";

// --- one evaluation, end to end over the real services --------------------
//
// The only stubs are `TessayaEngine`, the one seam to upstream's engine (what a
// thread is doing, and the event subscription), and `OrchestrationEffects`, which exists precisely so the
// list of things a rule may do can be swapped for a recording of what it asked
// for. The work sessions, the rules, the firings and the bound are real and go
// through SQLite.

const workSessionId = WorkSessionId.make("ws-reactor");
const projectId = ProjectId.make("project-reactor");
const implThreadId = ThreadId.make("impl-thread");
const reviewThreadId = ThreadId.make("review-thread");
const claude = ProviderInstanceId.make("claude-a");
const codex = ProviderInstanceId.make("codex");

/** A thread whose run finished and that nobody has looked at: `done_unseen`. */
const finishedThread: OrchestrationV2ThreadShell = finishedShell(implThreadId);

/** The same thread, mid-run: `working`, which no trigger matches. */
const workingThread: OrchestrationV2ThreadShell = workingShell(implThreadId);

/** What the projection reports right now. Reset by each test that moves it. */
let currentThread: OrchestrationV2ThreadShell = finishedThread;

const reviewAction = {
  kind: "start_provider_session",
  providerInstanceId: codex,
  model: "gpt-5",
  role: "review",
  runtimeMode: "approval-required",
  prompt: "Review the change.",
  title: "Review",
} satisfies Extract<OrchestrationAction, { kind: "start_provider_session" }>;

const harness = (effects: Partial<OrchestrationEffects>) =>
  reactorLayer.pipe(
    Layer.provide(
      Layer.succeed(OrchestrationEffectsService, {
        startProviderSession: () => Effect.succeed(null),
        messageThread: () => Effect.succeed(true),
        notify: () => Effect.void,
        refusal: () => Effect.succeed(null),
        noteRun: () => Effect.void,
        ...effects,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(ruleServiceLayer, workSessionLayer)),
    Layer.provide(
      Layer.mock(TessayaEngine)({
        // Read through a holder, so a test can move the work session between
        // states — the only way to exercise a transition rather than a
        // condition.
        threadShell: () => Effect.sync(() => currentThread),
        changedThreads: Stream.empty,
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const givenFinishedWork = Effect.gen(function* () {
  currentThread = finishedThread;
  const workSessions = yield* WorkSessionService;
  yield* workSessions.create({ id: workSessionId, projectId, title: "Reactor work" });
  yield* workSessions.attachThread({
    id: workSessionId,
    threadId: implThreadId,
    providerInstanceId: claude,
    providerDriver: ProviderDriverKind.make("claudeAgent"),
    role: "implementation",
    origin: "created",
  });
});

/** Distinct thread ids for the bound test, without reaching for randomness. */
let started = 0;

const ruleCount = (id: OrchestrationRuleId) =>
  Effect.gen(function* () {
    const rules = yield* OrchestrationRuleService;
    const listed = yield* rules.list({ workSessionId, includeDisabled: true });
    return listed.find((entry) => entry.rule.id === id)?.rule.firedCount ?? -1;
  });

describe("the reactor's own evaluation", () => {
  it.effect("starts the review a rule asked for and records what it produced", () =>
    Effect.gen(function* () {
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-review");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
      });

      const reactor = yield* TessayaOrchestrationReactor;
      const fired = yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });

      assert.lengthOf(fired, 1);
      assert.strictEqual(fired[0]?.outcome, "completed");
      assert.strictEqual(fired[0]?.producedThreadId, reviewThreadId);
      assert.strictEqual(fired[0]?.triggeredBy, "on_done:done_unseen");
      assert.strictEqual(yield* ruleCount(id), 1);
    }).pipe(
      Effect.provide(harness({ startProviderSession: () => Effect.succeed(reviewThreadId) })),
    ),
  );

  it.effect("a rule its owner may not run by itself is recorded as held and does nothing", () =>
    Effect.gen(function* () {
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-held");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
      });

      const fired = yield* (yield* TessayaOrchestrationReactor).evaluate({
        workSessionId,
        changedThreadId: implThreadId,
      });

      assert.strictEqual(fired[0]?.outcome, "skipped");
      assert.strictEqual(fired[0]?.detail, "Held: job_start is not one of Tessaya's tools.");
      assert.strictEqual(fired[0]?.producedThreadId, null);
    }).pipe(
      Effect.provide(
        harness({
          refusal: () => Effect.succeed("job_start is not one of Tessaya's tools."),
          startProviderSession: () => Effect.die("a held rule must not start anything"),
        }),
      ),
    ),
  );

  it.effect("does not fire again on the thread its own firing created", () =>
    Effect.gen(function* () {
      // §22's loop, at the level that actually runs it: the review session
      // finishing satisfies the same `on_done` trigger that started it.
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-review");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
      });

      const reactor = yield* TessayaOrchestrationReactor;
      yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });
      const second = yield* reactor.evaluate({ workSessionId, changedThreadId: reviewThreadId });

      assert.lengthOf(second, 0);
      assert.strictEqual(yield* ruleCount(id), 1);
    }).pipe(
      Effect.provide(harness({ startProviderSession: () => Effect.succeed(reviewThreadId) })),
    ),
  );

  it.effect("fires once on a state that persists, and again when it is re-entered", () =>
    Effect.gen(function* () {
      // The defect this closes: a work session sitting idle re-fired every
      // `on_done` rule on every unrelated thread event, up to the bound. The
      // bound contained it, and D20 already said what a bound is — a safety
      // net, not a schedule.
      currentThread = finishedThread;
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-transition");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
      });

      const reactor = yield* TessayaOrchestrationReactor;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });
      }
      assert.strictEqual(yield* ruleCount(id), 1);

      // Out of the matching state: nothing fires, and nothing is armed.
      currentThread = workingThread;
      yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });
      assert.strictEqual(yield* ruleCount(id), 1);

      // Back into it: a real transition, and a second firing.
      currentThread = finishedThread;
      yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });
      assert.strictEqual(yield* ruleCount(id), 2);
    }).pipe(
      Effect.provide(
        harness({
          startProviderSession: () =>
            Effect.sync(() => {
              started += 1;
              return ThreadId.make(`review-transition-${started}`);
            }),
        }),
      ),
    ),
  );

  it.effect("stops at the bound however many times the work finishes", () =>
    Effect.gen(function* () {
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-bounded");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
        maxFirings: 2,
      });

      const reactor = yield* TessayaOrchestrationReactor;
      // Six real finishes: in and out of the matching state each time, so the
      // transition rule cannot be what stops it.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        currentThread = attempt % 2 === 0 ? finishedThread : workingThread;
        yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });
      }

      // Six finishes, two firings. The bound is durable — it is the persisted
      // count, not a counter that a restart would reset.
      assert.strictEqual(yield* ruleCount(id), 2);
      const listed = yield* rules.list({ workSessionId, includeDisabled: true });
      assert.strictEqual(listed.find((entry) => entry.rule.id === id)?.rule.status, "exhausted");
    }).pipe(
      // A fresh thread id each time, so nothing is refused for self-triggering
      // and the bound is the only thing that can stop it.
      Effect.provide(
        harness({
          startProviderSession: () =>
            Effect.sync(() => {
              started += 1;
              return ThreadId.make(`review-${started}`);
            }),
        }),
      ),
    ),
  );

  it.effect("records a skip, not a failure, when the named account cannot run here", () =>
    Effect.gen(function* () {
      // D21: this environment has a Codex provider configured and no `codex`
      // binary. The live run created a dead thread and a synopsis full of a
      // spawn stack trace before the action learned to refuse first.
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-unavailable");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
      });

      const reactor = yield* TessayaOrchestrationReactor;
      const fired = yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });

      assert.lengthOf(fired, 1);
      assert.strictEqual(fired[0]?.outcome, "skipped");
      assert.isNull(fired[0]?.producedThreadId ?? null);
      assert.include(fired[0]?.detail ?? "", "not available on this environment");
    }).pipe(Effect.provide(harness({ startProviderSession: () => Effect.succeed(null) }))),
  );

  it.effect("spends the bound even when the action raises", () =>
    Effect.gen(function* () {
      // Recorded before the action runs, on purpose: a rule whose action
      // reliably fails would otherwise retry forever, which is the loop
      // wearing a different hat.
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const id = OrchestrationRuleId.make("rule-raises");
      yield* rules.create({
        id,
        workSessionId,
        trigger: { kind: "on_done" },
        action: reviewAction,
      });

      const reactor = yield* TessayaOrchestrationReactor;
      const fired = yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });

      assert.strictEqual(fired[0]?.outcome, "failed");
      assert.strictEqual(yield* ruleCount(id), 1);
    }).pipe(
      Effect.provide(
        harness({ startProviderSession: () => Effect.die(new Error("provider exploded")) }),
      ),
    ),
  );

  it.effect("parks a confirmation gate and holds what is queued behind it", () =>
    Effect.gen(function* () {
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const gate = OrchestrationRuleId.make("rule-gate");
      const queued = OrchestrationRuleId.make("rule-queued");
      yield* rules.create({
        id: gate,
        workSessionId,
        trigger: { kind: "on_done" },
        action: { kind: "confirmation_gate", question: "Start the review?" },
      });
      yield* rules.create({
        id: queued,
        workSessionId,
        trigger: { kind: "after_rule", ruleId: gate },
        action: { kind: "notify", message: "the review is running" },
      });

      const reactor = yield* TessayaOrchestrationReactor;
      const fired = yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });

      // One firing, awaiting an answer. Nothing behind the gate ran, which is
      // the entire reason the step exists.
      assert.lengthOf(fired, 1);
      assert.strictEqual(fired[0]?.outcome, "awaiting_confirmation");
      assert.strictEqual(yield* ruleCount(queued), 0);
    }).pipe(Effect.provide(harness({}))),
  );

  it.effect("does not re-ask the question it was asked to release", () =>
    Effect.gen(function* () {
      // From the live run: answering a gate re-evaluates the work session so
      // that whatever was queued behind it can run — and the gate's own rule
      // matched the same unchanged state, so a second question appeared in the
      // same second the first was answered.
      yield* givenFinishedWork;
      const rules = yield* OrchestrationRuleService;
      const gate = OrchestrationRuleId.make("rule-gate-rearm");
      yield* rules.create({
        id: gate,
        workSessionId,
        trigger: { kind: "on_done" },
        action: { kind: "confirmation_gate", question: "Restart the worker?" },
      });

      const reactor = yield* TessayaOrchestrationReactor;
      const asked = yield* reactor.evaluate({ workSessionId, changedThreadId: implThreadId });
      assert.strictEqual(asked[0]?.outcome, "awaiting_confirmation");

      const releasing = yield* reactor.evaluate({
        workSessionId,
        changedThreadId: null,
        skipRuleId: gate,
      });
      assert.lengthOf(releasing, 0);
      assert.strictEqual(yield* ruleCount(gate), 1);
    }).pipe(Effect.provide(harness({}))),
  );

  it.effect("evaluates nothing for a work session that does not exist", () =>
    Effect.gen(function* () {
      const reactor = yield* TessayaOrchestrationReactor;
      const fired = yield* reactor.evaluate({
        workSessionId: WorkSessionId.make("ws-never-created"),
        changedThreadId: implThreadId,
      });
      assert.lengthOf(fired, 0);
    }).pipe(Effect.provide(harness({}))),
  );
});
