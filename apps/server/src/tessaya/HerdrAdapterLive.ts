/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics effectFnOpportunity:off flatMapConditionalToFilterOrFail:off preferSchemaOverJson:off instanceOfSchema:off preferSucceedSomeOrNone:off
/**
 * Herdr, from the outside.
 *
 * Herdr is a separate program with its own licence and its own process. Baton
 * **integrates with it and ships none of it**: this module shells out to the
 * `herdr` binary's control surface and parses what it prints, exactly as a
 * person at a prompt would. See D37 and its 2026-09-18 correction — upstream is
 * `herdrdev/herdr`, Apache-2.0, and not the stale AGPL fork this was first
 * written against.
 *
 * Three answers, because they are three different facts with three different
 * fixes:
 *
 *   - **no binary** — "herdr is not installed on this environment";
 *   - **a binary but no server** — Herdr is here and nothing is running under
 *     it, so the fix is to start it, not to install anything;
 *   - **a server that refused** — its own error code and message, verbatim.
 *
 * The first two used to be one answer. `AdoptedDiscoverResult` carries a reason
 * rather than an empty list precisely so they do not have to be.
 *
 * What is deliberately absent: any attempt to start Herdr, install it, or run a
 * T3 provider through it. §9's first principle is that T3-owned providers keep
 * their own lifecycle, and adoption is for sessions outside it.
 *
 * Every shape below was captured from `herdr 0.9.1` running on the box — the
 * snapshot, the process info, both error envelopes and the plain-text read are
 * in `__fixtures__/herdr-0.9.1/`. None of it is written against a guess at what
 * the CLI might print.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  type AdoptedDiscoverResult,
  type AdoptedSessionCandidate,
} from "@t3tools/tessaya-contracts";
import { mapHerdrPaneState } from "@t3tools/tessaya-shared/adoptedSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AdoptedRuntimeAdapter } from "./AdoptedSessionService.ts";

/** The binary Herdr installs. Looked for, never installed. */
const HERDR_COMMAND = "herdr";

/** A call that has not answered in this long is a hung server, not an answer. */
const HERDR_TIMEOUT_MS = 10_000;

/**
 * How many panes Baton will ask about one at a time.
 *
 * The snapshot is a single call for the whole server, but a pane with no
 * recognised agent needs a second call to learn whether anything is running in
 * it. A hundred panes would be a hundred calls, so enrichment stops at this
 * many and the rest keep the state the snapshot gave them. A bounded answer on
 * a busy box beats an unbounded one.
 */
const MAX_PROCESS_INFO_CALLS = 40;

const NOT_INSTALLED =
  "herdr is not installed on this environment. Install it where the terminals are, or adopt sessions by hand.";

const serverNotRunning = (detail: string): string =>
  `herdr is installed here, but no server is running: ${detail}`;

const refused = (code: string, detail: string): string =>
  `herdr refused the request (${code}): ${detail}`;

// ---------------------------------------------------------------------------
// Running the binary
// ---------------------------------------------------------------------------

export interface HerdrCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * The binary itself is not on this machine.
   *
   * Carried on the result rather than answered by a separate availability
   * check, so "no binary", "no server" and "the server said no" all come back
   * through one seam and the tests can drive all three. The separate check this
   * replaces needed four Effect services to answer, and swallowed their absence
   * as `false` — which on a machine that *did* have Herdr would have reported
   * it missing forever, with no way to tell the difference.
   */
  readonly notInstalled: boolean;
}

/**
 * The one seam between Baton and another program.
 *
 * A service rather than a direct call so the tests can drive the adapter with
 * output captured from the real CLI, instead of needing Herdr installed to run
 * at all.
 */
export class HerdrCli extends Context.Service<
  HerdrCli,
  { readonly run: (args: ReadonlyArray<string>) => Effect.Effect<HerdrCommandResult> }
>()("t3/tessaya/HerdrAdapterLive/HerdrCli") {}

