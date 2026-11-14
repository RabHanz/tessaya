/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The deterministic synopsis updater.
 *
 * §11.1: update from events whenever possible. Everything here is a pure
 * function of a signal the environment already reported — a tool started, a
 * file changed, a test finished, an approval was requested, a turn settled.
 * Nothing infers, nothing summarises, nothing calls a model.
 *
 * The server maps orchestration activities onto `SynopsisSignal` and folds
 * them; the clients never need to, because they read the stored synopsis. The
 * mapping lives here rather than in the reactor so the interesting half — what
 * each signal does to the record — can be tested without a database.
 *
 * @module batonSynopsis
 */
import {
  EMPTY_SYNOPSIS,
  SYNOPSIS_MAX_CHANGED_FILES,
  SYNOPSIS_MAX_FINDINGS,
  SYNOPSIS_MAX_NEXT,
  SYNOPSIS_MAX_VALIDATION,
  type SynopsisValidation,
  type WorkSessionSynopsis,
} from "@t3tools/tessaya-contracts";

import { applyModelSynopsis } from "./synopsisModel.ts";

/**
 * The §11.1 list, normalised. One variant per thing the specification names as
 * a deterministic trigger, plus `written` — the one milestone where a model is
 * allowed to say it better (D51).
 */
export type SynopsisSignal =
  /**
   * Two sentences from a model, at a completed turn. It arrives as a signal
   * rather than through a second service method so there stays exactly one
   * write path, with one staleness rule and one place to read when a synopsis
   * looks wrong.
   */
  | {
      readonly kind: "written";
      readonly at: string;
      readonly currentAction: string;
      readonly next: string;
    }
  | { readonly kind: "turn-started"; readonly at: string; readonly prompt: string | null }
  | { readonly kind: "turn-completed"; readonly at: string }
  | { readonly kind: "turn-failed"; readonly at: string; readonly reason: string | null }
  | { readonly kind: "tool-started"; readonly at: string; readonly label: string }
  | { readonly kind: "files-changed"; readonly at: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "validation-started"; readonly at: string; readonly label: string }
  | {
      readonly kind: "validation-finished";
      readonly at: string;
      readonly label: string;
      readonly passed: boolean;
    }
  | { readonly kind: "approval-requested"; readonly at: string; readonly label: string }
  | { readonly kind: "approval-resolved"; readonly at: string }
  | { readonly kind: "question-asked"; readonly at: string; readonly label: string }
  | { readonly kind: "question-answered"; readonly at: string }
  | { readonly kind: "plan-step"; readonly at: string; readonly step: string }
  | { readonly kind: "pull-request-opened"; readonly at: string; readonly label: string }
  | {
      readonly kind: "background-changed";
      readonly at: string;
      readonly liveness: "working" | "monitoring" | null;
    }
  | { readonly kind: "goal-set"; readonly at: string; readonly goal: string }
  | {
      readonly kind: "finding";
      readonly at: string;
      readonly text: string;
      readonly source: "events" | "model";
    };

const trimmed = (value: string): string => value.trim();
const nonEmpty = (value: string): string | null => {
  const text = trimmed(value);
  return text.length === 0 ? null : text;
};

/** Most recent first, de-duplicated, bounded. */
const pushFront = <A>(
  list: ReadonlyArray<A>,
  entry: A,
  limit: number,
  same: (left: A, right: A) => boolean,
): ReadonlyArray<A> =>
  [entry, ...list.filter((existing) => !same(existing, entry))].slice(0, limit);

const withValidation = (
  list: ReadonlyArray<SynopsisValidation>,
  entry: SynopsisValidation,
): ReadonlyArray<SynopsisValidation> =>
  pushFront(list, entry, SYNOPSIS_MAX_VALIDATION, (left, right) => left.label === right.label);

/**
 * Fold one signal into the synopsis.
 *
 * Signals that carry no usable text return the record untouched *including its
 * timestamp*: bumping `updatedAt` for an event that changed nothing would make
 * a stale synopsis look fresh, which is the one failure §11 calls out.
 */
