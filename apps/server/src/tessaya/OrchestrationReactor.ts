/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Evaluates orchestration rules, on the same events Phase 4's state derivation
 * reads.
 *
 * The reactor's only judgement is arithmetic: it computes the work session's
 * `TessayaSessionState` with the shared derivation, asks `shouldFire` whether a
 * rule may run, and runs it. **No model decides that anything finished.** That
 * matters more here than anywhere else in Baton, because a wrong "it's done"
 * starts a provider session and spends a subscription.
 *
 * Two ordering choices worth naming:
 *
 *   - **The state is recomputed, not taken from the event.** A single thread
 *     event does not tell you what the *work* is doing when two threads are
 *     live, and a rule that fired on one thread finishing while its sibling
 *     was still failing would be firing on the wrong fact.
 *   - **A firing is recorded before its action runs.** If the action crashes,
 *     the bound has still been spent. The alternative — record on success —
 *     lets a rule whose action reliably fails retry forever, which is the loop
 *     wearing a different hat.
 */
import {
  deriveTessayaSessionState,
  deriveWorkSessionState,
  type TessayaSessionState,
  type OrchestrationAction,
  type OrchestrationFiring,
  type OrchestrationRule,
  type OrchestrationRuleId,
  type ThreadId,
  type WorkSessionId,
} from "@t3tools/tessaya-contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { TessayaEngine, tessayaStateInputFromShell } from "./TessayaEngine.ts";
import { forkParked } from "../serverActivation.ts";
import { shouldFire } from "./OrchestrationRuleService.ts";
import { OrchestrationRuleService } from "./OrchestrationRuleService.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

/**
 * What a rule's action needs from the rest of the server. Injected rather than
 * imported so the reactor can be tested without an orchestration engine, and
 * so the one place that creates threads stays visible.
 */
export interface OrchestrationEffects {
  readonly startProviderSession: (input: {
    readonly workSessionId: WorkSessionId;
    readonly action: Extract<OrchestrationAction, { kind: "start_provider_session" }>;
  }) => Effect.Effect<ThreadId | null>;
  readonly messageThread: (input: {
    readonly threadId: ThreadId;
    readonly text: string;
  }) => Effect.Effect<boolean>;
  readonly notify: (input: {
    readonly workSessionId: WorkSessionId;
    readonly message: string;
  }) => Effect.Effect<void>;
  /** A rule is the lead's standing job: why One Trust will not let the lead run its action by itself, or null. */
  readonly refusal: (action: OrchestrationAction) => Effect.Effect<string | null>;
  /** Each firing goes to the Record under its owner, the one timeline every standing job is counted in. */
  readonly noteRun: (rule: OrchestrationRule, firing: OrchestrationFiring) => Effect.Effect<void>;
}

export class TessayaOrchestrationReactor extends Context.Service<
  TessayaOrchestrationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Evaluate one work session now. The reactor's own unit of work. */
    readonly evaluate: (input: {
      readonly workSessionId: WorkSessionId;
      readonly changedThreadId: ThreadId | null;
      /**
       * A rule to leave alone in this pass.
       *
       * Used when the evaluation was *caused* by answering that rule's own
       * confirmation gate: re-evaluating exists to release what was queued
       * behind the question, and firing the question's own rule again re-asks
       * it the moment it is answered. The live run did exactly that — confirm,
       * and a second `awaiting_confirmation` appeared in the same second.
       */
      readonly skipRuleId?: OrchestrationRuleId | null;
    }) => Effect.Effect<ReadonlyArray<OrchestrationFiring>>;
  }
>()("t3/tessaya/OrchestrationReactor/TessayaOrchestrationReactor") {}

export class OrchestrationEffectsService extends Context.Service<
  OrchestrationEffectsService,
  OrchestrationEffects
>()("t3/tessaya/OrchestrationReactor/OrchestrationEffectsService") {}

interface Pending {
  readonly workSessionId: WorkSessionId;
  readonly changedThreadId: ThreadId | null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* TessayaEngine;
  const workSessions = yield* WorkSessionService;
  const rules = yield* OrchestrationRuleService;
  const effects = yield* OrchestrationEffectsService;

