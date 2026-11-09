import { it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  instancesForLogin,
  moveIntoTessaya,
  resumeInstance,
  pointAtSessionEvents,
  type MovePorts,
} from "./MoveIntoTessaya.ts";

const THREAD = "baton-live4:cc828d1b";

const fixture = (
  over: Partial<{
    instance: string;
    running: boolean;
    session: {
      status: string | null;
      pane: string | null;
      account: string | null;
      configDir: string | null;
    } | null;
    target: { instanceId: string; model: string } | { refused: string } | null;
    exits: boolean;
    held: boolean;
    pointFails: boolean;
  }> = {},
) => {
  const calls: string[] = [];
  const ports: MovePorts = {
    shell: () =>
      Effect.succeed({ instanceId: over.instance ?? "baton-live", running: over.running ?? false }),
    session: () =>
      Effect.succeed(
        over.session === undefined
          ? { status: "idle", pane: "fab-x~w1:p1", account: "work", configDir: "/cfg/work" }
          : over.session,
      ),
    target: (input) =>
      Effect.sync(() => {
        calls.push(`target:${input.login}`);
        return over.target === undefined || over.target === null
          ? over.target === null
            ? { refused: "no account" }
            : { instanceId: "claude-work", model: "claude-opus" }
          : over.target;
      }),
    endTerminal: (id) => Effect.sync(() => (calls.push(`end:${id}`), over.exits ?? true)),
    held: () => Effect.sync(() => (calls.push("held?"), over.held ?? false)),
    point: (input) =>
      over.pointFails === true
        ? Effect.fail("write failed")
        : Effect.sync(() => {
            calls.push(`point:${input.instanceId}:${input.sessionId}`);
          }),
  };
  return { ports, calls };
};

describe("moving a Terminal thread into Tessaya", () => {
  it.effect(
    "ends the terminal session first, then resumes the same session id on the session's own login",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const result = yield* moveIntoTessaya(f.ports, {
          threadId: THREAD,
          providerChangeApproved: true,
        });
        expect(result.state).toBe("moved");
        expect(f.calls).toEqual([
          "target:work",
          "end:cc828d1b",
          "held?",
          "point:claude-work:cc828d1b",
        ]);
      }),
  );

  it.effect(
    "does nothing without the confirmation, while busy, or when not a terminal thread",
    () =>
      Effect.gen(function* () {
        const cases = [
          { over: {}, threadId: THREAD, approved: false, state: "refused" },
          { over: { running: true }, threadId: THREAD, approved: true, state: "busy" },
          {
            over: { session: { status: "busy", pane: "p", account: "work" } },
            threadId: THREAD,
            approved: true,
            state: "busy",
          },
          { over: { instance: "claude-work" }, threadId: THREAD, approved: true, state: "refused" },
          { over: {}, threadId: "thread-1", approved: true, state: "refused" },
          { over: { target: null }, threadId: THREAD, approved: true, state: "refused" },
        ] as const;
        for (const c of cases) {
          const f = fixture(c.over);
          const result = yield* moveIntoTessaya(f.ports, {
            threadId: c.threadId,
            providerChangeApproved: c.approved,
          });
          expect(result.state).toBe(c.state);
          expect(
            f.calls.filter((call) => call.startsWith("end:") || call.startsWith("point:")),
          ).toEqual([]);
        }
      }),
  );

  it.effect("leaves the thread alone when the terminal process does not exit", () =>
    Effect.gen(function* () {
      const f = fixture({ exits: false });
      const result = yield* moveIntoTessaya(f.ports, {
        threadId: THREAD,
        providerChangeApproved: true,
      });
      expect(result.state).toBe("refused");
      expect(f.calls.some((call) => call.startsWith("point:"))).toBe(false);
    }),
  );

  it.effect(
    "never switches while any process still holds the session after the terminal ended",
    () =>
      Effect.gen(function* () {
        const f = fixture({ held: true });
        const result = yield* moveIntoTessaya(f.ports, {
          threadId: THREAD,
          providerChangeApproved: true,
        });
        expect(result.state).toBe("refused");
        expect(f.calls.some((call) => call.startsWith("point:"))).toBe(false);
      }),
  );

  it.effect(
    "a stopped session needs no exit, and a failed switch says the terminal already ended",
    () =>
      Effect.gen(function* () {
        const stopped = fixture({ session: null });
        yield* moveIntoTessaya(stopped.ports, { threadId: THREAD, providerChangeApproved: true });
        expect(stopped.calls).toEqual(["target:null", "held?", "point:claude-work:cc828d1b"]);
        const failed = fixture({ pointFails: true });
        const result = yield* moveIntoTessaya(failed.ports, {
          threadId: THREAD,
          providerChangeApproved: true,
        });
        expect(result).toMatchObject({ state: "refused" });
        expect(result.detail).toContain("terminal session ended");
      }),
  );
});

