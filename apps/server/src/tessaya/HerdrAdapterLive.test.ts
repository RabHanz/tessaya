/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The adapter, driven by output captured from `herdr 0.9.1` on the box.
 *
 * Every fixture in `__fixtures__/herdr-0.9.1/` is a real CLI response rather
 * than a hand-written approximation of one, and that distinction already paid:
 * an invented `process-info` would have had an empty `foreground_processes` for
 * an idle pane. The real one reports the shell itself, so "the list is not
 * empty" read every idle terminal as busy.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import { AdoptedRuntimeAdapter } from "./AdoptedSessionService.ts";
import {
  layerWith,
  paneLabel,
  parseHerdrError,
  parseHerdrSessionList,
  splitPaneRef,
  parseHerdrForeground,
  parseHerdrSnapshot,
  toCandidate,
  type HerdrCommandResult,
} from "./HerdrAdapterLive.ts";

const fixture = (name: string): string =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "__fixtures__", "herdr-0.9.1", name),
    "utf8",
  );

const SNAPSHOT = fixture("api-snapshot.json");
const PROCESS_RUNNING = fixture("pane-process-info-running.json");
const PROCESS_IDLE = fixture("pane-process-info-idle.json");
const ERROR_NO_SERVER = fixture("error-server-not-running.json");
const ERROR_NO_PANE = fixture("error-pane-not-found.json");
const PANE_READ = fixture("pane-read.txt");

const ok = (stdout: string): HerdrCommandResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  notInstalled: false,
});
const failed = (stderr: string): HerdrCommandResult => ({
  stdout: "",
  stderr,
  exitCode: 1,
  notInstalled: false,
});
/** What the runner reports on a machine with no `herdr` binary: ENOENT. */
const missing = (): HerdrCommandResult => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  notInstalled: true,
});

/** A fake `herdr` that answers from the fixtures, keyed on the argv. */
const scriptedCli = (
  answers: ReadonlyArray<readonly [string, HerdrCommandResult]>,
  calls?: Array<ReadonlyArray<string>>,
): Layer.Layer<AdoptedRuntimeAdapter> =>
  layerWith((args) => {
    calls?.push(args);
    const key = args.join(" ");
    const match = answers.find(([prefix]) => key.startsWith(prefix));
    return Effect.succeed(
      match?.[1] ?? failed(`{"error":{"code":"unexpected_call","message":"${key}"}}`),
    );
  });

const runAdapter = <A>(
  layer: Layer.Layer<AdoptedRuntimeAdapter>,
  use: (adapter: AdoptedRuntimeAdapter["Service"]) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    const adapter = yield* AdoptedRuntimeAdapter;
    return yield* use(adapter);
  }).pipe(Effect.provide(layer));

describe("the error envelope herdr prints", () => {
  it("takes apart a real server_not_running", () => {
    const parsed = parseHerdrError(ERROR_NO_SERVER);
    expect(parsed?.code).toBe("server_not_running");
    expect(parsed?.message).toContain("no herdr server is running");
  });

  it("takes apart a real pane_not_found", () => {
    expect(parseHerdrError(ERROR_NO_PANE)?.code).toBe("pane_not_found");
  });

  it("returns null for stderr that is not the envelope, so the caller quotes it whole", () => {
    // A panic or a missing shared library is still a failure worth showing, and
    // pretending it parsed would drop the only text that explains it.
    expect(parseHerdrError("herdr: error while loading shared libraries")).toBeNull();
    expect(parseHerdrError("")).toBeNull();
    expect(parseHerdrError("{}")).toBeNull();
  });
});

describe("the snapshot herdr prints", () => {
  it("reads the real one", () => {
    const snapshot = parseHerdrSnapshot(SNAPSHOT);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.panes.length).toBeGreaterThanOrEqual(2);
    const pane = snapshot?.panes.find((entry) => entry.paneId === "w1:p1");
    expect(pane?.workspaceId).toBe("w1");
    expect(pane?.agentStatus).toBe("unknown");
    expect(snapshot?.workspaceLabels.get("w1")).toBe("proof");
  });

  it("refuses output it cannot read rather than reporting an empty server", () => {
    // "no panes" and "I could not read the answer" are different facts, and the
    // first would read as "nothing is running".
    expect(parseHerdrSnapshot("not json")).toBeNull();
    expect(parseHerdrSnapshot("{}")).toBeNull();
    expect(parseHerdrSnapshot('{"result":{}}')).toBeNull();
  });

  it("skips an entry that cannot identify itself", () => {
    const snapshot = parseHerdrSnapshot(
      JSON.stringify({
        result: { snapshot: { panes: [{ pane_id: "w1:p1" }, { workspace_id: "w1" }], agents: [] } },
      }),
    );
    expect(snapshot?.panes).toEqual([]);
  });
});

