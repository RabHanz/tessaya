/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Bounded orchestration: deciding whether a rule may fire, recording that it
 * did, and refusing when it must not.
 *
 * The decision is deliberately kept out of the reactor and out of the action
 * executor, in `shouldFire` below, because it is the part where §22's "no
 * hidden infinite loops" is either enforced or lost, and it is the part worth
 * asserting on its own. Three refusals, each for a different failure:
 *
 *   - **the bound** — `firedCount` has reached `maxFirings`, so the rule is
 *     exhausted and says so rather than going quiet;
 *   - **self-triggering** — the state change came from a thread this rule's own
 *     firing created, which is the loop §22 names;
 *   - **sequencing** — an `after_rule` trigger whose predecessor has not
 *     completed.
 *
 * Nothing here consults a model. The trigger matches a `BatonSessionState`
 * the environment derived from its own events (§10), so "finished" means what
 * the fleet already says it means.
 */
import {
  DEFAULT_FIRINGS_PER_RULE,
  DEFAULT_MAX_FIRINGS,
  OrchestrationRuleNotFoundError,
  OrchestrationRuleStorageError,
  ruleCanFire,
  wouldSelfTrigger,
  type BatonSessionState,
  type OrchestrationFiring,
  type OrchestrationFiringId,
  type OrchestrationRule,
  type OrchestrationRuleCreateInput,
  type OrchestrationRuleError,
  type OrchestrationRuleId,
  type OrchestrationRuleListInput,
  type OrchestrationRuleStreamItem,
  type OrchestrationRuleWithFirings,
  type ThreadId,
  type WorkSessionId,
} from "@t3tools/tessaya-contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  layer as orchestrationRuleRepositoryLayer,
  OrchestrationRuleRepository,
  type OrchestrationFiringRow,
  type OrchestrationRuleRow,
} from "./OrchestrationRuleRepository.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Which derived states satisfy which trigger. The only mapping there is. */
export const triggerMatchesState = (
  trigger: OrchestrationRule["trigger"],
  state: BatonSessionState,
): boolean => {
  switch (trigger.kind) {
    case "on_done":
      // A turn that ended and left nothing demanding attention. `idle` counts
      // because a completion the user has already seen is still a completion.
      return state === "done_unseen" || state === "idle";
    case "on_needs_user":
      return state === "needs_approval" || state === "needs_input";
    case "on_failed":
      return state === "failed";
    case "after_rule":
      // Sequenced rules are fired by the predecessor completing, not by a
      // state change; `shouldFire` handles them separately.
      return false;
  }
};

export type FiringRefusal =
  | { readonly fire: true }
  | { readonly fire: false; readonly reason: "disabled" }
  | { readonly fire: false; readonly reason: "exhausted" }
  | { readonly fire: false; readonly reason: "would_self_trigger" }
  | { readonly fire: false; readonly reason: "trigger_not_matched" }
  | { readonly fire: false; readonly reason: "state_unchanged" }
  | { readonly fire: false; readonly reason: "predecessor_not_completed" };

/**
 * The whole safety decision, as a pure function over facts already gathered.
 *
 * Exported and tested directly: every value it can return is a refusal that
 * must be provable, and burying it inside a reactor would make "does the bound
 * actually hold?" a question about mocking an event stream.
 */
