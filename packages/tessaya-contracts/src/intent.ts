/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Intent: one sentence in, one Baton command out.
 *
 * §13's model, built where it can actually be relied on. The Director's north
 * star is that he speaks into whatever microphone is nearest — iOS dictation,
 * Wispr Flow, a DJI receiver through his own speech-to-text — and the fleet
 * does the thing. **The fork owns everything after the text exists.** No
 * microphone, no wake word, no speech model lives here; a phone's dictation
 * and a keyboard produce the same string, and this is what that string means.
 *
 * Three properties hold, and they are the whole reason this is a contract
 * rather than a prompt:
 *
 *   1. **Deterministic first, and deterministic last** (§13: "do not feed every
 *      transcript blindly into an LLM"). A grammar decides what a sentence
 *      means whenever it can, instantly and identically every time. A sentence
 *      the grammar cannot place is read by a model (D50), which must answer in
 *      *this* schema — naming ids that exist — and whose answer is checked by
 *      the same deterministic rules on the way out. The user is still told
 *      exactly what will happen before it happens; that read-back is now the
 *      thing that makes a model on this path safe rather than a shortcut.
 *   2. **A refusal names the words it could not place.** Guessing is the one
 *      behaviour that makes a voice surface untrustworthy: a misheard sentence
 *      that starts a provider session is worse than one that does nothing.
 *   3. **A sentence never authorises a high-risk action** (§24.2). The
 *      classifier recognises §24.1's HIGH list explicitly and refuses it by
 *      name, rather than failing to parse it and saying something vague.
 *
 * @module baton/intent
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString, TrimmedString } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  OrchestrationAction,
  OrchestrationFiringId,
  OrchestrationTrigger,
} from "./orchestrationRule.ts";
import { WorkSessionId } from "./workSession.ts";
import { renamedKind } from "./renamed.ts";

// Legacy names (D71): wire method names keep "fabric." so installed clients keep working.
export const BATON_INTENT_WS_METHODS = {
  /** Resolve without doing anything. What the input shows you before Enter. */
  intentResolve: "fabric.intent.resolve",
  intentRun: "fabric.intent.run",
  intentList: "fabric.intent.list",
} as const;

export const BatonIntentId = TrimmedNonEmptyString.pipe(Schema.brand("FabricIntentId"));
export type BatonIntentId = typeof BatonIntentId.Type;

/**
 * §24.1's classes, as they apply to a sentence rather than to a task.
 *
 * `high` exists to be refused. Nothing this surface can do is high-risk; the
 * class is here so that a sentence which *asks* for one is recognised and named
 * instead of falling through to "I did not understand that", which would teach
 * the user to rephrase until something happened.
 */
export const BatonIntentRisk = Schema.Literals(["low", "medium", "high"]);
export type BatonIntentRisk = typeof BatonIntentRisk.Type;

/** Which of §20's questions a fleet-wide status request is asking. */
export const BatonStatusQuestion = Schema.Literals([
  "needs_me",
  "running",
  "finished",
  "everything",
]);
export type BatonStatusQuestion = typeof BatonStatusQuestion.Type;

/**
 * One rule a sentence asked for, before ids exist.
 *
 * Structurally the parser's `ParsedRule`. It crosses the wire because the
 * preview has to show the user the rules a sentence would create *before* they
 * are created — a rule that appears without having been read back is exactly
 * what §22 is trying to avoid.
 */
export const BatonIntentRuleDraft = Schema.Struct({
  trigger: OrchestrationTrigger,
  action: OrchestrationAction,
  /** True when this rule runs after the one before it in the list. */
  afterPrevious: Schema.Boolean,
  maxFirings: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});
export type BatonIntentRuleDraft = typeof BatonIntentRuleDraft.Type;

/**
 * What the sentence resolved to. Every member names its target by id: the
 * grammar does the resolving, so execution never re-interprets words.
 */
