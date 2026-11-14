import { deriveBatonSessionState, RuntimeRequestId } from "@t3tools/tessaya-contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { at, finishedShell, v2Shell, workingShell } from "./__fixtures__/v2ThreadShell.ts";
import { BatonEngine, batonStateInputFromShell, layer as batonEngineLayer } from "./BatonEngine.ts";

const state = (shell: Parameters<typeof batonStateInputFromShell>[0]) =>
  deriveBatonSessionState(batonStateInputFromShell(shell));

const request = (kind: "command" | "user_input", blocking = true) => ({
  id: RuntimeRequestId.make("r1"),
  kind,
  createdAt: at("2026-09-18T05:00:10.000Z"),
  blocking,
});

describe("batonStateInputFromShell: a v2 thread shell on the §10 ladder", () => {
  it("reads an unvisited finished run as done_unseen, and a visited one as idle", () => {
    expect(state(finishedShell())).toBe("done_unseen");
    expect(state({ ...finishedShell(), lastVisitedAt: at("2026-09-18T05:01:00.000Z") })).toBe(
      "idle",
    );
  });

  it("reads a running run as working", () => {
    expect(state(workingShell())).toBe("working");
  });

  it("tells an approval from a question, and ignores a request the run works past", () => {
    expect(state(v2Shell({ status: "waiting", pendingRuntimeRequest: request("command") }))).toBe(
      "needs_approval",
    );
    expect(
      state(v2Shell({ status: "waiting", pendingRuntimeRequest: request("user_input") })),
    ).toBe("needs_input");
    expect(
      state(v2Shell({ status: "running", pendingRuntimeRequest: request("user_input", false) })),
    ).toBe("working");
  });

  it("reads a spent account as limited, and any other failure as failed", () => {
    expect(state(v2Shell({ status: "failed", lastErrorClass: "usage_limit" }))).toBe("limited");
    expect(
      state(v2Shell({ status: "failed", lastErrorClass: "provider_error", lastError: "boom" })),
    ).toBe("failed");
  });
});

describe("threadShells", () => {
  it.effect(
    "shares one read across callers, outlives a caller that leaves, and rereads on a new event",
    () => {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const shell = workingShell();
      let reads = 0;
      let sequence = 7;
      const engine = batonEngineLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getShellSnapshot: () =>
                Effect.sync(() => (reads += 1)).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({
                    schemaVersion: 1,
                    snapshotSequence: sequence,
                    threads: [shell],
                    archivedThreads: [],
                  }),
                ),
              streamDomainEvents: Stream.empty,
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(EventSink.EventSinkV2)({}),
            Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
              latestApplicationSequence: Effect.sync(() => sequence),
            }),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
          ),
        ),
      );
      return Effect.gen(function* () {
        const { threadShells } = yield* BatonEngine;
        const leaving = yield* Effect.forkChild(threadShells);
        yield* Deferred.await(started);
        const staying = yield* Effect.forkChild(threadShells);
        yield* Fiber.interrupt(leaving);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(staying)).toEqual([shell]);
        expect(yield* threadShells).toEqual([shell]);
        expect(reads).toBe(1);

        sequence = 8;
        expect(yield* threadShells).toEqual([shell]);
        expect(reads).toBe(2);
      }).pipe(Effect.provide(engine));
    },
  );
});

describe("keepActive", () => {
  it.effect("leaves an archived thread alone instead of sending it commands it refuses", () => {
    const dispatched: Array<string> = [];
    const archived = { ...finishedShell(), archivedAt: at("2026-09-18T06:00:00.000Z") };
    const engine = batonEngineLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: (threadId) =>
              Effect.succeed(threadId === archived.id ? archived : finishedShell(threadId)),
            dispatch: (command) =>
              Effect.sync(() => dispatched.push(command.type)).pipe(Effect.as(undefined as never)),
            streamDomainEvents: Stream.empty,
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(EventSink.EventSinkV2)({}),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const { keepActive } = yield* BatonEngine;
      expect(yield* keepActive({ tag: "live", threadId: archived.id, settled: true })).toBe(false);
      expect(dispatched).toEqual([]);
      const open = ThreadId.make("open");
      expect(yield* keepActive({ tag: "live", threadId: open, settled: true })).toBe(true);
      expect(dispatched).toEqual(["thread.auto-settle.set", "thread.unsettle"]);
    }).pipe(Effect.provide(engine));
  });
});
