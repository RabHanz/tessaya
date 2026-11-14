/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Keeps each work session's Working Synopsis current, from the orchestration
 * event log alone.
 *
 * §11.1's deterministic triggers, mapped onto the events T3 actually emits:
 *
 * | §11.1 trigger            | orchestration event            |
 * | ------------------------ | ------------------------------ |
 * | turn completed           | `thread.turn-diff-completed`   |
 * | file changed             | `thread.turn-diff-completed`   |
 * | test started / completed | `thread.activity-appended`     |
 * | approval requested       | `thread.activity-appended`     |
 * | provider question        | `thread.activity-appended`     |
 * | plan step changed        | `thread.activity-appended`     |
 * | background started/stop  | `thread.session-set`           |
 * | PR opened                | `thread.pull-request-linked`   |
 *
 * A turn *starting* comes from `thread.message-sent`, which carries the user's
 * words; `thread.turn-start-requested` carries only ids.
 *
 * §11 allows semantic summarisation at milestones, and since D51 this reactor
 * does it — at exactly one milestone, a completed turn, and at most once per
 * turn. Everything else stays assembled from events: the model writes the two
 * sentences that say where the work is and what is needed, and decides nothing.
 * `needsUser` in particular remains derived, because a model guessing "needs
 * approval" is a model deciding whether to interrupt a person.
 *
 * When no account here can write one — no provider, a driver without the
 * capability, a failed call — the deterministic synopsis stands. It is the
 * older, plainer answer, and it is never wrong about the facts.
 */
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/tessaya-contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import type { SynopsisSignal } from "@t3tools/tessaya-shared/synopsis";
import {
  buildSynopsisPrompt,
  SYNOPSIS_TURN_WINDOW,
  type SynopsisTurn,
} from "@t3tools/tessaya-shared/synopsisModel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { TessayaEngine } from "./TessayaEngine.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { WorkSessionService } from "./WorkSessionService.ts";

export class TessayaSynopsisReactor extends Context.Service<
  TessayaSynopsisReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/tessaya/SynopsisReactor/TessayaSynopsisReactor") {}

interface Pending {
  readonly threadId: ThreadId;
  readonly dedupeKey: string;
  readonly signals: ReadonlyArray<SynopsisSignal>;
  /** Set only for a completed turn, which is the one milestone that is written. */
  /** The run that completed; a synopsis is written once per run. */
  readonly completedTurnId?: string | undefined;
}

/**
 * What one of upstream's v2 domain events tells the synopsis, if anything. Pure, so the mapping
 * is tested without an engine. Message events repeat as a message streams; only user messages
 * are read, and the reactor drops a message id it has already seen.
 */
export function synopsisSignalsForEvent(event: OrchestrationV2DomainEvent): Pending | null {
  const at = DateTime.formatIso(event.occurredAt);
  switch (event.type) {
    case "message.updated": {
      const message = event.payload;
      if (message.role !== "user" || message.text.trim().length === 0) return null;
      return {
        threadId: event.threadId,
        dedupeKey: `message:${message.id}`,
        signals: [{ kind: "turn-started", at, prompt: message.text }],
      };
    }
    case "run.updated": {
      const run = event.payload;
      if (run.status === "completed") {
        return {
          threadId: event.threadId,
          dedupeKey: `run:${run.id}:completed`,
          completedTurnId: run.id,
          signals: [{ kind: "turn-completed", at }],
        };
      }
      if (run.status === "failed") {
        return {
          threadId: event.threadId,
          dedupeKey: `run:${run.id}:failed`,
          signals: [{ kind: "turn-failed", at, reason: null }],
        };
      }
      return null;
    }
    case "runtime-request.updated": {
      const request = event.payload;
      const question = request.kind === "user_input";
      if (request.status === "pending") {
        return {
          threadId: event.threadId,
          dedupeKey: `request:${request.id}:pending`,
          signals: [
            question
              ? { kind: "question-asked", at, label: "A question for you" }
              : { kind: "approval-requested", at, label: `Approve ${request.kind}` },
          ],
        };
      }
      if (request.status === "resolved") {
        return {
          threadId: event.threadId,
          dedupeKey: `request:${request.id}:resolved`,
          signals: [
            question ? { kind: "question-answered", at } : { kind: "approval-resolved", at },
          ],
        };
      }
      return null;
    }
    case "thread.pull-request-link-updated": {
      const link = event.payload;
      return {
        threadId: event.threadId,
        dedupeKey: `pr:${link.repository}#${link.number}`,
        signals: [{ kind: "pull-request-opened", at, label: `${link.repository}#${link.number}` }],
      };
    }
    default:
      return null;
  }
}

export const make = Effect.gen(function* () {
  const engine = yield* TessayaEngine;
  const workSessions = yield* WorkSessionService;
  const oneShot = yield* TessayaOneShot;

  /**
   * Keys already handled: run ids for "written once per turn" (the Director's own wording),
   * message and request ids because v2 re-emits an updated record. Bounded, because this is a
   * running server: a thousand turns later nobody asks whether turn one was written.
   */
  const SEEN_LIMIT = 512;
  const seen = new Set<string>();
  const markSeen = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next();
      if (oldest.done === true) break;
      seen.delete(oldest.value);
    }
    return true;
  };

  const writeSynopsis = (input: {
    readonly workSessionId: string;
    readonly threadId: ThreadId;
    readonly at: string;
  }) =>
    Effect.gen(function* () {
      const workSession = yield* workSessions.get(input.workSessionId as never);
      const turns: ReadonlyArray<SynopsisTurn> = yield* engine.recentMessages(
        input.threadId,
        SYNOPSIS_TURN_WINDOW,
      );
      if (turns.length === 0) return;

      const written = yield* oneShot.run({
        prompt: buildSynopsisPrompt({
          title: workSession.title,
          objective: workSession.objective,
          turns,
        }),
        role: "synopsis",
        outputSchema: Schema.Struct({
          // The descriptions are the instruction the model follows: unannotated, the first real
          // run narrated the request ("Wrote a two-sentence status update for ...").
          currentAction: Schema.String.annotate({
            description:
              "One sentence about where this WORK is now. Never about this request, this summary, or yourself.",
          }),
          next: Schema.String.annotate({
            description:
              "One sentence about what is needed next for this WORK. Never about this request or yourself.",
          }),
        }),
      });

      yield* workSessions.applySynopsis({
        workSessionId: input.workSessionId as never,
        signals: [
          {
            kind: "written",
            at: input.at,
            currentAction: written.currentAction,
            next: written.next,
          },
        ],
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const worker = yield* makeDrainableWorker((pending: Pending) =>
    Effect.gen(function* () {
      const workSessionId = yield* workSessions.findForThread(pending.threadId);
      if (workSessionId === null) return;
      yield* workSessions.applySynopsis({ workSessionId, signals: pending.signals });

      // A model-written synopsis once per completed run: the run's own completion, not any
      // event that happens to mention it.
      const runId = pending.completedTurnId;
      const at = pending.signals.at(-1)?.at;
      if (runId === undefined || at === undefined) return;
      yield* writeSynopsis({ workSessionId, threadId: pending.threadId, at });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const start: TessayaSynopsisReactor["Service"]["start"] = Effect.fn("BatonSynopsisReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.domainEvents, (event) => {
          const pending = synopsisSignalsForEvent(event);
          return pending === null || !markSeen(pending.dedupeKey)
            ? Effect.void
            : worker.enqueue(pending);
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies TessayaSynopsisReactor["Service"];
});

export const layer = Layer.effect(TessayaSynopsisReactor, make);
