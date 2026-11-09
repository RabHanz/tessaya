import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { openInTerminal, type OpenPorts } from "./OpenInTerminal.ts";
import {
  CLOSED_GRACE_MS,
  OPEN_GRACE_MS,
  claudeHomeOf,
  handBackDue,
  parseSessionsFile,
  renderSessionsFile,
  type SessionHome,
} from "./TessayaSessionsFile.ts";

const HOME = { sessionId: "s-1", cwd: "/work/app", configDir: "/cfg/work" };

const fixture = (
  over: Partial<{ running: boolean; home: typeof HOME | null; released: boolean }> = {},
) => {
  const calls: string[] = [];
  const ports: OpenPorts = {
    shell: () => Effect.succeed({ running: over.running ?? false }),
    home: () => Effect.succeed(over.home === undefined ? HOME : over.home),
    detach: (id) => Effect.sync(() => void calls.push(`detach:${id}`)),
    released: () => Effect.sync(() => (calls.push("released?"), over.released ?? true)),
    launch: (home) =>
      Effect.sync(() => {
        calls.push(`launch:${home.sessionId}:${home.configDir}`);
        return { pane: "fab-app~w1:p2", detail: "ok" };
      }),
  };
  return { ports, calls };
};

describe("opening a Tessaya thread in a terminal", () => {
  it.effect(
    "lets go of the session before the terminal resumes it, on the thread's own login",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const result = yield* openInTerminal(f.ports, { threadId: "t1" });
        expect(result).toMatchObject({ state: "opened", pane: "fab-app~w1:p2" });
        expect(f.calls).toEqual(["detach:t1", "released?", "launch:s-1:/cfg/work"]);
      }),
  );

  it.effect("never starts a second writer: busy, no session yet, or still held", () =>
    Effect.gen(function* () {
      for (const [over, state] of [
        [{ running: true }, "busy"],
        [{ home: null }, "refused"],
        [{ released: false }, "refused"],
      ] as const) {
        const f = fixture(over);
        expect((yield* openInTerminal(f.ports, { threadId: "t1" })).state).toBe(state);
        expect(f.calls.some((call) => call.startsWith("launch:"))).toBe(false);
      }
    }),
  );
});

describe("the thread → session file", () => {
  const home: SessionHome = {
    threadId: "t1",
    title: "Pricing",
    sessionId: "s-1",
    cwd: "/work/app",
    configDir: "/cfg/work",
    instanceId: "claude-work",
    model: "claude-opus",
    inTerminal: true,
    openedAt: 1_000,
  };

  it("reads back what it wrote and skips what it cannot use", () => {
    expect(parseSessionsFile(renderSessionsFile([home]))).toEqual([home]);
    expect(parseSessionsFile('{"threads":[{"threadId":"x"}]}')).toEqual([]);
    expect(parseSessionsFile("not json")).toEqual([]);
  });

  it("names the login's config dir: home path, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
    expect(claudeHomeOf({ config: { homePath: "~/acc/work" } }, "/home/u")).toBe(
      "/home/u/acc/work",
    );
    expect(
      claudeHomeOf({ environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/cfg/x" }] }, "/home/u"),
    ).toBe("/cfg/x");
    expect(claudeHomeOf(undefined, "/home/u")).toBe("/home/u/.claude");
  });

  it("hands a thread back once its terminal has closed, or never opened", () => {
    const due = (over: Partial<Parameters<typeof handBackDue>[0]>) =>
      handBackDue({
        home,
        running: false,
        missingSince: null,
        seenRunning: true,
        nowMs: 50_000,
        ...over,
      });
    expect(due({ running: true })).toBe(false);
    expect(due({ missingSince: 50_000 - CLOSED_GRACE_MS + 1 })).toBe(false);
    expect(due({ missingSince: 50_000 - CLOSED_GRACE_MS })).toBe(true);
    expect(due({ seenRunning: false })).toBe(false);
    expect(due({ seenRunning: false, nowMs: home.openedAt + OPEN_GRACE_MS })).toBe(true);
    expect(due({ home: { ...home, inTerminal: false }, missingSince: 0 })).toBe(false);
  });
});