export function shouldFire(input: {
  readonly rule: OrchestrationRule;
  readonly state: BatonSessionState;
  /** The thread whose state changed, or null for a sequenced trigger. */
  readonly changedThreadId: ThreadId | null;
  /** Every firing recorded on this work session, including this rule's own. */
  readonly firings: ReadonlyArray<
    Pick<OrchestrationFiring, "ruleId" | "producedThreadId" | "outcome">
  >;
  /**
   * True when the work session **entered** this state; false when it was
   * already in it.
   *
   * A trigger names a transition, not a condition. "When Claude finishes this"
   * is about the moment it finishes, and a work session that sits idle for an
   * hour has not finished a hundred times. Without this, every thread event on
   * an idle work session re-fired every `on_done` rule until the bound stopped
   * it — the bound doing the work of a schedule again, exactly as D20 warned.
   */
  readonly stateChanged: boolean;
}): FiringRefusal {
  if (input.rule.status === "disabled") return { fire: false, reason: "disabled" };
  if (!ruleCanFire(input.rule)) return { fire: false, reason: "exhausted" };

  // A thread this work session's own rules created must never be what fires
  // them again. This is the loop, and it is checked before the trigger so a
  // matching state on a produced thread cannot slip past.
  if (wouldSelfTrigger({ firings: input.firings, changedThreadId: input.changedThreadId })) {
    return { fire: false, reason: "would_self_trigger" };
  }

  if (input.rule.trigger.kind === "after_rule") {
    const predecessorId = input.rule.trigger.ruleId;
    const completedByPredecessor = input.firings.filter(
      (firing) => firing.ruleId === predecessorId && firing.outcome === "completed",
    ).length;
    // Once per predecessor *completion*, not once per evaluation. "Has it
    // completed?" stays true forever, so a sequenced rule asked that question
    // fires on every subsequent event until its bound stops it — which is what
    // the live proof caught, with the bound doing the stopping. The bound is a
    // safety net; it is not the schedule.
    const own = input.firings.filter((firing) => firing.ruleId === input.rule.id).length;
    return own < completedByPredecessor
      ? { fire: true }
      : { fire: false, reason: "predecessor_not_completed" };
  }

  if (!triggerMatchesState(input.rule.trigger, input.state)) {
    return { fire: false, reason: "trigger_not_matched" };
  }
  // A rule that has never fired is allowed one firing on a state it finds
  // already true: "when this finishes, have it reviewed", said about work that
  // has just finished, must do something. After that it waits for the state to
  // be entered again.
  return input.stateChanged || input.rule.firedCount === 0
    ? { fire: true }
    : { fire: false, reason: "state_unchanged" };
}

const toRule = (row: OrchestrationRuleRow): OrchestrationRule => ({ ...row });
const toFiring = (row: OrchestrationFiringRow): OrchestrationFiring => ({ ...row });

