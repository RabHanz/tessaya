import { it as effectIt } from "@effect/vitest";
import { setClaudeAccountInstances } from "@t3tools/baton-contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { layerMemory as SqlitePersistenceMemory } from "./BatonDatabase.ts";
import type { BatonEngineShape } from "./BatonEngine.ts";
import {
  type ApplyLive,
  makeMoves,
  selectionOnInstance,
  threadHasQueuedRun,
  threadHasRunningTurn,
} from "./ThreadAccountMoves.ts";

setClaudeAccountInstances({
  claudeAgent_robin: "4",
  claudeAgent_optima: "5",
  claudeAgent_sablebox: "6",
});

describe("what holds a move", () => {
  it("tells a turn in progress from a queued run", () => {
    expect(threadHasRunningTurn([{ status: "running" }])).toBe(true);
    expect(threadHasRunningTurn([{ status: "waiting" }])).toBe(true);
    expect(threadHasRunningTurn([{ status: "queued" }, { status: "completed" }])).toBe(false);
    expect(threadHasQueuedRun([{ status: "queued" }, { status: "completed" }])).toBe(true);
    expect(threadHasQueuedRun([{ status: "failed" }])).toBe(false);
  });
});

describe("selectionOnInstance", () => {
  it("changes the instance and keeps the model and its options", () => {
    const selection = {
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    } as never;
    expect(selectionOnInstance(selection, "claudeAgent_optima")).toEqual({
      instanceId: "claudeAgent_optima",
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    });
  });
});

const idle: ApplyLive = () => Effect.succeed({ state: "done" });

effectIt.effect(
  "applies a terminal session's queued change once it is idle, across a restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const engine = { threadShell: () => Effect.succeed(null) } as unknown as BatonEngineShape;
      let busy = true;
      const told: Array<unknown> = [];
      const apply: ApplyLive = (_sessionId, change) =>
        Effect.sync(() => {
          if (busy) return { state: "busy" as const };
          told.push(change);
          return { state: "done" as const };
        });
      const moves = yield* makeMoves(engine, sql, apply);
      yield* moves.queueLive("s1", { effort: "high" });
      // A later pick joins the waiting one.
      yield* moves.queueLive("s1", { model: "claude-opus-5-5" });
      yield* moves.settle("baton-live4:s1");
      expect(told).toEqual([]);
      // A restart keeps it.
      const restarted = yield* makeMoves(engine, sql, apply);
      expect((yield* restarted.liveQueued("s1")).queued).toEqual({
        effort: "high",
        model: "claude-opus-5-5",
      });
      busy = false;
      yield* restarted.settle("baton-live4:s1");
      expect(told).toEqual([{ effort: "high", model: "claude-opus-5-5" }]);
      expect(yield* restarted.liveQueued("s1")).toEqual({ queued: null, failure: null });
      expect((yield* (yield* makeMoves(engine, sql, apply)).liveQueued("s1")).queued).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

effectIt.effect("a cancel or a newer pick during an apply wins, and a failure is reported", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = { threadShell: () => Effect.succeed(null) } as unknown as BatonEngineShape;
    let during: Effect.Effect<unknown> = Effect.void;
    let answer: { state: "busy" | "done" } | { state: "failed"; detail: string } = {
      state: "busy",
    };
    const moves = yield* makeMoves(engine, sql, () => Effect.as(during, answer));
    yield* moves.queueLive("s1", { accountKey: "5" });
    during = moves.cancelLive("s1");
    yield* moves.settle("baton-live4:s1");
    expect((yield* moves.liveQueued("s1")).queued).toBeNull();

    yield* moves.queueLive("s1", { accountKey: "5" });
    during = moves.queueLive("s1", { accountKey: "4" });
    yield* moves.settle("baton-live4:s1");
    expect((yield* moves.liveQueued("s1")).queued).toEqual({ accountKey: "4" });

    during = Effect.void;
    answer = { state: "failed", detail: "Not switched: refused." };
    yield* moves.settle("baton-live4:s1");
    expect(yield* moves.liveQueued("s1")).toEqual({
      queued: null,
      failure: "Not switched: refused.",
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

effectIt.effect("keeps a thread on its account across a restart, and lets it go again", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = { threadShell: () => Effect.succeed(null) } as unknown as BatonEngineShape;
    const thread = ThreadId.make("kept-thread");
    yield* (yield* makeMoves(engine, sql, idle)).keep({ threadId: thread, keep: true });
    const restarted = yield* makeMoves(engine, sql, idle);
    expect(yield* restarted.kept(thread)).toBe(true);
    expect((yield* restarted.held).has(thread)).toBe(true);
    yield* restarted.keep({ threadId: thread, keep: false });
    expect((yield* (yield* makeMoves(engine, sql, idle)).held).has(thread)).toBe(false);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

effectIt.effect.each([
  ["moves a running turn's thread at once when its login can move in place", true, "now"],
  ["waits for the turn to end when it cannot", false, "next-turn"],
] as const)("%s", ([, inPlace, timing]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const thread = ThreadId.make("running-thread");
    const selections: Array<unknown> = [];
    const recorded: Array<unknown> = [];
    const shell = {
      id: thread,
      projectId: "project-1",
      modelSelection: { instanceId: "claudeAgent_robin", model: "claude-haiku-4-5" },
    };
    const engine = {
      threadShell: () => Effect.succeed(shell),
      threadRuns: () => Effect.succeed([{ status: "running" }]),
      setThreadSelection: (input: unknown) => Effect.sync(() => void selections.push(input)),
    } as unknown as BatonEngineShape;
    const moves = yield* makeMoves(engine, sql, idle, {
      switchesInPlace: () => Effect.succeed(inPlace),
      record: (entry) => Effect.sync(() => void recorded.push(entry)),
    });
    const result = yield* moves.request({ threadId: thread, instanceId: "claudeAgent_optima" });
    expect(result).toEqual({ instanceId: "claudeAgent_optima", timing });
    expect(selections.length).toBe(inPlace ? 1 : 0);
    expect(recorded).toEqual(
      inPlace
        ? [
            {
              kind: "account_switch",
              actor: "tessaya",
              project: "project-1",
              ref: thread,
              subject: "Account claudeAgent_robin → claudeAgent_optima",
              outcome: "switched in place during the turn",
            },
          ]
        : [],
    );
    expect((yield* moves.held).has(thread)).toBe(!inPlace);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
