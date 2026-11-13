/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The intent surface end to end inside the environment: a sentence, the real
 * grammar, the real work sessions and rules, the real executor, and the log
 * that has to remember all of it.
 *
 * Only two things are stubbed, and both for the same reason a route test stubs
 * them — they reach outside this environment: `OrchestrationEffects` (which
 * would start and message real provider threads) and the projection/registry
 * pair (which would need a running engine). Everything between the words and
 * those edges is the code that ships.
 */
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkSessionId,
  type OrchestrationProjectShell,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ThreadId as ThreadIdType,
} from "@t3tools/baton-contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { at, v2Shell } from "./__fixtures__/v2ThreadShell.ts";
import { BatonEngine } from "./BatonEngine.ts";
import { BatonOneShot, BatonOneShotError } from "./BatonOneShot.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import { AdoptedRuntimeAdapter, layer as adoptedSessionLayer } from "./AdoptedSessionService.ts";
import { layer as intentExecutorLayer } from "./IntentExecutorLive.ts";
import { AskSource } from "./BatonPhoneInbox.ts";
import { ThreadAccountMoves } from "./ThreadAccountMoves.ts";
import { BatonIntentService, layer as intentServiceLayer } from "./IntentService.ts";
import { BatonOrchestrationReactor, OrchestrationEffectsService } from "./OrchestrationReactor.ts";
import { layer as ruleServiceLayer, OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import { layer as workSessionLayer, WorkSessionService } from "./WorkSessionService.ts";

const projectId = ProjectId.make("project-vantageos");
const workSessionId = WorkSessionId.make("ws-scheduler");
const implThreadId = ThreadId.make("impl-thread");
const claude = ProviderInstanceId.make("claude-a");
const startedThreadId = ThreadId.make("rule-started-thread");

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "VantageOS",
  workspaceRoot: "/workspace/vantageos",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: null,
  createdAt: "2026-09-18T04:00:00.000Z",
  updatedAt: "2026-09-18T04:00:00.000Z",
};

/** One thread, blocked on an approval: the state §20's "what needs me" is for. */
const waitingThread: OrchestrationV2ThreadShell = v2Shell({
  id: implThreadId,
  projectId,
  title: "Implementation",
  status: "waiting",
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request-1"),
    kind: "command",
    createdAt: at("2026-09-18T05:00:20.000Z"),
    blocking: true,
  },
});

const provider = {
  instanceId: claude,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude A",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  continuation: { groupKey: "claude:home:/home/dev/.claude" },
  checkedAt: "2026-09-18T05:00:00.000Z",
  models: [{ slug: "claude-sonnet", label: "Sonnet" }],
  slashCommands: [],
  skills: [],
} as unknown as ServerProvider;

/** Another account sharing claude-a's transcripts, so a thread can resume on it. */
const optima = {
  ...provider,
  instanceId: ProviderInstanceId.make("claudeAgent_optima"),
  displayName: "Optima",
  usageLimits: {
    checkedAt: "2026-09-18T05:00:00.000Z",
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 10 }],
  },
} as unknown as ServerProvider;

/** A third account whose limits nobody has read yet. */
const sable = {
  ...provider,
  instanceId: ProviderInstanceId.make("claudeAgent_sable"),
  displayName: "Sable",
} as unknown as ServerProvider;

interface Sent {
  readonly threadId: string;
  readonly text: string;
}

const harness = Effect.gen(function* () {
  const sent = yield* Ref.make<ReadonlyArray<Sent>>([]);
  const started = yield* Ref.make(0);

  const effects = Layer.succeed(OrchestrationEffectsService, {
    startProviderSession: () =>
      Ref.update(started, (count) => count + 1).pipe(Effect.as(startedThreadId)),
    messageThread: (input: { readonly threadId: ThreadIdType; readonly text: string }) =>
      Ref.update(sent, (all) => [...all, { threadId: input.threadId, text: input.text }]).pipe(
        Effect.as(true),
      ),
    notify: () => Effect.void,
    refusal: () => Effect.succeed(null),
    noteRun: () => Effect.void,
  });

  return { sent, started, effects };
});

/**
 * What the model would answer, when a test wants one.
 *
 * `null` means "this environment has no model read" — the shape of a stock
 * install, and the state every pre-D50 test in this file assumes. A reply means
 * the grammar's refusal gets a second reader, exactly as it does on a real
 * machine with an account configured.
 */
type ModelReply = Record<string, unknown> | null;

