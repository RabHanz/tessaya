/**
 * One thread's account (D95). Accounts are provider instances and their homes share transcripts, so
 * a move is `thread.model-selection.set` and the next turn resumes the conversation. That releases
 * the live session at once, so during a turn the move is stored and applied when the turn ends.
 */
import {
  BATON_DEFAULT_CLAUDE_INSTANCE,
  BatonLiveQueued,
  type BatonThreadAccountUseResult,
} from "@t3tools/baton-contracts";
import { liveSessionIdOf } from "@t3tools/baton-shared/liveThread";
import { ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { BatonEngine, type BatonEngineShape } from "./BatonEngine.ts";
import { makeApplyLive } from "./LiveActions.ts";

export class ThreadAccountMoveError extends Schema.TaggedError<ThreadAccountMoveError>()(
  "ThreadAccountMoveError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const TURN_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const isMoveError = Schema.is(ThreadAccountMoveError);

export const threadHasRunningTurn = (runs: ReadonlyArray<{ readonly status: string }>): boolean =>
  runs.some((run) => TURN_RUN_STATUSES.has(run.status));

// A queued run keeps its own selection and would put the thread back, so it holds the move too.
export const threadHasQueuedRun = (runs: ReadonlyArray<{ readonly status: string }>): boolean =>
  runs.some((run) => run.status === "queued");

/** The same conversation and model, on another instance. */
export const selectionOnInstance = (
  selection: ModelSelection,
  instanceId: string,
): ModelSelection =>
  ({ ...selection, instanceId: ProviderInstanceId.make(instanceId) }) as ModelSelection;

export interface ThreadAccountMovesShape {
  readonly request: (input: {
    readonly threadId: ThreadId;
    readonly instanceId: string;
  }) => Effect.Effect<BatonThreadAccountUseResult, ThreadAccountMoveError>;
  /** Threads automatic rotation leaves alone: a move is already waiting, or he keeps them where they are. */
  readonly held: Effect.Effect<ReadonlySet<string>>;
  readonly kept: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly keep: (input: {
    readonly threadId: ThreadId;
    readonly keep: boolean;
  }) => Effect.Effect<boolean>;
  /** A terminal session's model, effort or account change that waits for the session to go idle. */
  readonly queueLive: (
    sessionId: string,
    change: BatonLiveQueued,
  ) => Effect.Effect<BatonLiveQueued>;
  /** The change waiting, and why the last one could not be applied. */
  readonly liveQueued: (sessionId: string) => Effect.Effect<{
    readonly queued: BatonLiveQueued | null;
    readonly failure: string | null;
  }>;
  readonly cancelLive: (sessionId: string) => Effect.Effect<boolean>;
  /** The mirror saw this session go from busy to idle: a queued change goes in now. */
  readonly settleLive: (sessionId: string) => Effect.Effect<void>;
}

/** Tells a terminal session a queued change: "busy" keeps it waiting, "failed" says why it was not applied. */
export type ApplyLive = (
  sessionId: string,
  change: BatonLiveQueued,
) => Effect.Effect<
  { readonly state: "busy" | "done" } | { readonly state: "failed"; readonly detail: string }
>;

const decodeQueued = Schema.decodeUnknownOption(Schema.fromJsonString(BatonLiveQueued));
const decodeQueuedOrNull = (json: string) => {
  const decoded = decodeQueued(json);
  return decoded._tag === "Some" ? decoded.value : null;
};

export class ThreadAccountMoves extends Context.Service<
  ThreadAccountMoves,
  ThreadAccountMovesShape
>()("t3/baton/ThreadAccountMoves") {}

export const makeMoves = Effect.fn("ThreadAccountMoves.make")(function* (
  engine: BatonEngineShape,
  sql: SqlClient.SqlClient,
  applyLive: ApplyLive,
) {
  const stored = yield* sql<{ readonly thread_id: string; readonly instance_id: string }>`
    SELECT thread_id, instance_id FROM fabric_thread_account_moves
  `;
  const pending = new Map(stored.map((row) => [row.thread_id, row.instance_id]));

  const forget = (threadId: string) =>
    Effect.suspend(() => {
      pending.delete(threadId);
      return sql`DELETE FROM fabric_thread_account_moves WHERE thread_id = ${threadId}`;
    });

  const move = Effect.fn("ThreadAccountMoves.move")(function* (
    threadId: ThreadId,
    instanceId: string,
  ) {
    const shell = yield* engine.threadShell(threadId);
    if (shell === null) return yield* new ThreadAccountMoveError({ detail: "No such thread." });
    if (shell.modelSelection.instanceId === instanceId) return;
    yield* engine.setThreadSelection({
      tag: "account",
      threadId,
      modelSelection: selectionOnInstance(shell.modelSelection, instanceId),
    });
  });

  const applyWhenIdle = Effect.fn("ThreadAccountMoves.applyWhenIdle")(
    function* (threadId: string, instanceId: string) {
      const id = ThreadId.make(threadId);
      const runs = yield* engine.threadRuns(id);
      if (threadHasRunningTurn(runs) || threadHasQueuedRun(runs)) return;
      // Forgotten only after it worked, so a failed move is tried again on the next change.
      yield* move(id, instanceId);
      yield* forget(threadId);
      yield* Effect.logInfo("Tessaya moved a thread to another account", { threadId, instanceId });
    },
    Effect.ignoreCause({ log: true }),
  );

  const request: ThreadAccountMovesShape["request"] = Effect.fn("ThreadAccountMoves.request")(
    function* ({ threadId, instanceId }) {
      const shell = yield* engine.threadShell(threadId);
      if (!shell?.modelSelection.instanceId.startsWith(BATON_DEFAULT_CLAUDE_INSTANCE)) {
        return yield* new ThreadAccountMoveError({ detail: "This is not a Claude thread." });
      }
      const runs = yield* engine.threadRuns(threadId);
      if (threadHasRunningTurn(runs)) {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO fabric_thread_account_moves (thread_id, instance_id, requested_at)
          VALUES (${threadId}, ${instanceId}, ${now})
          ON CONFLICT (thread_id) DO UPDATE SET
            instance_id = excluded.instance_id,
            requested_at = excluded.requested_at
        `;
        pending.set(threadId, instanceId);
        return { instanceId, timing: "next-turn" as const };
      }
      if (threadHasQueuedRun(runs)) {
        return yield* new ThreadAccountMoveError({
          detail: "A queued message is waiting on this thread. Cancel or send it, then switch.",
        });
      }
      // A later choice replaces a waiting one.
      yield* move(threadId, instanceId);
      yield* forget(threadId);
      return { instanceId, timing: "now" as const };
    },
    Effect.mapError((cause) =>
      isMoveError(cause) ? cause : new ThreadAccountMoveError({ detail: String(cause) }),
    ),
  );

  // Queued terminal session changes: kept in baton.sqlite so a restart still applies them.
  const queuedRows = yield* sql<{ readonly session_id: string; readonly change_json: string }>`
    SELECT session_id, change_json FROM tessaya_live_queue
  `;
  const live = new Map(
    queuedRows.flatMap((row) => {
      const change = decodeQueuedOrNull(row.change_json);
      return change === null ? [] : [[row.session_id, change] as const];
    }),
  );
  const failures = new Map<string, string>();
  // Taken out while it is being told; a cancel then lands here, so a busy answer does not put it back.
  const applying = new Map<string, { cancelled: boolean }>();
  const store = (sessionId: string, change: BatonLiveQueued | null) =>
    change === null
      ? sql`DELETE FROM tessaya_live_queue WHERE session_id = ${sessionId}`
      : sql`INSERT INTO tessaya_live_queue (session_id, change_json) VALUES (${sessionId}, ${JSON.stringify(change)})
          ON CONFLICT (session_id) DO UPDATE SET change_json = excluded.change_json`;

  const queueLive = Effect.fn("ThreadAccountMoves.queueLive")(function* (
    sessionId: string,
    change: BatonLiveQueued,
  ) {
    // A later pick replaces the waiting one field by field, as the thread's own move does.
    const merged = { ...live.get(sessionId), ...change };
    live.set(sessionId, merged);
    failures.delete(sessionId);
    yield* store(sessionId, merged);
    return merged;
  }, Effect.orDie);

  const cancelLive = Effect.fn("ThreadAccountMoves.cancelLive")(function* (sessionId: string) {
    const inFlight = applying.get(sessionId);
    if (inFlight !== undefined) inFlight.cancelled = true;
    const had = live.delete(sessionId) || inFlight !== undefined;
    yield* store(sessionId, null);
    return had;
  }, Effect.orDie);

  const applyLiveWhenIdle = Effect.fn("ThreadAccountMoves.applyLiveWhenIdle")(
    function* (sessionId: string, change: BatonLiveQueued) {
      if (applying.has(sessionId)) return;
      live.delete(sessionId);
      const flight = { cancelled: false };
      applying.set(sessionId, flight);
      const outcome = yield* applyLive(sessionId, change).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({ state: "failed" as const, detail: String(cause).slice(0, 300) }),
        ),
        Effect.ensuring(Effect.sync(() => applying.delete(sessionId))),
      );
      const replaced = live.has(sessionId);
      if (outcome.state === "busy") {
        // Back in the queue only when nothing replaced it and he did not cancel it meanwhile.
        if (!replaced && !flight.cancelled) live.set(sessionId, change);
        return;
      }
      if (outcome.state === "failed") {
        failures.set(sessionId, outcome.detail);
        yield* Effect.logWarning("Tessaya could not apply a queued terminal session change", {
          sessionId,
          detail: outcome.detail,
        });
      } else
        yield* Effect.logInfo("Tessaya applied a queued terminal session change", { sessionId });
      if (!replaced) yield* store(sessionId, null);
    },
    Effect.ignoreCause({ log: true }),
  );

  const settleLive = (sessionId: string) => {
    const change = live.get(sessionId);
    return change === undefined ? Effect.void : applyLiveWhenIdle(sessionId, change);
  };

  const settle = (threadId: string) => {
    const sessionId = liveSessionIdOf(threadId);
    const change = sessionId === null ? undefined : live.get(sessionId);
    if (sessionId !== null && change !== undefined) return applyLiveWhenIdle(sessionId, change);
    const instanceId = pending.get(threadId);
    return instanceId === undefined ? Effect.void : applyWhenIdle(threadId, instanceId);
  };

  const keptRows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM fabric_thread_account_keeps
  `;
  const keeps = new Set(keptRows.map((row) => row.thread_id));
  const held = Effect.sync(() => new Set([...pending.keys(), ...keeps]));
  const kept = (threadId: ThreadId) => Effect.sync(() => keeps.has(threadId));
  const keep = Effect.fn("ThreadAccountMoves.keep")(function* (input: {
    readonly threadId: ThreadId;
    readonly keep: boolean;
  }) {
    if (input.keep) {
      yield* sql`INSERT INTO fabric_thread_account_keeps (thread_id) VALUES (${input.threadId})
          ON CONFLICT (thread_id) DO NOTHING`;
      keeps.add(input.threadId);
    } else {
      yield* sql`DELETE FROM fabric_thread_account_keeps WHERE thread_id = ${input.threadId}`;
      keeps.delete(input.threadId);
    }
    return input.keep;
  }, Effect.orDie);

  return {
    request,
    settle,
    held,
    kept,
    keep,
    queueLive,
    liveQueued: (sessionId: string) =>
      Effect.sync(() => ({
        queued: live.get(sessionId) ?? null,
        failure: failures.get(sessionId) ?? null,
      })),
    cancelLive,
    settleLive,
    pendingThreadIds: () => [...pending.keys()],
  };
});

export const layer = Layer.effect(
  ThreadAccountMoves,
  Effect.gen(function* () {
    const engine = yield* BatonEngine;
    const sql = yield* SqlClient.SqlClient;
    const moves = yield* makeMoves(engine, sql, yield* makeApplyLive);
    // Moves left waiting by a restart first, then every thread as it changes.
    yield* Effect.forEach(moves.pendingThreadIds(), moves.settle, { discard: true });
    yield* engine.changedThreads.pipe(Stream.runForEach(moves.settle), Effect.forkScoped);
    return ThreadAccountMoves.of({
      request: moves.request,
      held: moves.held,
      kept: moves.kept,
      keep: moves.keep,
      queueLive: moves.queueLive,
      liveQueued: moves.liveQueued,
      cancelLive: moves.cancelLive,
      settleLive: moves.settleLive,
    });
  }),
);