export const BatonIntentCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("status_fleet"),
    question: BatonStatusQuestion,
  }),
  Schema.Struct({
    kind: Schema.Literal("status_work_session"),
    workSessionId: WorkSessionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("message_work_session"),
    workSessionId: WorkSessionId,
    /** Exactly what the user said after the target, not a paraphrase. */
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("start_work_session"),
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    /** A second provider session on work that already exists. Not a handoff. */
    kind: Schema.Literal("resume_work_session"),
    workSessionId: WorkSessionId,
    providerInstanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("create_rules"),
    workSessionId: WorkSessionId,
    rules: Schema.Array(BatonIntentRuleDraft),
    /**
     * The sentence, verbatim, so every rule it creates can be read back in the
     * words that made it. A rule whose source is empty is unreadable a week
     * later, which is the opposite of §22's inspectability.
     */
    source: TrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("answer_gate"),
    firingId: OrchestrationFiringId,
    confirmed: Schema.Boolean,
  }),
  /**
   * The one member that names its target in words: the executor matches the label against this
   * environment's Claude instances, and moves the work's threads to that one (L-76).
   */
  Schema.Struct({
    kind: Schema.Literal("switch_account"),
    accountLabel: TrimmedNonEmptyString,
    /** The work whose threads move. Absent on intents recorded before L-76. */
    workSessionId: Schema.optionalKey(Schema.NullOr(WorkSessionId)),
  }),
]);
export type BatonIntentCommand = typeof BatonIntentCommand.Type;

export const BatonIntentRefusalReason = Schema.Literals([
  /** Nothing in the grammar matched. */
  "unrecognised",
  /** §24.1 HIGH. A sentence never authorises one. */
  "high_risk",
  /** Understood, and belongs to a phase that is not built. */
  "not_available_yet",
  /** Named something this environment does not have. */
  "unknown_target",
  /** Several things matched and the difference matters (§14 rung 9). */
  "ambiguous_target",
  /** "Yes" with nothing waiting for an answer. */
  "nothing_to_confirm",
  /** The rule grammar refused; its own words come back in `unplaced`. */
  "rule_not_understood",
]);
export type BatonIntentRefusalReason = typeof BatonIntentRefusalReason.Type;

export const BatonIntentRefusal = Schema.Struct({
  reason: BatonIntentRefusalReason,
  /** The words the grammar could not place, verbatim. Never a summary. */
  unplaced: TrimmedString,
  /** What to say back. Written to be spoken as well as read. */
  message: TrimmedNonEmptyString,
});
export type BatonIntentRefusal = typeof BatonIntentRefusal.Type;

export const BatonIntentResolution = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("resolved"),
    command: BatonIntentCommand,
    /** One line, in the user's terms: "Tell Claude on Scheduler: run the tests." */
    description: TrimmedNonEmptyString,
    risk: BatonIntentRisk,
    /** The work this touches, when it touches one. */
    workSessionId: Schema.NullOr(WorkSessionId),
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    refusal: BatonIntentRefusal,
  }),
]);
export type BatonIntentResolution = typeof BatonIntentResolution.Type;

/**
 * Who read the sentence.
 *
 * Three answers, and the difference is the first thing anybody wants when a
 * sentence did something surprising:
 *
 *   - `grammar` — the deterministic parser matched. Instant, free, identical
 *     every time.
 *   - `learned` — the grammar did not match, but this exact phrasing has been
 *     resolved before and acted on, so the stored command answered it. Also
 *     instant and free, and still not a model call.
 *   - `model` — a model read it, in the schema above, against ids that exist,
 *     and the answer passed the same §24.1 check the grammar applies.
 *
 * Defaulted rather than required: every row written before D50 was the grammar,
 * and a default keeps that true without a backfill that invents history.
 */
export const BatonIntentSource = Schema.Literals(["grammar", "learned", "model"]);
export type BatonIntentSource = typeof BatonIntentSource.Type;

export const BatonIntentOutcome = Schema.Literals(["resolved", "refused", "failed"]);
export type BatonIntentOutcome = typeof BatonIntentOutcome.Type;

/**
 * One recorded intent. Durable, because "why did that thread appear?" and "what
 * did I ask it to do?" must be answerable after the fact — the same argument
 * that makes an orchestration firing durable.
 */