const textGenerationLayer = (reply: ModelReply, calls: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(BatonOneShot, {
    run: ((input: { readonly prompt: string }) =>
      reply === null
        ? Effect.fail(new BatonOneShotError({ detail: "no model on this environment" }))
        : Ref.update(calls, (all) => [...all, input.prompt]).pipe(
            Effect.as(reply as never),
          )) as BatonOneShot["Service"]["run"],
  });

/** `requested` records which thread the intent asked to move, and where. */
const requested: Array<string> = [];
const movesLayer = Layer.mock(ThreadAccountMoves)({
  request: (input) => {
    requested.push(`${input.threadId}->${input.instanceId}`);
    return Effect.succeed({ instanceId: input.instanceId, timing: "now" as const });
  },
});

const baseLayer = (
  effects: Layer.Layer<OrchestrationEffectsService>,
  model: { readonly reply: ModelReply; readonly calls: Ref.Ref<ReadonlyArray<string>> },
) =>
  intentServiceLayer.pipe(
    Layer.provide(textGenerationLayer(model.reply, model.calls)),
    Layer.provideMerge(intentExecutorLayer),
    Layer.provide(effects),
    Layer.provide(
      Layer.succeed(BatonOrchestrationReactor, {
        start: () => Effect.void,
        drain: Effect.void,
        evaluate: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        workSessionLayer,
        ruleServiceLayer,
        // The fleet now includes adopted sessions (§9). None is registered
        // here, and the runtime is not installed, so every answer is the
        // refusal a machine without Herdr gives.
        adoptedSessionLayer.pipe(
          Layer.provide(
            Layer.succeed(AdoptedRuntimeAdapter, {
              discover: Effect.succeed({
                available: false,
                reason: "herdr is not installed on this environment.",
                candidates: [],
              }),
              sendInput: () =>
                Effect.succeed({
                  delivered: false,
                  detail: "herdr is not installed on this environment.",
                }),
              readOutput: () =>
                Effect.succeed({
                  available: false,
                  detail: "herdr is not installed on this environment.",
                  output: "",
                }),
            }),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(BatonEngine)({
        projects: Effect.succeed([project]),
        threadShells: Effect.succeed([waitingThread]),
        threadShell: (threadId) =>
          Effect.succeed(threadId === waitingThread.id ? waitingThread : null),
        changedThreads: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider, optima, sable]) }),
    ),
    Layer.provide(movesLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

/** One piece of work with one live thread on it, as the fleet would see it. */
const givenWork = Effect.gen(function* () {
  const workSessions = yield* WorkSessionService;
  yield* workSessions.create({
    id: workSessionId,
    projectId,
    title: "Scheduler reconnect race",
  });
  yield* workSessions.attachThread({
    id: workSessionId,
    threadId: implThreadId,
    providerInstanceId: claude,
    providerDriver: ProviderDriverKind.make("claudeAgent"),
    role: "implementation",
    origin: "created",
  });
});

const run = <A, E>(
  body: (context: {
    readonly sent: Ref.Ref<ReadonlyArray<Sent>>;
    readonly modelPrompts: Ref.Ref<ReadonlyArray<string>>;
  }) => Effect.Effect<A, E, BatonIntentService | WorkSessionService | OrchestrationRuleService>,
  modelReply: ModelReply = null,
) =>
  Effect.gen(function* () {
    const { sent, effects } = yield* harness;
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    return yield* body({ sent, modelPrompts: calls }).pipe(
      Effect.provide(baseLayer(effects, { reply: modelReply, calls })),
    );
  });

describe("a sentence the grammar cannot place (D50)", () => {
  /** What a model would answer for "poke the scheduler and ask where it got to". */
  const pokeReply = {
    kind: "message_work_session",
    statusQuestion: null,
    workSessionId: "ws-scheduler",
    projectId: null,
    providerInstanceId: null,
    title: null,
    message: "where did you get to?",
    firingId: null,
    confirmed: null,
    description: "Tell Scheduler reconnect race: where did you get to?",
    confidence: "high",
    question: null,
  };

  it.effect("is refused, exactly as before, when the environment has no model read", () =>
    run(({ modelPrompts }) =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const resolution = yield* intents.resolve({
          text: "poke the scheduler and ask where it got to",
          focusedWorkSessionId: null,
        });

        assert.strictEqual(resolution.outcome, "refused");
        // Nothing was asked of anything: the grammar's own refusal stands, and
        // a stock install behaves exactly as it did before D50.
        assert.deepStrictEqual(yield* Ref.get(modelPrompts), []);
      }),
    ),
  );

  it.effect("is read by a model, and the reading is recorded as the model's", () =>
    run(
      ({ sent, modelPrompts }) =>
        Effect.gen(function* () {
          yield* givenWork;
          const intents = yield* BatonIntentService;
          const result = yield* intents.run({
            text: "poke the scheduler and ask where it got to",
            focusedWorkSessionId: null,
          });

          assert.strictEqual(result.resolution.outcome, "resolved");
          assert.strictEqual(result.record.commandKind, "message_work_session");
          assert.strictEqual(result.record.source, "model");
          // The routing table's unset `intent` row: no server settings in this test.
          assert.strictEqual(result.record.model, "haiku");

          // The user's words reached the thread, not a paraphrase of them.
          assert.deepStrictEqual(yield* Ref.get(sent), [
            { threadId: implThreadId, text: "where did you get to?" },
          ]);

          // The prompt carried the ids it was allowed to use, and no thread
          // contents.
          const prompts = yield* Ref.get(modelPrompts);
          assert.strictEqual(prompts.length, 1);
          assert.include(prompts[0] ?? "", "ws-scheduler");
          assert.include(prompts[0] ?? "", "claude-a");
        }),
      pokeReply,
    ),
  );

  it.effect("never re-reads a high-risk sentence, whatever a model would say", () =>
    run(
      ({ sent, modelPrompts }) =>
        Effect.gen(function* () {
          yield* givenWork;
          const intents = yield* BatonIntentService;
          const result = yield* intents.run({
            text: "deploy the scheduler to production",
            focusedWorkSessionId: null,
          });

          assert.strictEqual(result.resolution.outcome, "refused");
          assert.strictEqual(result.record.refusalReason, "high_risk");
          assert.strictEqual(result.record.source, "grammar");
          // §24.1 before the model: the sentence never reached it, and nothing
          // was sent anywhere.
          assert.deepStrictEqual(yield* Ref.get(modelPrompts), []);
          assert.deepStrictEqual(yield* Ref.get(sent), []);
        }),
      pokeReply,
    ),
  );

  it.effect("refuses a model reading that names work this environment does not have", () =>
    run(
      ({ sent }) =>
        Effect.gen(function* () {
          yield* givenWork;
          const intents = yield* BatonIntentService;
          const result = yield* intents.run({
            text: "poke the other scheduler",
            focusedWorkSessionId: null,
          });

          assert.strictEqual(result.resolution.outcome, "refused");
          assert.strictEqual(result.record.refusalReason, "unknown_target");
          // The refusal is recorded as the model's reading, because that is
          // what happened, and nothing was sent.
          assert.strictEqual(result.record.source, "model");
          assert.deepStrictEqual(yield* Ref.get(sent), []);
        }),
      { ...pokeReply, workSessionId: "ws-invented", message: "hello" },
    ),
  );
});

describe("the intent surface", () => {
  it.effect(
    "moves the focused work's threads to the account he names, and refuses one it cannot find",
    () =>
      run(() =>
        Effect.gen(function* () {
          requested.length = 0;
          yield* givenWork;
          const intents = yield* BatonIntentService;
          const known = yield* intents.run({
            text: "switch account to Optima",
            focusedWorkSessionId: workSessionId,
          });
          assert.include(known.reply, "now runs as Optima");
          assert.deepStrictEqual(requested, ["impl-thread->claudeAgent_optima"]);

          // Asked by hand, an account whose limits are unread may still be chosen.
          yield* intents.run({
            text: "use the sable account",
            focusedWorkSessionId: workSessionId,
          });
          assert.strictEqual(requested.at(-1), "impl-thread->claudeAgent_sable");

          const unknown = yield* Effect.flip(
            intents.run({ text: "use the nobody account", focusedWorkSessionId: workSessionId }),
          );
          assert.include(String(unknown), "There is no account called nobody");
          assert.strictEqual(requested.length, 2);
        }),
      ).pipe(Effect.provideService(AskSource, "phone")),
  );

  it.effect("never moves work to another account for a token's device", () =>
    run(() =>
      Effect.gen(function* () {
        requested.length = 0;
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const refused = yield* Effect.flip(
          intents.run({ text: "switch account to Optima", focusedWorkSessionId: workSessionId }),
        );
        assert.include(String(refused), "needs him");
        assert.strictEqual(requested.length, 0);
      }),
    ),
  );

  it.effect("answers §20's question from the fleet, and records that it did", () =>
    run(() =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const result = yield* intents.run({ text: "What needs me?", focusedWorkSessionId: null });

        assert.strictEqual(result.resolution.outcome, "resolved");
        // The answer comes from the same states the fleet reports — the thread
        // is blocked on an approval, so that is what it says.
        assert.include(result.reply, "waiting for approval");
        assert.include(result.reply, "Scheduler reconnect race");
        assert.strictEqual(result.record.commandKind, "status_fleet");
        assert.strictEqual(result.record.outcome, "resolved");

        const logged = yield* intents.list({ workSessionId: null, limit: null });
        assert.lengthOf(logged, 1);
        assert.strictEqual(logged[0]?.text, "What needs me?");
      }),
    ),
  );

  it.effect("passes a message to the work's own session, in the user's words", () =>
    run(({ sent }) =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const result = yield* intents.run({
          text: "Tell the scheduler reconnect race to run the migration tests too",
          focusedWorkSessionId: null,
        });

        assert.strictEqual(result.record.commandKind, "message_work_session");
        assert.strictEqual(result.record.workSessionId, workSessionId);
        const delivered = yield* Ref.get(sent);
        assert.deepStrictEqual(delivered, [
          { threadId: implThreadId, text: "run the migration tests too" },
        ]);
      }),
    ),
  );

  it.effect("creates §22's rules from one sentence and sequences them", () =>
    run(() =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const result = yield* intents.run({
          text: "When Claude finishes this, have Claude review it and tell me if either needs me.",
          focusedWorkSessionId: workSessionId,
        });

        assert.strictEqual(result.record.commandKind, "create_rules");
        const rules = yield* OrchestrationRuleService;
        const listed = yield* rules.list({ workSessionId });
        assert.lengthOf(listed, 2);
        assert.deepStrictEqual(listed[0]?.rule.trigger, { kind: "on_done" });
        // The second rule waits for the first by its real id, which only exists
        // once the first has been created.
        assert.strictEqual(listed[1]?.rule.trigger.kind, "after_rule");
        if (listed[1]?.rule.trigger.kind === "after_rule") {
          assert.strictEqual(listed[1].rule.trigger.ruleId, listed[0]?.rule.id);
        }
      }),
    ),
  );

  it.effect("records a refusal as carefully as a success, and starts nothing", () =>
    run(({ sent }) =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const result = yield* intents.run({
          text: "Deploy to production",
          focusedWorkSessionId: workSessionId,
        });

        assert.strictEqual(result.resolution.outcome, "refused");
        assert.strictEqual(result.record.outcome, "refused");
        assert.strictEqual(result.record.refusalReason, "high_risk");
        assert.isNull(result.record.commandKind);
        // Nothing reached a provider. A refusal that still did something would
        // be the worst of both answers.
        assert.lengthOf(yield* Ref.get(sent), 0);

        const logged = yield* intents.list({ workSessionId: null, limit: null });
        assert.lengthOf(logged, 1);
        assert.strictEqual(logged[0]?.refusalReason, "high_risk");
      }),
    ),
  );

  it.effect("resolves without doing or recording anything", () =>
    run(({ sent }) =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        const resolution = yield* intents.resolve({
          text: "Tell the scheduler reconnect race to stop",
          focusedWorkSessionId: null,
        });

        assert.strictEqual(resolution.outcome, "resolved");
        // A preview is a preview: no message, no row. This is what the input
        // calls on every keystroke.
        assert.lengthOf(yield* Ref.get(sent), 0);
        assert.lengthOf(
          yield* (yield* BatonIntentService).list({ workSessionId: null, limit: null }),
          0,
        );
      }),
    ),
  );

  it.effect("says it could not, rather than pretending it did", () =>
    run(() =>
      Effect.gen(function* () {
        // Work with no live session: "would not" and "could not" are different
        // answers and the log keeps them apart.
        const workSessions = yield* WorkSessionService;
        yield* workSessions.create({
          id: WorkSessionId.make("ws-empty"),
          projectId,
          title: "Nothing running",
        });
        const intents = yield* BatonIntentService;
        const outcome = yield* intents
          .run({ text: "Tell nothing running to stop", focusedWorkSessionId: null })
          .pipe(Effect.result);

        assert.strictEqual(outcome._tag, "Failure");
        const logged = yield* intents.list({ workSessionId: null, limit: null });
        assert.strictEqual(logged[0]?.outcome, "failed");
        assert.include(logged[0]?.reply ?? "", "no session running");
      }),
    ),
  );

  it.effect("lists one work session's intents, newest first", () =>
    run(() =>
      Effect.gen(function* () {
        yield* givenWork;
        const intents = yield* BatonIntentService;
        yield* intents.run({ text: "What needs me?", focusedWorkSessionId: null });
        yield* intents.run({
          text: "Tell the scheduler reconnect race to run the tests",
          focusedWorkSessionId: null,
        });

        const mine = yield* intents.list({ workSessionId, limit: null });
        assert.lengthOf(mine, 1);
        assert.strictEqual(mine[0]?.commandKind, "message_work_session");
        const all = yield* intents.list({ workSessionId: null, limit: null });
        assert.lengthOf(all, 2);
        assert.strictEqual(all[0]?.commandKind, "message_work_session");
      }),
    ),
  );
});