describe("what is running in a pane", () => {
  it("names the command in a busy pane", () => {
    expect(parseHerdrForeground(PROCESS_RUNNING)).toContain("ticker.sh");
  });

  it("reports nothing for a pane at its prompt, where the shell IS the foreground process", () => {
    // The fixture's foreground_processes is [{ "/bin/bash" }] — not empty.
    expect(parseHerdrForeground(PROCESS_IDLE)).toBeNull();
  });
});

describe("naming a pane", () => {
  it("prefers the agent, then the command, then the directory", () => {
    expect(
      paneLabel({
        agentName: "reviewer",
        agentKind: "claude",
        foreground: "x",
        cwd: "/a/b",
        paneId: "w1:p1",
      }),
    ).toBe("reviewer (claude)");
    expect(
      paneLabel({
        agentName: null,
        agentKind: null,
        foreground: "pnpm test",
        cwd: "/a/b",
        paneId: "w1:p1",
      }),
    ).toBe("pnpm test");
    expect(
      paneLabel({
        agentName: null,
        agentKind: null,
        foreground: null,
        cwd: "/a/b",
        paneId: "w1:p1",
      }),
    ).toBe("shell in b");
    expect(
      paneLabel({ agentName: null, agentKind: null, foreground: null, cwd: null, paneId: "w1:p1" }),
    ).toBe("w1:p1");
  });
});

describe("turning a pane into a candidate", () => {
  const pane = {
    paneId: "w1:p1",
    workspaceId: "w1",
    tabId: "w1:t1",
    cwd: "/work",
    agentStatus: "unknown",
  };

  it("maps a recognised agent's state by §9's table", () => {
    const candidate = toCandidate({
      pane,
      agent: { paneId: "w1:p1", name: "hermes-1", kind: "hermes", state: "blocked" },
      workspaceLabel: "ops",
      foreground: null,
    });
    expect(candidate.runtimeState).toBe("blocked");
    expect(candidate.state).toBe("needs_input");
    expect(candidate.agentKind).toBe("hermes");
    expect(candidate.location.workspace).toBe("ops");
  });

  it("calls an unclassified pane with something running 'monitoring', never 'needs_input'", () => {
    const candidate = toCandidate({
      pane,
      agent: null,
      workspaceLabel: "ops",
      foreground: "bash ticker.sh",
    });
    expect(candidate.state).toBe("monitoring");
    expect(candidate.label).toBe("bash ticker.sh");
  });

  it("calls an unclassified pane at its prompt 'idle'", () => {
    const candidate = toCandidate({ pane, agent: null, workspaceLabel: "ops", foreground: null });
    expect(candidate.state).toBe("idle");
  });

  it("still shows a pane whose state word Tessaya does not know, with no state (D38)", () => {
    const candidate = toCandidate({
      pane,
      agent: { paneId: "w1:p1", name: "a", kind: "claude", state: "compacting" },
      workspaceLabel: "ops",
      foreground: null,
    });
    expect(candidate.state).toBeNull();
    expect(candidate.runtimeState).toBe("compacting");
  });
});