const runHerdrProcess = (args: ReadonlyArray<string>): Effect.Effect<HerdrCommandResult> =>
  Effect.callback<HerdrCommandResult>((resume) => {
    const child = NodeChildProcess.execFile(
      HERDR_COMMAND,
      [...args],
      { timeout: HERDR_TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A non-zero exit is an answer, not a defect: the CLI prints a JSON
        // error envelope on stderr and exits 1, and that envelope is exactly
        // what the refusal quotes back to the user. ENOENT is the one case
        // that is not an answer from Herdr at all — there is no Herdr.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resume(
          Effect.succeed({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error === null ? 0 : 1,
            notInstalled: code === "ENOENT",
          }),
        );
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });

export const cliLayer = Layer.succeed(HerdrCli, { run: runHerdrProcess });

// ---------------------------------------------------------------------------
// Reading what Herdr prints
// ---------------------------------------------------------------------------

/**
 * The CLI's error envelope: JSON on stderr, exit 1.
 *
 * `{"id":"cli:api:snapshot","error":{"code":"server_not_running","message":"…"}}`
 *
 * Null when stderr is not that — a panic, a missing library, a wrapper script
 * complaining — and the caller quotes the raw text instead, because a failure
 * it cannot parse is still a failure worth showing whole.
 */
export const parseHerdrError = (
  stderr: string,
): { readonly code: string; readonly message: string } | null => {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return null;
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof code !== "string" || code.length === 0) return null;
    return { code, message: typeof message === "string" ? message : code };
  } catch {
    return null;
  }
};

/** Whichever of the three refusals this failure is. */
const describeFailure = (result: HerdrCommandResult): string => {
  if (result.notInstalled) return NOT_INSTALLED;
  const error = parseHerdrError(result.stderr);
  if (error === null) return refused("unreadable", result.stderr.trim() || "no output");
  return error.code === "server_not_running"
    ? serverNotRunning(error.message)
    : refused(error.code, error.message);
};

export interface HerdrSnapshotPane {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd: string | null;
  readonly agentStatus: string;
}

export interface HerdrSnapshotAgent {
  readonly paneId: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly state: string | null;
}