export class OrchestrationRuleService extends Context.Service<
  OrchestrationRuleService,
  {
    readonly create: (
      input: OrchestrationRuleCreateInput,
    ) => Effect.Effect<OrchestrationRule, OrchestrationRuleError>;
    readonly list: (
      input: OrchestrationRuleListInput,
    ) => Effect.Effect<ReadonlyArray<OrchestrationRuleWithFirings>, OrchestrationRuleError>;
    readonly setStatus: (input: {
      readonly id: OrchestrationRuleId;
      readonly status: "enabled" | "disabled";
    }) => Effect.Effect<OrchestrationRule, OrchestrationRuleError>;
    /** Enabled rules for one work session, with the firings the bound needs. */
    readonly candidatesFor: (workSessionId: WorkSessionId) => Effect.Effect<
      {
        readonly rules: ReadonlyArray<OrchestrationRule>;
        readonly firings: ReadonlyArray<OrchestrationFiring>;
      },
      OrchestrationRuleError
    >;
    /** Record that a rule fired, bump its count, and announce it. */
    readonly beginFiring: (input: {
      readonly rule: OrchestrationRule;
      readonly triggeredBy: string;
    }) => Effect.Effect<OrchestrationFiring, OrchestrationRuleError>;
    readonly completeFiring: (input: {
      readonly firingId: OrchestrationFiringId;
      readonly outcome: OrchestrationFiring["outcome"];
      readonly producedThreadId: ThreadId | null;
      readonly detail: string;
    }) => Effect.Effect<OrchestrationFiring | null, OrchestrationRuleError>;
    readonly getFiring: (
      id: OrchestrationFiringId,
    ) => Effect.Effect<OrchestrationFiring | null, OrchestrationRuleError>;
    /**
     * Read and then record the state this work session is in, returning what it
     * was before. One call, because every caller wants both halves and doing
     * them separately invites an evaluation that reads a state it just wrote.
     */
    readonly observeState: (input: {
      readonly workSessionId: WorkSessionId;
      readonly state: BatonSessionState;
    }) => Effect.Effect<BatonSessionState | null, OrchestrationRuleError>;
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<OrchestrationRuleStreamItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/baton/OrchestrationRuleService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* OrchestrationRuleRepository;
  const events = yield* PubSub.unbounded<OrchestrationRuleStreamItem>();
  // Firing is a read-modify-write on the count that enforces the bound. Two
  // concurrent state changes must not both read "fired 2 of 3".
  const mutations = yield* Semaphore.make(1);

  const storageFailure = (operation: string) => (cause: ProjectionRepositoryError) =>
    new OrchestrationRuleStorageError({ operation, cause });

  const publish = (item: OrchestrationRuleStreamItem) =>
    PubSub.publish(events, item).pipe(Effect.asVoid);

  const requireRule = (id: OrchestrationRuleId) =>
    repository.getRule(id).pipe(
      Effect.mapError(storageFailure("getRule")),
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(new OrchestrationRuleNotFoundError({ ruleId: id }))
          : Effect.succeed(row),
      ),
    );

  const create: OrchestrationRuleService["Service"]["create"] = (input) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const timestamp = yield* nowIso;
        const row: OrchestrationRuleRow = {
          id: input.id,
          workSessionId: input.workSessionId,
          source: input.source ?? "",
          trigger: input.trigger,
          action: input.action,
          followUp: input.followUp ?? null,
          status: "enabled",
          maxFirings: input.maxFirings ?? DEFAULT_MAX_FIRINGS,
          firedCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastFiredAt: null,
        };
        const inserted = yield* repository
          .insertRule(row)
          .pipe(Effect.mapError(storageFailure("insertRule")));
        if (inserted === null) return toRule(yield* requireRule(input.id));
        const rule = toRule(inserted);
        yield* publish({ kind: "fabric.orchestration.ruleCreated", rule });
        return rule;
      }),
    );

  const list: OrchestrationRuleService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* repository
        .listRules({
          workSessionId: input.workSessionId ?? null,
          includeDisabled: input.includeDisabled ?? false,
        })
        .pipe(Effect.mapError(storageFailure("listRules")));
      return yield* Effect.forEach(rows, (row) =>
        repository.listFiringsForRule(row.id, DEFAULT_FIRINGS_PER_RULE).pipe(
          Effect.mapError(storageFailure("listFiringsForRule")),
          Effect.map((firings) => ({ rule: toRule(row), firings: firings.map(toFiring) })),
        ),
      );
    });

  const setStatus: OrchestrationRuleService["Service"]["setStatus"] = ({ id, status }) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const current = yield* requireRule(id);
        const updatedAt = yield* nowIso;
        const next: OrchestrationRuleRow = { ...current, status, updatedAt };
        yield* repository.updateRule(next).pipe(Effect.mapError(storageFailure("updateRule")));
        return toRule(next);
      }),
    );

  const candidatesFor: OrchestrationRuleService["Service"]["candidatesFor"] = (workSessionId) =>
    Effect.all({
      rules: repository.listEnabledForWorkSession(workSessionId).pipe(
        Effect.mapError(storageFailure("listEnabledForWorkSession")),
        Effect.map((rows) => rows.map(toRule)),
      ),
      firings: repository.listFiringsForWorkSession(workSessionId).pipe(
        Effect.mapError(storageFailure("listFiringsForWorkSession")),
        Effect.map((rows) => rows.map(toFiring)),
      ),
    });

  const beginFiring: OrchestrationRuleService["Service"]["beginFiring"] = ({ rule, triggeredBy }) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        // Re-read under the lock: the caller decided on a snapshot, and
        // between that decision and this write another change may have used
        // the last permitted firing.
        const current = yield* requireRule(rule.id);
        const startedAt = yield* nowIso;
        // The sequence number, not the timestamp. `firedCount` only ever
        // increases, it is read and written under this lock, and it survives a
        // restart — so it is unique per rule by construction, where
        // `${ruleId}:${startedAt}` collides the moment a rule fires twice
        // inside one millisecond, which two threads changing state in the same
        // tick will do.
        const sequence = current.firedCount + 1;
        const firing: OrchestrationFiringRow = {
          id: `${rule.id}#${sequence}` as never,
          ruleId: rule.id,
          workSessionId: rule.workSessionId,
          triggeredBy,
          outcome: "started",
          producedThreadId: null,
          detail: "",
          startedAt,
          completedAt: null,
        };
        yield* repository
          .insertFiring(firing)
          .pipe(Effect.mapError(storageFailure("insertFiring")));

        const next: OrchestrationRuleRow = {
          ...current,
          firedCount: sequence,
          lastFiredAt: startedAt,
          updatedAt: startedAt,
          // A rule that has spent its bound says so, rather than staying
          // "enabled" and silently never firing again.
          status: sequence >= current.maxFirings ? "exhausted" : current.status,
        };
        yield* repository.updateRule(next).pipe(Effect.mapError(storageFailure("updateRule")));
        yield* publish({
          kind: "fabric.orchestration.ruleTriggered",
          rule: toRule(next),
          firing: toFiring(firing),
        });
        return toFiring(firing);
      }),
    );

  const completeFiring: OrchestrationRuleService["Service"]["completeFiring"] = ({
    firingId,
    outcome,
    producedThreadId,
    detail,
  }) =>
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const current = yield* repository
          .getFiring(firingId)
          .pipe(Effect.mapError(storageFailure("getFiring")));
        if (current === null) return null;
        const completedAt = yield* nowIso;
        const next: OrchestrationFiringRow = {
          ...current,
          outcome,
          producedThreadId,
          detail,
          // A gate is not finished; it is waiting. Stamping it complete would
          // let a sequenced rule run before the user answered.
          completedAt: outcome === "awaiting_confirmation" ? null : completedAt,
        };
        yield* repository.updateFiring(next).pipe(Effect.mapError(storageFailure("updateFiring")));
        const rule = yield* requireRule(current.ruleId);
        yield* publish({
          kind: "fabric.orchestration.ruleCompleted",
          rule: toRule(rule),
          firing: toFiring(next),
        });
        return toFiring(next);
      }),
    );

  const getFiring: OrchestrationRuleService["Service"]["getFiring"] = (id) =>
    repository.getFiring(id).pipe(
      Effect.mapError(storageFailure("getFiring")),
      Effect.map((row) => (row === null ? null : toFiring(row))),
    );

  const observeState: OrchestrationRuleService["Service"]["observeState"] = ({
    workSessionId,
    state,
  }) =>
    // Under the same permit as firing: two evaluations racing here would both
    // read the old state and both call it a transition.
    Semaphore.withPermit(
      mutations,
      Effect.gen(function* () {
        const previous = yield* repository
          .getObservedState(workSessionId)
          .pipe(Effect.mapError(storageFailure("getObservedState")));
        if (previous !== state) {
          const observedAt = yield* nowIso;
          yield* repository
            .setObservedState({ workSessionId, state, observedAt })
            .pipe(Effect.mapError(storageFailure("setObservedState")));
        }
        return previous;
      }),
    );

  return {
    create,
    list,
    setStatus,
    candidatesFor,
    beginFiring,
    completeFiring,
    getFiring,
    observeState,
    subscribe: PubSub.subscribe(events),
  } satisfies OrchestrationRuleService["Service"];
});

/** Snapshot then events, subscribing before the read so nothing is lost. */
export const orchestrationRuleStream = (
  service: OrchestrationRuleService["Service"],
): Stream.Stream<OrchestrationRuleStreamItem, OrchestrationRuleError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      return Stream.fromSubscription(subscription);
    }),
  ).pipe(Stream.scoped);

export const layer = Layer.effect(OrchestrationRuleService, make).pipe(
  Layer.provideMerge(orchestrationRuleRepositoryLayer),
);
