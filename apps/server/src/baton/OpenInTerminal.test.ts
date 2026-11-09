import { it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { claudeHomeOf } from "./MoveIntoTessaya.ts";
import { openInTerminal, type OpenPorts } from "./OpenInTerminal.ts";
import {
  CLOSED_GRACE_MS,
  OPEN_GRACE_MS,
  handBackDue,
  parseSessionsFile,
  renderSessionsFile,
  takeOpenRequests,
  type SessionHome,
} from "./TessayaSessionsFile.ts";

const HOME = { sessionId: "s-1", cwd: "/work/app", configDir: "/cfg/work" };

const fixture = (
  over: Partial<{
    running: boolean;
    stops: boolean;
    home: typeof HOME | null;
    released: boolean;
    pane: string | null;
  }> = {},
) => {
  const calls: string[] = [];
  const ports: OpenPorts = {
    shell: () => Effect.succeed({ running: over.running ?? false }),
    home: () => Effect.succeed(over.home === undefined ? HOME : over.home),
    stopTurn: () => Effect.sync(() => (calls.push("stop"), over.stops ?? true)),
    toTerminal: () => Effect.sync(() => void calls.push("to-terminal")),
    back: () => Effect.sync(() => void calls.push("back")),
    detach: (id) => Effect.sync(() => void calls.push(`detach:${id}`)),
    released: () => Effect.sync(() => (calls.push("released?"), over.released ?? true)),
    launch: (home) =>
      Effect.sync(() => {
        calls.push(`launch:${home.sessionId}:${home.configDir}`);
        return over.pane === null
          ? { pane: null, detail: "herdr said no" }
          : { pane: "fab-app~w1:p2", detail: "ok" };
      }),
  };
  return { ports, calls };
};

describe("opening a Tessaya thread in a terminal", () => {
  it.effect(
    "puts the thread on its terminal and lets go of the session before the terminal resumes it",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const result = yield* openInTerminal(f.ports, { threadId: "t1" });
        expect(result).toMatchObject({ state: "opened", pane: "fab-app~w1:p2" });
        expect(f.calls).toEqual(["to-terminal", "detach:t1", "released?", "launch:s-1:/cfg/work"]);
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

  it.effect("gives the thread back to Tessaya when the terminal could not be opened", () =>
    Effect.gen(function* () {
      for (const over of [{ released: false }, { pane: null }] as const) {
        const f = fixture(over);
        expect((yield* openInTerminal(f.ports, { threadId: "t1" })).state).toBe("refused");
        expect(f.calls.at(-1)).toBe("back");
      }
    }),
  );

  it.effect("stops a running turn through the server only when asked, and waits for it", () =>
    Effect.gen(function* () {
      const asked = fixture({ running: true });
      yield* openInTerminal(asked.ports, { threadId: "t1", stopTurn: true });
      expect(asked.calls.slice(0, 2)).toEqual(["stop", "to-terminal"]);
      const stuck = fixture({ running: true, stops: false });
      expect((yield* openInTerminal(stuck.ports, { threadId: "t1", stopTurn: true })).state).toBe(
        "busy",
      );
      expect(stuck.calls).toEqual(["stop"]);
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

describe("a --force request from the CLI", () => {
  it("is taken once, by removing it, and names only a thread", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-req-"));
    NodeFS.mkdirSync(NodePath.join(stateDir, "tessaya-requests"));
    const write = (name: string, text: string) =>
      NodeFS.writeFileSync(NodePath.join(stateDir, "tessaya-requests", name), text);
    write("open-1.json", '{"threadId":"t-1"}');
    write("open-2.json", "not json");
    write("other.json", '{"threadId":"t-2"}');
    expect(takeOpenRequests(stateDir)).toEqual(["t-1"]);
    expect(takeOpenRequests(stateDir)).toEqual([]);
    expect(NodeFS.readdirSync(NodePath.join(stateDir, "tessaya-requests"))).toEqual([
      "open-2.json",
      "other.json",
    ]);
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  });
});