export interface HerdrSnapshot {
  readonly workspaceLabels: ReadonlyMap<string, string>;
  readonly panes: ReadonlyArray<HerdrSnapshotPane>;
  readonly agents: ReadonlyArray<HerdrSnapshotAgent>;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
    : [];

/**
 * `herdr api snapshot` — the whole live server in one call.
 *
 * One call rather than `workspace list` + `tab list` + `pane list` + `agent
 * list`: four round trips can disagree with each other, and a fleet showing a
 * pane in a workspace that has just closed is worse than one a second behind.
 *
 * An entry missing the fields that identify it is skipped rather than guessed
 * at, and output this cannot read at all returns null so the caller says so by
 * name instead of reporting an empty server.
 */
export const parseHerdrSnapshot = (stdout: string): HerdrSnapshot | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const result = (parsed as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const snapshot = (result as { snapshot?: unknown }).snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const source = snapshot as Record<string, unknown>;

  const workspaceLabels = new Map<string, string>();
  for (const workspace of asRecordArray(source["workspaces"])) {
    const id = asString(workspace["workspace_id"]);
    if (id === null) continue;
    workspaceLabels.set(id, asString(workspace["label"]) ?? id);
  }

  const panes: Array<HerdrSnapshotPane> = [];
  for (const pane of asRecordArray(source["panes"])) {
    const paneId = asString(pane["pane_id"]);
    const workspaceId = asString(pane["workspace_id"]);
    if (paneId === null || workspaceId === null) continue;
    panes.push({
      paneId,
      workspaceId,
      tabId: asString(pane["tab_id"]) ?? workspaceId,
      cwd: asString(pane["foreground_cwd"]) ?? asString(pane["cwd"]),
      // Herdr always sends this; a pane that somehow lacks it is unclassified,
      // which is a weaker claim than any state word and the right default.
      agentStatus: asString(pane["agent_status"]) ?? "unknown",
    });
  }

  const agents: Array<HerdrSnapshotAgent> = [];
  for (const agent of asRecordArray(source["agents"])) {
    const paneId = asString(agent["pane_id"]);
    if (paneId === null) continue;
    agents.push({
      paneId,
      name: asString(agent["name"]),
      kind: asString(agent["kind"]) ?? asString(agent["agent_kind"]),
      state: asString(agent["state"]) ?? asString(agent["status"]),
    });
  }

  return { workspaceLabels, panes, agents };
};

/**
 * `herdr pane process-info --pane <id>` — what is actually running in a pane.
 *
 * The fact that separates a terminal doing something from a terminal sitting at
 * a prompt, for panes where Herdr has no agent to ask about. Returns the
 * foreground command, or null when the pane is at its prompt.
 *
 * **A non-empty `foreground_processes` is not the test, and assuming it was
 * would have been wrong.** A pane at a bare prompt reports one foreground
 * process — the shell itself:
 *
 *     fg_pgid=1393244  shell_pid=1393244  [(1393244, "/bin/bash")]
 *
 * and a pane running something reports a different group leader:
 *
 *     fg_pgid=1419932  shell_pid=1393241  [(1419932, "bash …/ticker.sh"), …]
 *
 * So the test is whether the foreground process group is the shell's own. Both
 * shapes are in `__fixtures__/herdr-0.9.1/`, captured from the two panes side
 * by side; the invented version of this function read every idle terminal as
 * busy.
 */
export const parseHerdrForeground = (stdout: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const result = (parsed as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const info = (result as { process_info?: unknown }).process_info;
  if (typeof info !== "object" || info === null) return null;
  const source = info as Record<string, unknown>;

  const shellPid = source["shell_pid"];
  const groupId = source["foreground_process_group_id"];
  if (typeof shellPid === "number" && typeof groupId === "number" && shellPid === groupId) {
    return null;
  }

  const processes = asRecordArray(source["foreground_processes"]);
  for (const entry of processes) {
    // The group leader first. The `sleep 2` behind a loop is the loop's own
    // plumbing rather than the work, and naming it would mislead.
    if (typeof groupId === "number" && entry["pid"] !== groupId) continue;
    const cmdline = asString(entry["cmdline"]) ?? asString(entry["name"]);
    if (cmdline !== null) return cmdline;
  }
  for (const entry of processes) {
    const cmdline = asString(entry["cmdline"]) ?? asString(entry["name"]);
    if (cmdline !== null) return cmdline;
  }
  return null;
};

/**
 * What to call a pane on screen.
 *
 * Herdr panes carry no title of their own, so the name has to come from
 * something true about it: the agent's name if it has one, else what is
 * running, else where it is. Never the bare pane id — "w1:p1" tells a user
 * nothing about which of their terminals this is.
 */
export const paneLabel = (input: {
  readonly agentName: string | null;
  readonly agentKind: string | null;
  readonly foreground: string | null;
  readonly cwd: string | null;
  readonly paneId: string;
}): string => {
  if (input.agentName !== null) {
    return input.agentKind === null ? input.agentName : `${input.agentName} (${input.agentKind})`;
  }
  if (input.foreground !== null) return input.foreground;
  if (input.cwd !== null) {
    const leaf = input.cwd.split("/").filter((part) => part.length > 0);
    const last = leaf[leaf.length - 1];
    if (last !== undefined) return `shell in ${last}`;
  }
  return input.paneId;
};

/**
 * Named Herdr sessions (D65). T3's own terminals live in `t3-*` sessions (D61)
 * and an agent can run in any of them, so discovery walks every running one.
 *
 * shortcut: a non-default session rides in the pane id as `<session>~<pane>`
 * so the adopted-session columns need no migration; upgrade to a `session`
 * column when adopted rows grow another field.
 */
export const SESSION_SEPARATOR = "~";

export const splitPaneRef = (
  pane: string,
): { readonly session: string | null; readonly pane: string } => {
  const at = pane.indexOf(SESSION_SEPARATOR);
  return at < 0
    ? { session: null, pane }
    : { session: pane.slice(0, at), pane: pane.slice(at + 1) };
};

/** `herdr session list` prints a table: name, status, directory, socket. */
export const parseHerdrSessionList = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "running")
    .map((parts) => parts[0] as string);

const sessionArgs = (session: string | null): ReadonlyArray<string> =>
  session === null || session === "default" ? [] : ["--session", session];

/** One discovered pane, in the shape `AdoptedDiscoverResult` wants. */
export const toCandidate = (input: {
  readonly pane: HerdrSnapshotPane;
  readonly agent: HerdrSnapshotAgent | null;
  readonly workspaceLabel: string;
  readonly foreground: string | null;
}): AdoptedSessionCandidate => {
  const runtimeState = input.agent?.state ?? input.pane.agentStatus;
  return {
    runtime: "herdr",
    label: paneLabel({
      agentName: input.agent?.name ?? null,
      agentKind: input.agent?.kind ?? null,
      foreground: input.foreground,
      cwd: input.pane.cwd,
      paneId: input.pane.paneId,
    }),
    location: {
      workspace: input.workspaceLabel,
      pane: input.pane.paneId,
      // Herdr's saved machines are reached with `--machine`; this adapter
      // speaks to the local server only, so the host is this one, and naming
      // another would be an invention.
      host: null,
    },
    agentKind: input.agent?.kind ?? null,
    runtimeState,
    // Carried so adopting this candidate derives the same state discovery did.
    // Without it a pane Herdr could not classify is discoverable and not
    // adoptable, which is most of the terminals §9 is for.
    foreground: input.foreground,
    cwd: input.pane.cwd,
    state: mapHerdrPaneState({
      agentStatus: runtimeState,
      hasForegroundProcess: input.foreground !== null,
    }),
  };
};

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* HerdrCli;