describe("discovery against the captured CLI", () => {
  it.effect("returns the real panes, with the busy one and the idle one told apart", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* runAdapter(
        scriptedCli(
          [
            ["api snapshot", ok(SNAPSHOT)],
            ["pane process-info --pane w1:p1", ok(PROCESS_RUNNING)],
            ["pane process-info --pane w1:p2", ok(PROCESS_IDLE)],
          ],
          calls,
        ),
        (adapter) => adapter.discover,
      );

      expect(result.available).toBe(true);
      expect(result.reason).toBe("");
      const busy = result.candidates.find((entry) => entry.location.pane === "w1:p1");
      const idle = result.candidates.find((entry) => entry.location.pane === "w1:p2");
      expect(busy?.state).toBe("monitoring");
      expect(busy?.label).toContain("ticker.sh");
      expect(idle?.state).toBe("idle");
      // One snapshot call first, then one enrichment per agent-less pane — never
      // four list calls that can disagree with each other.
      expect(calls[0]).toEqual(["session", "list"]);
      expect(calls[1]).toEqual(["api", "snapshot"]);
    }),
  );

  it.effect("says the server is not running, which is not the same as not installed", () =>
    Effect.gen(function* () {
      const result = yield* runAdapter(
        scriptedCli([["api snapshot", failed(ERROR_NO_SERVER)]]),
        (adapter) => adapter.discover,
      );
      expect(result.available).toBe(false);
      expect(result.candidates).toEqual([]);
      expect(result.reason).toContain("herdr is installed here, but no server is running");
      expect(result.reason).not.toContain("not installed on this environment");
    }),
  );

  it.effect("quotes a refusal it did not expect, by code", () =>
    Effect.gen(function* () {
      const result = yield* runAdapter(
        scriptedCli([["api snapshot", failed('{"error":{"code":"forbidden","message":"nope"}}')]]),
        (adapter) => adapter.discover,
      );
      expect(result.reason).toContain("forbidden");
      expect(result.reason).toContain("nope");
    }),
  );

  it.effect("refuses unreadable output rather than reporting an empty server", () =>
    Effect.gen(function* () {
      const result = yield* runAdapter(
        scriptedCli([["api snapshot", ok("<html>proxy error</html>")]]),
        (adapter) => adapter.discover,
      );
      expect(result.available).toBe(false);
      expect(result.reason).toContain("not a shape Tessaya reads");
    }),
  );

  it.effect("says 'not installed' only when the binary really is absent", () =>
    Effect.gen(function* () {
      // The distinction the whole result shape exists for: this is a different
      // fact from "no server", and it has a different fix.
      const result = yield* runAdapter(
        scriptedCli([["api snapshot", missing()]]),
        (adapter) => adapter.discover,
      );
      expect(result.available).toBe(false);
      expect(result.reason).toContain("herdr is not installed on this environment");
    }),
  );
});

const session: Parameters<AdoptedRuntimeAdapter["Service"]["sendInput"]>[0]["session"] = {
  id: "herdr:w1:p1" as Parameters<
    AdoptedRuntimeAdapter["Service"]["sendInput"]
  >[0]["session"]["id"],
  runtime: "herdr",
  workSessionId: null,
  label: "ticker",
  location: { workspace: "proof", pane: "w1:p1", host: null },
  agentKind: null,
  state: "monitoring",
  capabilities: {
    readConversation: false,
    sendInput: true,
    approvals: false,
    diffs: false,
    stop: true,
    showTerminal: true,
  },
  observedAt: "2026-09-18T22:00:00.000Z",
  createdAt: "2026-09-18T22:00:00.000Z",
  detachedAt: null,
};

describe("typing into a pane", () => {
  it.effect("sends the text and, when asked, return", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* runAdapter(
        scriptedCli(
          [
            ["pane send-text", ok("{}")],
            ["pane send-keys", ok("{}")],
          ],
          calls,
        ),
        (adapter) => adapter.sendInput({ session, text: "status", submit: true }),
      );
      expect(result.delivered).toBe(true);
      expect(calls).toEqual([
        ["pane", "send-text", "w1:p1", "status"],
        ["pane", "send-keys", "w1:p1", "enter"],
      ]);
    }),
  );

  it.effect("does not press return unless asked", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* runAdapter(
        scriptedCli([["pane send-text", ok("{}")]], calls),
        (adapter) => adapter.sendInput({ session, text: "status", submit: false }),
      );
      expect(result.delivered).toBe(true);
      expect(result.detail).toContain("without pressing return");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("sends to an agent through its prompt, and nothing while it waits on a question", () =>
    Effect.gen(function* () {
      const agent = { ...session, agentKind: "claude" };
      const calls: Array<ReadonlyArray<string>> = [];
      const sent = yield* runAdapter(scriptedCli([["agent prompt", ok("{}")]], calls), (adapter) =>
        adapter.sendInput({ session: agent, text: "1 more thing", submit: true }),
      );
      expect(sent.delivered).toBe(true);
      expect(calls).toEqual([["agent", "prompt", "w1:p1", "1 more thing"]]);
      const blocked = yield* runAdapter(
        scriptedCli([
          ["agent prompt", failed('{"error":{"code":"agent_blocked","message":"blocked"}}')],
        ]),
        (adapter) => adapter.sendInput({ session: agent, text: "1 more thing", submit: true }),
      );
      expect(blocked.delivered).toBe(false);
      expect(blocked.detail).toContain("waiting on a question");
    }),
  );

  it.effect("says which half happened when the text lands and return does not", () =>
    Effect.gen(function* () {
      const result = yield* runAdapter(
        scriptedCli([
          ["pane send-text", ok("{}")],
          ["pane send-keys", failed('{"error":{"code":"pane_not_found","message":"gone"}}')],
        ]),
        (adapter) => adapter.sendInput({ session, text: "status", submit: true }),
      );
      expect(result.delivered).toBe(false);
      expect(result.detail).toContain("but return did not");
    }),
  );
});

