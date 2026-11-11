/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Bounded orchestration: "when Claude finishes this, have Codex review it".
 *
 * §22's framing and its limits are the whole design. This is a graph over work
 * sessions, **not** unrestricted agent self-replication, and V1 deliberately
 * does not build a generalised autonomous scheduler. Concretely that means
 * three things, all enforced by this module and the reactor that reads it:
 *
 *   1. **A rule fires on an event the environment already reported.** Never on
 *      a model's opinion that something looks finished. The triggers below map
 *      onto the same `BatonSessionState` transitions §10 derives
 *      deterministically, so "done" means what the fleet says it means.
 *   2. **A rule has a hard firing bound.** `maxFirings`, default 3, counted per
 *      work session and per rule, and a rule can never be re-triggered by its
 *      own effect. §22's "no hidden infinite loops" is not an aspiration here;
 *      it is two counters and an origin check.
 *   3. **Anything the user must approve is a step, not a side effect.** A
 *      `confirmation_gate` action parks the chain and waits, visibly, instead
 *      of a rule quietly doing the thing and telling you afterwards.
 *
 * @module baton/orchestrationRule
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TrimmedString } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RuntimeMode } from "@t3tools/contracts";
import { WorkSessionId, WorkSessionProviderRole } from "./workSession.ts";
import { renamedKind } from "./renamed.ts";

export const OrchestrationRuleId = TrimmedNonEmptyString.pipe(Schema.brand("OrchestrationRuleId"));
export type OrchestrationRuleId = typeof OrchestrationRuleId.Type;

export const OrchestrationFiringId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrchestrationFiringId"),
);
export type OrchestrationFiringId = typeof OrchestrationFiringId.Type;

/**
 * §22's V1 trigger set, and nothing beyond it.
 *
 * `after` is the sequencing trigger: this rule runs once another rule has
 * completed. It is how "have Codex review it, then tell me" becomes two
 * inspectable rules rather than one opaque script.
 */
export const OrchestrationTrigger = Schema.Union([
  Schema.Struct({
    /** The work session's own state reached `done_unseen` or `idle` after a turn. */
    kind: Schema.Literal("on_done"),
  }),
  Schema.Struct({
    /** Its state reached `needs_approval` or `needs_input`. */
    kind: Schema.Literal("on_needs_user"),
  }),
  Schema.Struct({
    /** Its state reached `failed`. */
    kind: Schema.Literal("on_failed"),
  }),
  Schema.Struct({
    kind: Schema.Literal("after_rule"),
    ruleId: OrchestrationRuleId,
  }),
]);
export type OrchestrationTrigger = typeof OrchestrationTrigger.Type;

/**
 * What the rule does when it fires.
 *
 * `start_provider_session` is the one that costs money and creates work, which
 * is why it names the account explicitly rather than "some reviewer": the user
 * must be able to read a rule and know which subscription it will spend.
 */
export const OrchestrationAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start_provider_session"),
    providerInstanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString,
    role: WorkSessionProviderRole,
    /** The new thread's permission policy. A reviewer runs read-only by default. */
    runtimeMode: RuntimeMode,
    /** The opening message. Empty means the thread is created and left idle. */
    prompt: TrimmedString,
    title: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("message_active_implementation_session"),
    /** Text prepended to whatever the rule includes. */
    prompt: TrimmedString,
    /**
     * What travels with the message. `review_findings` is the §22 example:
     * the reviewer's answer goes back to the implementer. Nothing else is
     * forwarded, because a rule that could ship arbitrary context would be a
     * quiet channel out of a work session.
     */
    include: Schema.Literals(["nothing", "review_findings"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("notify"),
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    /**
     * Park and wait for the user. The chain stops here until someone confirms,
     * which is what makes a high-risk step visible rather than a side effect
     * (§24.2: a wake word alone never authorises a high-risk action, and nor
     * does a rule).
     */
    kind: Schema.Literal("confirmation_gate"),
    question: TrimmedNonEmptyString,
  }),
]);
export type OrchestrationAction = typeof OrchestrationAction.Type;

/**
 * A conditional follow-up on the result of the action, for §22's
 * "if Codex finds a blocking issue, send it back to Claude".
 *
 * `review_result` is the only condition V1 understands, and it is read from
 * the review thread's own outcome rather than from a model's judgement of the
 * text.
 */
