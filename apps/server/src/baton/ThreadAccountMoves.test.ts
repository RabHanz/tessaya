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

const idle: ApplyLive = () => Effect.succeed("done");

effectIt.effect(
  "applies a terminal session's queued change once it is idle, and can cancel it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const engine = { threadShell: () => Effect.succeed(null) } as unknown as BatonEngineShape;
      let busy = true;
      const told: Array<unknown> = [];
      const moves = yield* makeMoves(engine, sql, (_sessionId, change) =>
        Effect.sync(() => {
          if (busy) return "busy";
          told.push(change);
          return "done";
        }),
      );
      yield* moves.queueLive("s1", { effort: "high" });
      // A later pick joins the waiting one.
      yield* moves.queueLive("s1", { model: "claude-opus-5-5" });
      yield* moves.settle("baton-live4:s1");
      expect(told).toEqual([]);
      expect(yield* moves.liveQueued("s1")).toEqual({ effort: "high", model: "claude-opus-5-5" });
      busy = false;
      yield* moves.settle("baton-live4:s1");
      expect(told).toEqual([{ effort: "high", model: "claude-opus-5-5" }]);
      expect(yield* moves.liveQueued("s1")).toBeNull();
      yield* moves.queueLive("s1", { accountKey: "5" });
      expect(yield* moves.cancelLive("s1")).toBe(true);
      yield* moves.settle("baton-live4:s1");
      expect(told).toHaveLength(1);
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