  /**
   * The work session's state, recomputed from its live threads. Deliberately
   * the same derivation the fleet uses: two answers to "is this done?" would
   * be one answer too many.
   */
  const currentState = (workSessionId: WorkSessionId) =>
    Effect.gen(function* () {
      const workSession = yield* workSessions
        .get(workSessionId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (workSession === null) return null;
      const live = workSession.providerSessions.filter((session) => session.detachedAt === null);
      const states: TessayaSessionState[] = [];
      for (const providerSession of live) {
        const thread = yield* engine.threadShell(providerSession.threadId);
        if (thread === null) continue;
        states.push(deriveTessayaSessionState(tessayaStateInputFromShell(thread)));
      }
      return deriveWorkSessionState(states);
    });

  const runAction = (input: {
    readonly rule: OrchestrationRule;
    readonly firing: OrchestrationFiring;
  }) =>
    Effect.gen(function* () {
      const action = input.rule.action;
      const refused = yield* effects.refusal(action);
      if (refused !== null)
        return { outcome: "skipped" as const, threadId: null, detail: `Held: ${refused}` };
      switch (action.kind) {
        case "start_provider_session": {
          const threadId = yield* effects.startProviderSession({
            workSessionId: input.rule.workSessionId,
            action,
          });
          return threadId === null
            ? {
                // Not "failed": most often the named account is not installed
                // or is switched off on this environment, which is a correct
                // reason to do nothing rather than a fault to alarm about.
                outcome: "skipped" as const,
                threadId: null,
                detail: `${action.providerInstanceId} is not available on this environment.`,
              }
            : {
                outcome: "completed" as const,
                threadId,
                detail: `Started ${action.providerInstanceId} as ${action.role}.`,
              };
        }
        case "message_active_implementation_session": {
          const workSession = yield* workSessions
            .get(input.rule.workSessionId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          const target = workSession?.activeThreadId ?? null;
          if (target === null) {
            return {
              outcome: "skipped" as const,
              threadId: null,
              detail: "No active implementation session to message.",
            };
          }
          const sent = yield* effects.messageThread({ threadId: target, text: action.prompt });
          return sent
            ? {
                outcome: "completed" as const,
                threadId: target,
                detail: "Messaged the implementer.",
              }
            : { outcome: "failed" as const, threadId: null, detail: "Could not send the message." };
        }
        case "notify": {
          yield* effects.notify({
            workSessionId: input.rule.workSessionId,
            message: action.message,
          });
          return { outcome: "completed" as const, threadId: null, detail: action.message };
        }
        case "confirmation_gate":
          // Park. Nothing downstream runs until a human answers, which is the
          // entire point of the step existing.
          return {
            outcome: "awaiting_confirmation" as const,
            threadId: null,
            detail: action.question,
          };
      }
    });

  const evaluate: TessayaOrchestrationReactor["Service"]["evaluate"] = ({
    workSessionId,
    changedThreadId,
    skipRuleId,
  }) =>
    Effect.gen(function* () {
      const state = yield* currentState(workSessionId);
      if (state === null) return [];
      const { rules: candidates, firings } = yield* rules
        .candidatesFor(workSessionId)
        .pipe(Effect.catchCause(() => Effect.succeed({ rules: [], firings: [] })));

      // Read the previous state and record this one, in that order and before
      // anything fires. A trigger names a transition, so what matters is where
      // the work session *was*; recording first means an action that crashes
      // cannot leave the same transition lying around to be found again.
      const previousState = yield* rules
        .observeState({ workSessionId, state })
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      const stateChanged = previousState !== state;

      const fired: OrchestrationFiring[] = [];
      for (const rule of candidates) {
        if (skipRuleId !== undefined && skipRuleId !== null && rule.id === skipRuleId) continue;
        const decision = shouldFire({ rule, state, changedThreadId, firings, stateChanged });
        if (!decision.fire) continue;

        // Recorded before the action runs: a rule whose action reliably fails
        // must still spend its bound, or it retries forever.
        const firing = yield* rules
          .beginFiring({ rule, triggeredBy: `${rule.trigger.kind}:${state}` })
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (firing === null) continue;

        const result = yield* runAction({ rule, firing }).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              outcome: "failed" as const,
              threadId: null,
              detail: "The action raised.",
            }),
          ),
        );
        const completed = yield* rules
          .completeFiring({
            firingId: firing.id,
            outcome: result.outcome,
            producedThreadId: result.threadId,
            detail: result.detail,
          })
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        yield* effects.noteRun(rule, completed ?? firing);
        fired.push(completed ?? firing);
      }
      return fired;
    });

  const worker = yield* makeDrainableWorker((pending: Pending) =>
    evaluate(pending).pipe(
      // Orchestration is a convenience layered on the work. A failure here must
      // never take down the event loop that carries the work itself.
      Effect.ignoreCause({ log: true }),
      Effect.asVoid,
    ),
  );

  const start: TessayaOrchestrationReactor["Service"]["start"] = Effect.fn(
    "BatonOrchestrationReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.changedThreads, (threadId) =>
        workSessions.findForThread(threadId).pipe(
          Effect.catchCause(() => Effect.succeed(null)),
          Effect.flatMap((workSessionId) =>
            workSessionId === null
              ? Effect.void
              : worker.enqueue({ workSessionId, changedThreadId: threadId }),
          ),
        ),
      ),
    );
  });

  return { start, drain: worker.drain, evaluate } satisfies TessayaOrchestrationReactor["Service"];
});

export const layer = Layer.effect(TessayaOrchestrationReactor, make);