  const unavailable = (reason: string): AdoptedDiscoverResult => ({
    available: false,
    reason,
    candidates: [],
  });

  const discover: AdoptedRuntimeAdapter["Service"]["discover"] = Effect.gen(function* () {
    const listed = yield* cli.run(["session", "list"]);
    const names = listed.exitCode === 0 ? parseHerdrSessionList(listed.stdout) : [];
    const sessions = names.length === 0 ? ["default"] : names;
    const candidates: Array<AdoptedSessionCandidate> = [];
    let firstFailure: string | null = null;
    let anyAnswered = false;
    for (const session of sessions) {
      const result = yield* discoverSession(session);
      if (typeof result === "string") {
        firstFailure ??= result;
        continue;
      }
      anyAnswered = true;
      candidates.push(...result);
    }
    if (!anyAnswered) return unavailable(firstFailure ?? NOT_INSTALLED);
    return { available: true, reason: "", candidates } satisfies AdoptedDiscoverResult;
  });

  const discoverSession = (session: string) =>
    Effect.gen(function* () {
      const prefix = sessionArgs(session);
      const snapshotResult = yield* cli.run([...prefix, "api", "snapshot"]);
      if (snapshotResult.exitCode !== 0) return describeFailure(snapshotResult);

      const snapshot = parseHerdrSnapshot(snapshotResult.stdout);
      if (snapshot === null) {
        return refused(
          "unreadable",
          "herdr answered, but its snapshot was not a shape Tessaya reads",
        );
      }

      const agentByPane = new Map(snapshot.agents.map((agent) => [agent.paneId, agent]));

      let processInfoCalls = 0;
      const candidates: Array<AdoptedSessionCandidate> = [];
      for (const pane of snapshot.panes) {
        const agent = agentByPane.get(pane.paneId) ?? null;
        // Only a pane with no agent needs the second call. A recognised agent has
        // already told Herdr what it is doing.
        let foreground: string | null = null;
        if (agent === null && processInfoCalls < MAX_PROCESS_INFO_CALLS) {
          processInfoCalls += 1;
          const info = yield* cli.run([...prefix, "pane", "process-info", "--pane", pane.paneId]);
          foreground = info.exitCode === 0 ? parseHerdrForeground(info.stdout) : null;
        }
        const candidate = toCandidate({
          pane,
          agent,
          workspaceLabel: snapshot.workspaceLabels.get(pane.workspaceId) ?? pane.workspaceId,
          foreground,
        });
        const named = prefix.length > 0;
        const located: AdoptedSessionCandidate = named
          ? {
              ...candidate,
              label: `${candidate.label} · ${session}`,
              location: {
                ...candidate.location,
                pane: `${session}${SESSION_SEPARATOR}${pane.paneId}`,
              },
            }
          : candidate;
        // A blocked agent's question belongs in the fleet, not only in its pane.
        if (located.state === "needs_input") {
          const read = yield* cli.run([
            ...prefix,
            "pane",
            "read",
            pane.paneId,
            "--source",
            "recent-unwrapped",
            "--lines",
            "12",
          ]);
          candidates.push({
            ...located,
            blockedPrompt: read.exitCode === 0 ? read.stdout.trimEnd() : null,
          });
        } else {
          candidates.push(located);
        }
      }
      return candidates;
    });