export const BatonIntentRecord = Schema.Struct({
  id: BatonIntentId,
  /** What the user said, verbatim. */
  text: TrimmedNonEmptyString,
  outcome: BatonIntentOutcome,
  /** The command's `kind`, or null when nothing resolved. */
  commandKind: Schema.NullOr(TrimmedNonEmptyString),
  workSessionId: Schema.NullOr(WorkSessionId),
  description: TrimmedString,
  /** The spoken reply, ready for any TTS the client has. */
  reply: TrimmedString,
  risk: BatonIntentRisk,
  refusalReason: Schema.NullOr(BatonIntentRefusalReason),
  at: IsoDateTime,
  source: BatonIntentSource.pipe(Schema.withDecodingDefault(Effect.succeed("grammar" as const))),
  /** The model that read it, when one did. Null for the grammar and for a learned phrasing. */
  model: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type BatonIntentRecord = typeof BatonIntentRecord.Type;

/**
 * The §28 event family for this surface.
 *
 * §28's sketch names these `fabric.voice.*`. They are `fabric.intent.*` here
 * because the same sentence arrives from dictation, a phone, a keyboard and a
 * future wake word, and naming the family after one transport would misdescribe
 * every other one. See the maintainers' decision log.
 */
export const BatonIntentEvent = Schema.Union([
  Schema.Struct({
    kind: renamedKind("fabric.intent.received"),
    id: BatonIntentId,
    text: TrimmedNonEmptyString,
    at: IsoDateTime,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.intent.resolved"),
    record: BatonIntentRecord,
  }),
  Schema.Struct({
    kind: renamedKind("fabric.intent.refused"),
    record: BatonIntentRecord,
  }),
]);
export type BatonIntentEvent = typeof BatonIntentEvent.Type;

// ---------------------------------------------------------------------------
// RPC payloads
// ---------------------------------------------------------------------------

export const BatonIntentInput = Schema.Struct({
  text: TrimmedNonEmptyString,
  /**
   * What the user is looking at. §14's ladder rung 3, and the only rung a
   * server can be told about: the environment has no idea what is focused
   * unless the client says so. Absent means "resolve from the utterance alone,
   * then from what moved most recently".
   */
  focusedWorkSessionId: Schema.optionalKey(Schema.NullOr(WorkSessionId)),
  /**
   * May a model read this sentence when the grammar cannot place it (D50)?
   *
   * Absent means no, which is what a live preview wants: it runs on every
   * pause in typing, and a model call per pause would spend the user's own
   * quota to describe a half-typed sentence. The client asks for a model
   * reading deliberately — on the first Enter — and the reading it is shown is
   * the one the second Enter runs.
   */
  allowModel: Schema.optionalKey(Schema.Boolean),
});
export type BatonIntentInput = typeof BatonIntentInput.Type;

export const BatonIntentResolveResult = Schema.Struct({
  resolution: BatonIntentResolution,
});
export type BatonIntentResolveResult = typeof BatonIntentResolveResult.Type;

export const BatonIntentRunResult = Schema.Struct({
  resolution: BatonIntentResolution,
  /** What to say back. Empty only when there is genuinely nothing to say. */
  reply: TrimmedString,
  record: BatonIntentRecord,
});
export type BatonIntentRunResult = typeof BatonIntentRunResult.Type;

export const BatonIntentListInput = Schema.Struct({
  workSessionId: Schema.optionalKey(WorkSessionId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type BatonIntentListInput = typeof BatonIntentListInput.Type;

export const BatonIntentListResult = Schema.Struct({
  /** Newest first. */
  intents: Schema.Array(BatonIntentRecord),
});
export type BatonIntentListResult = typeof BatonIntentListResult.Type;

/** How many intents a list returns when the caller does not say. */
export const DEFAULT_INTENT_LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BatonIntentStorageError extends Schema.TaggedError<BatonIntentStorageError>()(
  "FabricIntentStorageError",
  { operation: TrimmedNonEmptyString, detail: TrimmedString },
) {
  override get message(): string {
    return `Could not ${this.operation} the intent log: ${this.detail}`;
  }
}

/**
 * The sentence resolved and the command failed. Deliberately distinct from a
 * refusal: "I would not" and "I could not" are different answers, and a user
 * who cannot tell them apart cannot tell whether rephrasing would help.
 */
export class BatonIntentExecutionError extends Schema.TaggedError<BatonIntentExecutionError>()(
  "FabricIntentExecutionError",
  { commandKind: TrimmedNonEmptyString, detail: TrimmedString },
) {
  override get message(): string {
    return `Could not run ${this.commandKind}: ${this.detail}`;
  }
}

export const BatonIntentError = Schema.Union([BatonIntentStorageError, BatonIntentExecutionError]);
export type BatonIntentError = typeof BatonIntentError.Type;