export const OrchestrationFollowUp = Schema.Struct({
  on: Schema.Struct({
    kind: Schema.Literal("review_result"),
    value: Schema.Literals(["blocking_findings", "no_blocking_findings"]),
  }),
  action: OrchestrationAction,
});
export type OrchestrationFollowUp = typeof OrchestrationFollowUp.Type;

export const OrchestrationRuleStatus = Schema.Literals(["enabled", "disabled", "exhausted"]);
export type OrchestrationRuleStatus = typeof OrchestrationRuleStatus.Type;

/** The default loop bound. Three is enough for implement → review → fix. */
export const DEFAULT_MAX_FIRINGS = 3;

export const OrchestrationRule = Schema.Struct({
  id: OrchestrationRuleId,
  workSessionId: WorkSessionId,
  /** The sentence the user typed or said, kept verbatim so a rule is readable. */
  source: TrimmedString,
  trigger: OrchestrationTrigger,
  action: OrchestrationAction,
  followUp: Schema.NullOr(OrchestrationFollowUp),
  status: OrchestrationRuleStatus,
  /** Hard bound. A rule that reaches it becomes `exhausted` and stops. */
  maxFirings: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  firedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastFiredAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationRule = typeof OrchestrationRule.Type;

export const OrchestrationFiringOutcome = Schema.Literals([
  "started",
  "completed",
  "skipped",
  "awaiting_confirmation",
  "failed",
]);
export type OrchestrationFiringOutcome = typeof OrchestrationFiringOutcome.Type;

/**
 * One recorded firing. Durable, because "why did a thread appear?" must be
 * answerable later, and because the timeline in the UI is read from these.
 */
export const OrchestrationFiring = Schema.Struct({
  id: OrchestrationFiringId,
  ruleId: OrchestrationRuleId,
  workSessionId: WorkSessionId,
  /** The state transition that fired it, for "why now?". */
  triggeredBy: TrimmedNonEmptyString,
  outcome: OrchestrationFiringOutcome,
  /** What it produced: a thread id for a started session, else null. */
  producedThreadId: Schema.NullOr(ThreadId),
  detail: TrimmedString,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationFiring = typeof OrchestrationFiring.Type;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const ruleCanFire = (rule: OrchestrationRule): boolean =>
  rule.status === "enabled" && rule.firedCount < rule.maxFirings;

/**
 * A rule must never be re-triggered by its own effect. The reactor passes the
 * thread its action produced (if any) and the thread whose state just changed;
 * when they are the same, the firing is refused.
 *
 * This is the concrete half of §22's "no hidden infinite loops": a review
 * session finishing would otherwise satisfy the same `on_done` trigger that
 * started it, forever.
 */
export const wouldSelfTrigger = (input: {
  readonly firings: ReadonlyArray<Pick<OrchestrationFiring, "producedThreadId">>;
  readonly changedThreadId: string | null;
}): boolean =>
  input.changedThreadId !== null &&
  input.firings.some((firing) => firing.producedThreadId === input.changedThreadId);

// ---------------------------------------------------------------------------
// RPC payloads
// ---------------------------------------------------------------------------

export const OrchestrationRuleCreateInput = Schema.Struct({
  id: OrchestrationRuleId,
  workSessionId: WorkSessionId,
  source: Schema.optionalKey(TrimmedString),
  trigger: OrchestrationTrigger,
  action: OrchestrationAction,
  followUp: Schema.optionalKey(Schema.NullOr(OrchestrationFollowUp)),
  maxFirings: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type OrchestrationRuleCreateInput = typeof OrchestrationRuleCreateInput.Type;

export const OrchestrationRuleListInput = Schema.Struct({
  workSessionId: Schema.optionalKey(WorkSessionId),
  includeDisabled: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationRuleListInput = typeof OrchestrationRuleListInput.Type;

/** A rule with the firings that make it inspectable. */
export const OrchestrationRuleWithFirings = Schema.Struct({
  rule: OrchestrationRule,
  /** Newest first, bounded by the server. */
  firings: Schema.Array(OrchestrationFiring),
});
export type OrchestrationRuleWithFirings = typeof OrchestrationRuleWithFirings.Type;

export const OrchestrationRuleListResult = Schema.Struct({
  rules: Schema.Array(OrchestrationRuleWithFirings),
});
export type OrchestrationRuleListResult = typeof OrchestrationRuleListResult.Type;

export const OrchestrationRuleRefInput = Schema.Struct({ id: OrchestrationRuleId });
export type OrchestrationRuleRefInput = typeof OrchestrationRuleRefInput.Type;

export const OrchestrationRuleResult = Schema.Struct({ rule: OrchestrationRule });
export type OrchestrationRuleResult = typeof OrchestrationRuleResult.Type;

/** Answering a `confirmation_gate`. */
export const OrchestrationConfirmInput = Schema.Struct({
  firingId: OrchestrationFiringId,
  confirmed: Schema.Boolean,
});
export type OrchestrationConfirmInput = typeof OrchestrationConfirmInput.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OrchestrationRuleNotFoundError extends Schema.TaggedError<OrchestrationRuleNotFoundError>()(
  "OrchestrationRuleNotFoundError",
  { ruleId: OrchestrationRuleId },
) {
  override get message(): string {
    return `Orchestration rule ${this.ruleId} was not found on this environment.`;
  }
}

export class OrchestrationFiringNotFoundError extends Schema.TaggedError<OrchestrationFiringNotFoundError>()(
  "OrchestrationFiringNotFoundError",
  { firingId: OrchestrationFiringId },
) {
  override get message(): string {
    return `Orchestration firing ${this.firingId} was not found, or is no longer waiting.`;
  }
}

export class OrchestrationRuleStorageError extends Schema.TaggedError<OrchestrationRuleStorageError>()(
  "OrchestrationRuleStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Orchestration rule storage failed during ${this.operation}.`;
  }
}

export const OrchestrationRuleError = Schema.Union([
  OrchestrationRuleNotFoundError,
  OrchestrationFiringNotFoundError,
  OrchestrationRuleStorageError,
]);
export type OrchestrationRuleError = typeof OrchestrationRuleError.Type;

// ---------------------------------------------------------------------------
// Events (§28)
// ---------------------------------------------------------------------------

export const OrchestrationRuleStreamItem = Schema.Union([
  Schema.Struct({
    kind: renamedKind("fabric.orchestration.ruleCreated"),
    rule: OrchestrationRule,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.orchestration.ruleTriggered"),
    rule: OrchestrationRule,
    firing: OrchestrationFiring,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.orchestration.ruleCompleted"),
    rule: OrchestrationRule,
    firing: OrchestrationFiring,
  }),
]);
export type OrchestrationRuleStreamItem = typeof OrchestrationRuleStreamItem.Type;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * One line describing what a rule will do, for the UI and for reading a rule
 * back to the user before it runs. Deliberately mechanical: a rule that reads
 * well but does something else is worse than one that reads awkwardly.
 */
export const describeRule = (rule: OrchestrationRule): string => {
  const when =
    rule.trigger.kind === "on_done"
      ? "When this finishes"
      : rule.trigger.kind === "on_needs_user"
        ? "When this needs you"
        : rule.trigger.kind === "on_failed"
          ? "When this fails"
          : "After the previous rule";
  return `${when}, ${describeAction(rule.action)}.`;
};

export const describeAction = (action: OrchestrationAction): string => {
  switch (action.kind) {
    case "start_provider_session":
      return `start ${action.providerInstanceId} as ${action.role}`;
    case "message_active_implementation_session":
      return action.include === "review_findings"
        ? "send the review findings back to the implementer"
        : "message the implementer";
    case "notify":
      return `tell me: ${action.message}`;
    case "confirmation_gate":
      return `ask first: ${action.question}`;
  }
};

export const DEFAULT_FIRINGS_PER_RULE = 10;

export const EMPTY_RULE = (input: {
  readonly id: OrchestrationRuleId;
  readonly workSessionId: WorkSessionId;
  readonly trigger: OrchestrationTrigger;
  readonly action: OrchestrationAction;
  readonly at: string;
}): OrchestrationRule => ({
  id: input.id,
  workSessionId: input.workSessionId,
  source: "",
  trigger: input.trigger,
  action: input.action,
  followUp: null,
  status: "enabled",
  maxFirings: DEFAULT_MAX_FIRINGS,
  firedCount: 0,
  createdAt: input.at,
  updatedAt: input.at,
  lastFiredAt: null,
});

// Legacy names (D71): wire method names keep "fabric." so installed clients keep working.
export const BATON_ORCHESTRATION_WS_METHODS = {
  ruleCreate: "fabric.orchestration.rule.create",
  ruleList: "fabric.orchestration.rule.list",
  ruleDisable: "fabric.orchestration.rule.disable",
  ruleEnable: "fabric.orchestration.rule.enable",
  ruleConfirm: "fabric.orchestration.rule.confirm",
} as const;