  const sendInput: AdoptedRuntimeAdapter["Service"]["sendInput"] = (input) =>
    Effect.gen(function* () {
      const ref = splitPaneRef(input.session.location.pane);
      const pane = ref.pane;
      const prefix = sessionArgs(ref.session);

      // An agent pane takes the message through Herdr's own prompt, which refuses while the agent
      // waits on a question: blind keys there would answer the question ("1 more thing" picks option 1).
      if (input.session.agentKind !== null && input.submit) {
        const prompted = yield* cli.run([...prefix, "agent", "prompt", pane, input.text]);
        if (prompted.exitCode === 0)
          return { delivered: true, detail: `sent to ${input.session.label} and submitted.` };
        return {
          delivered: false,
          detail: /agent_blocked/.test(prompted.stdout + prompted.stderr)
            ? `${input.session.label} is waiting on a question or an approval in its terminal, so nothing was sent. Answer it there first, then send again.`
            : describeFailure(prompted),
        };
      }

      const typed = yield* cli.run([...prefix, "pane", "send-text", pane, input.text]);
      if (typed.exitCode !== 0) return { delivered: false, detail: describeFailure(typed) };

      if (!input.submit) {
        return {
          delivered: true,
          detail: `typed into ${input.session.label} without pressing return.`,
        };
      }

      const submitted = yield* cli.run([...prefix, "pane", "send-keys", pane, "enter"]);
      if (submitted.exitCode !== 0) {
        // The text is in the pane and return is not. Reporting "delivered"
        // would hide half of what happened, so this refusal says which half.
        return {
          delivered: false,
          detail: `the text reached ${input.session.label}, but return did not: ${describeFailure(
            submitted,
          )}`,
        };
      }
      return { delivered: true, detail: `sent to ${input.session.label} and submitted.` };
    });

  const readOutput: AdoptedRuntimeAdapter["Service"]["readOutput"] = (input) =>
    Effect.gen(function* () {
      const ref = splitPaneRef(input.session.location.pane);
      const result = yield* cli.run([
        ...sessionArgs(ref.session),
        "pane",
        "read",
        ref.pane,
        // Soft wraps joined: a line of a transcript that a wrap split in two is
        // one line of work, and reading it as two is how a log stops being
        // searchable.
        "--source",
        "recent-unwrapped",
        "--lines",
        String(input.lines),
      ]);
      if (result.exitCode !== 0) {
        return { available: false, detail: describeFailure(result), output: "" };
      }
      // Plain text, not JSON: `pane read` prints the terminal verbatim.
      return { available: true, detail: "", output: result.stdout };
    });

  return { discover, sendInput, readOutput } satisfies AdoptedRuntimeAdapter["Service"];
});

export const layer = Layer.effect(AdoptedRuntimeAdapter, make).pipe(Layer.provide(cliLayer));

/** The same adapter over a caller-supplied CLI, for the tests. */
export const layerWith = (
  run: (args: ReadonlyArray<string>) => Effect.Effect<HerdrCommandResult>,
): Layer.Layer<AdoptedRuntimeAdapter> =>
  Layer.effect(AdoptedRuntimeAdapter, make).pipe(Layer.provide(Layer.succeed(HerdrCli, { run })));