describe("the instance a moved session continues on", () => {
  const accounts = [
    {
      driver: "claudeAgent",
      email: "Work@example.com",
      instanceIds: ["claudeAgent", "claude-work"],
      health: "ok",
      methods: [
        { instanceId: "claudeAgent", liveSwitch: false },
        { instanceId: "claude-work", liveSwitch: true },
      ],
    },
    {
      driver: "claudeAgent",
      email: "home@example.com",
      instanceIds: ["claude-home"],
      health: "paused",
      methods: [],
    },
  ];
  it("is one of the session's own login's instances, never another account's", () => {
    expect(instancesForLogin(accounts, "work")).toEqual(["claude-work", "claudeAgent"]);
    expect(instancesForLogin(accounts, "home")).toEqual([]);
    expect(instancesForLogin(accounts, "stranger")).toEqual([]);
  });

  it("is the one whose projects folder is the session's and holds its transcript, or none (nothing ends)", () => {
    // Two homes link one projects folder; a third has its own.
    const real: Record<string, string> = {
      "/term/projects": "/shared/projects",
      "/a/projects": "/own/projects",
      "/b/projects": "/shared/projects",
    };
    const pick = (sessionConfigDir: string | null, files: ReadonlyArray<string>) =>
      resumeInstance({
        candidates: [
          { instanceId: "a", home: "/a" },
          { instanceId: "b", home: "/b" },
        ],
        sessionConfigDir,
        transcript: (home) => `${home}/projects/slug/s.jsonl`,
        realpath: (path) => real[path] ?? null,
        exists: (path) => files.includes(path),
      });
    const both = ["/a/projects/slug/s.jsonl", "/b/projects/slug/s.jsonl"];
    expect(pick("/term", both)).toBe("b");
    expect(pick("/term", ["/a/projects/slug/s.jsonl"])).toBeNull();
    expect(pick("/unknown", both)).toBeNull();
    // Not running: any home that has the transcript.
    expect(pick(null, ["/b/projects/slug/s.jsonl"])).toBe("b");
    expect(pick(null, [])).toBeNull();
  });
});

describe("pointing a thread at a session", () => {
  it("makes a strong native ref, so the first turn resumes that session instead of starting one", () => {
    const now = DateTime.makeUnsafe("2026-11-09T10:00:00Z");
    const thread = {
      id: ThreadId.make(THREAD),
      providerInstanceId: "baton-live",
      modelSelection: { instanceId: "baton-live", model: "live" },
      activeProviderThreadId: "old",
    } as unknown as OrchestrationV2AppThread;
    const [providerThread, switched] = pointAtSessionEvents({
      thread,
      driver: "claudeAgent",
      instanceId: "claude-work",
      model: "claude-opus",
      sessionId: "cc828d1b",
      now,
      stamp: 1,
    });
    expect(providerThread).toMatchObject({
      type: "provider-thread.updated",
      payload: {
        providerInstanceId: "claude-work",
        nativeThreadRef: { driver: "claudeAgent", nativeId: "cc828d1b", strength: "strong" },
      },
    });
    expect(switched).toMatchObject({
      type: "thread.provider-switched",
      payload: {
        providerInstanceId: "claude-work",
        modelSelection: { instanceId: "claude-work", model: "claude-opus" },
        activeProviderThreadId:
          providerThread!.type === "provider-thread.updated" ? providerThread!.payload.id : null,
      },
    });
  });
});