describe("reading a pane", () => {
  it.effect("returns the terminal's text, wraps joined", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* runAdapter(
        scriptedCli([["pane read", ok(PANE_READ)]], calls),
        (adapter) => adapter.readOutput({ session, lines: 5 }),
      );
      expect(result.available).toBe(true);
      expect(result.output).toContain("tick");
      expect(calls[0]).toEqual([
        "pane",
        "read",
        "w1:p1",
        "--source",
        "recent-unwrapped",
        "--lines",
        "5",
      ]);
    }),
  );

  it.effect("refuses by name when the pane has gone", () =>
    Effect.gen(function* () {
      const result = yield* runAdapter(
        scriptedCli([["pane read", failed(ERROR_NO_PANE)]]),
        (adapter) => adapter.readOutput({ session, lines: 5 }),
      );
      expect(result.available).toBe(false);
      expect(result.detail).toContain("pane_not_found");
      expect(result.output).toBe("");
    }),
  );
});

describe("named sessions and blocked prompts (D65)", () => {
  it("reads herdr's session table, running sessions only", () => {
    expect(
      parseHerdrSessionList(
        "name status directory socket\ndefault running /a /a/s\nt3-x-default running /b /b/s\nold stopped /c /c/s\n",
      ),
    ).toEqual(["default", "t3-x-default"]);
  });

  it("carries a named session in the pane ref and splits it back", () => {
    expect(splitPaneRef("t3-x-default~w1:p1")).toEqual({ session: "t3-x-default", pane: "w1:p1" });
    expect(splitPaneRef("w1:p1")).toEqual({ session: null, pane: "w1:p1" });
  });

  it.effect("walks every running session and asks each with --session", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* runAdapter(
        scriptedCli(
          [
            [
              "session list",
              ok("name status dir sock\ndefault running /a /s\nt3-a-default running /b /s\n"),
            ],
            ["api snapshot", ok(SNAPSHOT)],
            ["--session t3-a-default api snapshot", ok(SNAPSHOT)],
            ["pane process-info", ok(PROCESS_IDLE)],
            ["--session t3-a-default pane process-info", ok(PROCESS_IDLE)],
          ],
          calls,
        ),
        (adapter) => adapter.discover,
      );
      expect(result.available).toBe(true);
      const named = result.candidates.filter((c) => c.location.pane.startsWith("t3-a-default~"));
      expect(named.length).toBeGreaterThan(0);
      expect(named[0]?.label).toContain("t3-a-default");
      expect(calls.some((args) => args.join(" ") === "--session t3-a-default api snapshot")).toBe(
        true,
      );
    }),
  );

  it.effect("puts a blocked agent's question on the candidate", () =>
    Effect.gen(function* () {
      const blocked = JSON.stringify({
        id: "cli:api:snapshot",
        result: {
          type: "session_snapshot",
          snapshot: {
            workspaces: [{ workspace_id: "w1", label: "web" }],
            panes: [
              {
                pane_id: "w1:p1",
                workspace_id: "w1",
                tab_id: "w1:t1",
                cwd: "/w",
                agent_status: "blocked",
              },
            ],
            agents: [{ pane_id: "w1:p1", name: "web", kind: "claude", agent_status: "blocked" }],
          },
        },
      });
      const result = yield* runAdapter(
        scriptedCli([
          ["api snapshot", ok(blocked)],
          [
            "pane read w1:p1",
            ok("Bash command rm -rf dist\nDo you want to proceed?\n1. Yes\n2. No\n"),
          ],
        ]),
        (adapter) => adapter.discover,
      );
      const candidate = result.candidates[0];
      expect(candidate?.state).toBe("needs_input");
      expect(candidate?.blockedPrompt).toContain("Do you want to proceed?");
    }),
  );
});