export function applySynopsisSignal(
  synopsis: WorkSessionSynopsis,
  signal: SynopsisSignal,
): WorkSessionSynopsis {
  const touched = (next: Partial<WorkSessionSynopsis>): WorkSessionSynopsis => ({
    ...synopsis,
    ...next,
    updatedAt: signal.at,
    updatedBy: signal.kind,
  });

  switch (signal.kind) {
    case "written":
      // Delegated so the rule about what a model may and may not change lives
      // in one file, next to the prompt that asks for it.
      return applyModelSynopsis(synopsis, {
        currentAction: signal.currentAction,
        next: signal.next,
        at: signal.at,
      });
    case "turn-started": {
      const prompt = signal.prompt === null ? null : nonEmpty(signal.prompt);
      return touched({
        currentAction: prompt === null ? "Starting a turn" : firstSentence(prompt),
        needsUser: false,
      });
    }
    case "turn-completed":
      // The provider stopped; it is not doing anything until told otherwise.
      // Saying "Running tests" after a turn ended is the stale-label failure.
      return touched({ currentAction: null, needsUser: false });
    case "turn-failed": {
      const reason = signal.reason === null ? null : nonEmpty(signal.reason);
      return touched({
        currentAction: null,
        needsUser: true,
        recentFindings:
          reason === null
            ? synopsis.recentFindings
            : pushFront(
                synopsis.recentFindings,
                { text: reason, observedAt: signal.at, source: "events" as const },
                SYNOPSIS_MAX_FINDINGS,
                (left, right) => left.text === right.text,
              ),
      });
    }
    case "tool-started": {
      const label = nonEmpty(signal.label);
      return label === null ? synopsis : touched({ currentAction: label });
    }
    case "files-changed": {
      const paths = signal.paths.map(trimmed).filter((path) => path.length > 0);
      if (paths.length === 0) return synopsis;
      const changedFiles = paths.reduce<ReadonlyArray<string>>(
        (list, path) =>
          pushFront(list, path, SYNOPSIS_MAX_CHANGED_FILES, (left, right) => left === right),
        synopsis.changedFiles,
      );
      return touched({ changedFiles });
    }
    case "validation-started": {
      const label = nonEmpty(signal.label);
      return label === null
        ? synopsis
        : touched({
            currentAction: label,
            validation: withValidation(synopsis.validation, {
              label,
              outcome: "running",
              observedAt: signal.at,
            }),
          });
    }
    case "validation-finished": {
      const label = nonEmpty(signal.label);
      return label === null
        ? synopsis
        : touched({
            validation: withValidation(synopsis.validation, {
              label,
              outcome: signal.passed ? "passed" : "failed",
              observedAt: signal.at,
            }),
          });
    }
    case "approval-requested": {
      const label = nonEmpty(signal.label);
      return touched({
        needsUser: true,
        currentAction: label === null ? "Waiting for approval" : `Waiting for approval: ${label}`,
      });
    }
    case "question-asked": {
      const label = nonEmpty(signal.label);
      return touched({
        needsUser: true,
        currentAction: label === null ? "Waiting for an answer" : `Asked: ${label}`,
      });
    }
    case "approval-resolved":
    case "question-answered":
      return touched({ needsUser: false });
    case "plan-step": {
      const step = nonEmpty(signal.step);
      return step === null ? synopsis : touched({ currentAction: step });
    }
    case "pull-request-opened": {
      const label = nonEmpty(signal.label);
      return label === null
        ? synopsis
        : touched({
            next: pushFront(
              synopsis.next,
              `Review ${label}`,
              SYNOPSIS_MAX_NEXT,
              (left, right) => left === right,
            ),
          });
    }
    case "background-changed":
      return touched({
        currentAction:
          signal.liveness === "working"
            ? "Background work running"
            : signal.liveness === "monitoring"
              ? "Watching for changes"
              : null,
      });
    case "goal-set": {
      const goal = nonEmpty(signal.goal);
      return goal === null ? synopsis : touched({ goal });
    }
    case "finding": {
      const text = nonEmpty(signal.text);
      return text === null
        ? synopsis
        : touched({
            source: signal.source,
            recentFindings: pushFront(
              synopsis.recentFindings,
              { text, observedAt: signal.at, source: signal.source },
              SYNOPSIS_MAX_FINDINGS,
              (left, right) => left.text === right.text,
            ),
          });
    }
  }
}

export const applySynopsisSignals = (
  synopsis: WorkSessionSynopsis,
  signals: ReadonlyArray<SynopsisSignal>,
): WorkSessionSynopsis => signals.reduce(applySynopsisSignal, synopsis);

export const emptySynopsis = EMPTY_SYNOPSIS;

/** First sentence, capped: a synopsis line is a glance, not a prompt. */
function firstSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const stop = collapsed.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? collapsed : collapsed.slice(0, stop + 1);
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
}

/**
 * Map one orchestration activity onto a signal, or null when it is not one of
 * §11.1's triggers. Kept beside the reducer because the two have to agree
 * about what a "validation" is.
 *
 * Activity kinds come from the orchestration decider (`tool.started`,
 * `approval.requested`, …). Unknown kinds return null rather than guessing:
 * a fork adding an activity kind must not silently start rewriting synopses.
 */
export function synopsisSignalForActivity(activity: {
  readonly kind: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly payload?: unknown;
}): SynopsisSignal | null {
  const at = activity.createdAt;
  switch (activity.kind) {
    case "approval.requested":
      return { kind: "approval-requested", at, label: activity.summary };
    case "approval.resolved":
      return { kind: "approval-resolved", at };
    case "user-input.requested":
      return { kind: "question-asked", at, label: activity.summary };
    case "user-input.resolved":
    case "user-input.answer-submitted":
      return { kind: "question-answered", at };
    case "turn.plan.updated":
      return { kind: "plan-step", at, step: activity.summary };
    case "runtime.error":
      return { kind: "finding", at, text: activity.summary, source: "events" };
    case "tool.started":
    case "task.started": {
      const label = activity.summary;
      return isValidationLabel(label)
        ? { kind: "validation-started", at, label }
        : { kind: "tool-started", at, label };
    }
    case "tool.completed":
    case "task.completed": {
      const label = activity.summary;
      if (!isValidationLabel(label)) return null;
      const failed = /\bfail|\berror|\bnot ok\b/i.test(label);
      return { kind: "validation-finished", at, label, passed: !failed };
    }
    default:
      return null;
  }
}

/**
 * What counts as validation. Deliberately narrow and lexical: the alternative
 * is asking a model what a command was for, on every tool call, which §11
 * forbids and which would cost more than the field is worth.
 */
const VALIDATION_PATTERN = /\b(test|tests|typecheck|lint|check|build|vitest|jest|pytest|spec)\b/i;
export const isValidationLabel = (label: string): boolean => VALIDATION_PATTERN.test(label);
