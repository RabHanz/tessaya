import { describe, expect, it, vi } from "vite-plus/test";

import { CARD_START, fromSpoken, offerQuestion, reduceCard, type CardState } from "./card.ts";
import { sshProviders } from "./sshShell.ts";
import { hubProvider, serveCloudCall, type Described } from "./hub.ts";
import {
  claudeHarness,
  codexHarness,
  localProvider,
  weeklyForLogin,
  type BriefStore,
  type PendingStore,
} from "./local.ts";
import { jsonLines, safeArg } from "./parse.ts";
import { providerChoices } from "./registry.ts";
import { STUBS } from "./stubs.ts";
import { findProgram, launchPlan, scriptOfNpmShim, type LaunchEnv } from "./winLaunch.ts";
import {
  overCap,
  pickable,
  type CloudProvider,
  type CloudRequest,
  type Exec,
  type ExecResult,
  type ProviderId,
  type Usage,
} from "./types.ts";

type Call = {
  file: string;
  args: ReadonlyArray<string>;
  stdin?: string;
  env?: Readonly<Record<string, string>>;
  cwd?: string;
};
/** A fake process runner: records calls, answers from a script keyed by the first words of the arguments. */
const fakeExec = (answer: (c: Call) => Partial<ExecResult>) => {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, o) => {
    const c: Call = {
      file,
      args,
      ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
      ...(o.env === undefined ? {} : { env: o.env }),
      ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    };
    calls.push(c);
    return { code: 0, stdout: "", stderr: "", ...answer(c) };
  };
  return { exec, calls };
};
const memoryStores = () => {
  let list: ReadonlyArray<CloudRequest> = [];
  const briefs = new Map<string, string>();
  let n = 0;
  const store: PendingStore = {
    load: () => list,
    save: (l) => void (list = l),
    nextId: () => `L-${(n += 1)}`,
  };
  const brief: BriefStore = {
    get: (id) => briefs.get(id) ?? null,
    put: (id, b) => void briefs.set(id, b),
    drop: (id) => void briefs.delete(id),
  };
  return { store, brief };
};
const input = {
  repo: "o/r",
  branch: "feat/x",
  brief: "Fix the flaky test\nmore detail",
  label: "session 1",
};
const SSH = { host: "box", user: "dev", machineKey: "/k/machine", approverKey: "/k/approver" };

const SHELL_USAGE = JSON.stringify({
  cap_points_per_run: 2.0,
  points_used_7d: { claude: { robin: 1.5 } },
  providers: {
    claude: {
      ready: true,
      needs: null,
      accounts: {
        optima: { available: true, pct: 0.0, rejected: false, resets_pkt: "Mon 18:00" },
        robin: { available: true, pct: 41.0, rejected: false, resets_pkt: "Mon 14:00" },
        sablebox: { available: false, pct: 100.0, rejected: true, resets_pkt: "Mon 12:00" },
      },
    },
    codex: {
      ready: false,
      needs: "a codex-cloud wrapper running `codex cloud exec`",
      accounts: {},
    },
  },
});
const SHELL_DISPATCH = JSON.stringify({
  card: {
    asked_by: "orchestrator / t3code-ab",
    branch: "feat/x",
    cap_points: 2.0,
    id: "20261102-1308-e85d",
    repo: "o/r",
    suggested_provider: "claude",
    task: "Fix the flaky test",
    usage: "unknown until measured",
  },
  id: "20261102-1308-e85d",
  state: "awaiting-director",
});

describe("transport 3: the shared computer's dispatch shell", () => {
  const claude = (exec: Exec, over: Partial<typeof SSH> = {}) =>
    sshProviders({ ...SSH, ...over }, exec).find((p) => p.id === "claude")!;

  it("sends the brief on stdin, names the provider, and passes every value as a plain argument", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: SHELL_DISPATCH }));
    const r = await claude(exec).dispatch({ ...input, expectedUsage: 1 });
    expect(r.ok && r.value).toMatchObject({
      id: "20261102-1308-e85d",
      state: "awaiting-director",
      task: "Fix the flaky test",
      provider: "claude",
      caller: "orchestrator / t3code-ab",
    });
    expect(calls[0]!.file).toBe("ssh");
    expect(calls[0]!.args).toEqual([
      "-i",
      "/k/machine",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=10",
      "dev@box",
      "dispatch",
      "--provider",
      "claude",
      "--repo",
      "o/r",
      "--branch",
      "feat/x",
      "--task-file",
      "-",
      "--label",
      "session-1",
    ]);
    expect(calls[0]!.stdin).toBe(input.brief);
  });

  it("does not read the terminal when there is no brief to send (ssh -n)", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "{}" }));
    await claude(exec).status("20261102-1308-e85d");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-n", "-i", "/k/machine"]);
    expect(calls[0]!.args.slice(-2)).toEqual(["status", "20261102-1308-e85d"]);
  });

  it("refuses a value that could change the remote command, and a brief that is too long or empty", async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const p = claude(exec);
    expect((await p.dispatch({ ...input, branch: "x; rm -rf /" })).ok).toBe(false);
    expect((await p.dispatch({ ...input, repo: "o/r $(id)" })).ok).toBe(false);
    expect(await p.dispatch({ ...input, brief: "x".repeat(4001) })).toEqual({
      ok: false,
      error: "A cloud brief is at most 4000 characters.",
    });
    expect((await p.dispatch({ ...input, brief: "  " })).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(() => safeArg("a b", "x")).toThrow();
  });

  it("uses the approver key only for approve and deny, and names the provider and account chosen", async () => {
    const { exec, calls } = fakeExec(() => ({
      stdout:
        '{"id":"20261102-1308-e85d","state":"running","provider":"claude","account":"robin","session":"https://claude.ai/code/s","ledger":null,"weekly_before":0.0,"error":null}',
    }));
    const p = claude(exec);
    await p.status("20261102-1308-e85d");
    const done = await p.approve("20261102-1308-e85d", "robin", "card-1");
    await p.deny("20261102-1308-e85d", "not now please");
    expect(calls.map((c) => c.args[c.args.indexOf("-i") + 1])).toEqual([
      "/k/machine",
      "/k/approver",
      "/k/approver",
    ]);
    expect(calls[1]!.args.slice(-8)).toEqual([
      "approve",
      "20261102-1308-e85d",
      "--provider",
      "claude",
      "--account",
      "robin",
      "--answer-ref",
      "card-1",
    ]);
    expect(calls[2]!.args.slice(-4)).toEqual([
      "deny",
      "20261102-1308-e85d",
      "--reason",
      "not-now-please",
    ]);
    expect(done.ok && done.value).toMatchObject({
      state: "running",
      account: "robin",
      sessionLink: "https://claude.ai/code/s",
    });
  });

  it("reads the shell's usage: unknown stays unknown, rejected and unavailable are not offered, readiness says what a provider needs", async () => {
    const { exec } = fakeExec(() => ({ stdout: SHELL_USAGE }));
    const ps = sshProviders(SSH, exec);
    const claudeP = ps.find((p) => p.id === "claude")!;
    const u = await claudeP.usage();
    expect(
      u.ok &&
        u.value.map((x) => [
          x.provider,
          x.account,
          x.weeklyPercent,
          x.resetsAt,
          x.rejected,
          x.pointsThisWeek,
        ]),
    ).toEqual([
      ["claude", "optima", 0, "Mon 18:00", false, null],
      ["claude", "robin", 41, "Mon 14:00", false, 1.5],
      ["claude", "sablebox", 100, "Mon 12:00", true, null],
    ]);
    expect(claudeP.accounts()).toEqual(["optima", "robin", "sablebox"]);
    const codex = ps.find((p) => p.id === "codex")!;
    expect(codex.setup()).toMatchObject({
      state: "not-set-up",
      needs: "a codex-cloud wrapper running `codex cloud exec`",
    });
    expect((await codex.detect()).signedIn).toBe(false);
    expect(pickable({ weeklyPercent: null, rejected: false, available: true }).enabled).toBe(true);
    // The shell's own login state: sign-in needed closes the account, a login about to lapse only says so.
    expect(
      pickable({ weeklyPercent: 5, rejected: false, available: true, login: "not-logged-in" }),
    ).toEqual({ enabled: false, why: "sign in needed" });
    expect(pickable({ weeklyPercent: 5, rejected: false, login: "expired" })).toEqual({
      enabled: false,
      why: "sign in needed",
    });
    expect(pickable({ weeklyPercent: 5, rejected: false, login: "renew-soon" })).toEqual({
      enabled: true,
      why: "login renews soon",
    });
    expect(pickable({ weeklyPercent: null, rejected: false, login: "renew-soon" }).why).toBe(
      "usage unknown; login renews soon",
    );
    expect(pickable({ weeklyPercent: 5, rejected: false, login: "ok" })).toEqual({
      enabled: true,
      why: null,
    });
    expect(pickable({ weeklyPercent: 5, rejected: false, available: false })).toEqual({
      enabled: false,
      why: "not available",
    });
  });

  it("reads each account's login from the shell's usage", async () => {
    const usage = JSON.stringify({
      providers: {
        claude: {
          ready: true,
          needs: null,
          accounts: {
            a: { available: true, pct: 3.0, rejected: false, resets_pkt: "Mon 12:00", login: "ok" },
            b: {
              available: false,
              pct: null,
              rejected: false,
              resets_pkt: null,
              login: "not-logged-in",
            },
            c: {
              available: true,
              pct: 9.0,
              rejected: false,
              resets_pkt: "Mon 14:00",
              login: "renew-soon",
            },
          },
        },
      },
    });
    const u = await claude(fakeExec(() => ({ stdout: usage })).exec).usage();
    expect(u.ok && u.value.map((x) => [x.account, x.login])).toEqual([
      ["a", "ok"],
      ["b", "not-logged-in"],
      ["c", "renew-soon"],
    ]);
  });

  it("says in plain words what went wrong, shows a refusal as the shell worded it, and never prints a key", async () => {
    const run = async (r: Partial<ExecResult>, over: Partial<typeof SSH> = {}) =>
      (await claude(fakeExec(() => r).exec, over).status("1")) as { ok: false; error: string };
    expect((await run({ missing: true, code: null })).error).toContain("ssh is not installed");
    expect(
      (await run({ code: 255, stderr: "ssh: connect to host box port 22: Connection refused" }))
        .error,
    ).toBe("The shared computer could not be reached.");
    expect((await run({ code: 255, stderr: "Permission denied (publickey)." })).error).toBe(
      "The sending key was not accepted.",
    );
    expect(
      (await run({ code: 1, stdout: '{"refused":"codex cannot run yet: it needs a wrapper"}' }))
        .error,
    ).toBe("codex cannot run yet: it needs a wrapper");
    const unset = await run({}, { host: "" });
    expect(unset.error).toBe("The shared computer is not set up on this computer.");
    for (const e of [await run({ code: 255, stderr: "Load key /k/machine: bad" }), unset])
      expect(JSON.stringify(e)).not.toContain("/k/");
    const noApprover = (await claude(fakeExec(() => ({})).exec, { approverKey: "" }).approve(
      "1",
      "a",
      "r",
    )) as { ok: false; error: string };
    expect(noApprover.error).toContain("approval key is not set");
  });

  it("takes a key kept in the vault for one call and removes it after, even when the call fails", async () => {
    const log: string[] = [];
    const keyFor = async (role: "machine" | "approver") => (
      log.push(`use ${role}`),
      { path: `/tmp/${role}-key`, done: () => void log.push(`done ${role}`) }
    );
    const { exec, calls } = fakeExec(() => ({ code: 255, stderr: "Connection refused" }));
    const p = sshProviders(
      { host: "box", user: "dev", machineKey: "", approverKey: "", keyFor },
      exec,
    ).find((x) => x.id === "claude")!;
    const r = await p.approve("1", "a", "r");
    expect(r.ok).toBe(false);
    expect(calls[0]!.args[calls[0]!.args.indexOf("-i") + 1]).toBe("/tmp/approver-key");
    expect(log).toEqual(["use approver", "done approver"]);
    const denied = sshProviders(
      {
        host: "box",
        user: "dev",
        machineKey: "",
        approverKey: "",
        keyFor: async () => ({ error: "The key was not used: it was not confirmed." }),
      },
      exec,
    ).find((x) => x.id === "claude")!;
    expect(await denied.status("1")).toEqual({
      ok: false,
      error: "The key was not used: it was not confirmed.",
    });
    expect(calls).toHaveLength(1);
  });

  it("reads a list in the shell's shape, with string ids, and a state it names failed-to-start", async () => {
    const list = JSON.stringify({
      requests: [
        {
          account: null,
          branch: "b",
          caller: "orchestrator",
          id: "20261102-1308-e85d",
          label: "t3code-ab",
          points_used: null,
          provider: "claude",
          repo: "o/r",
          state: "awaiting-director",
        },
        {
          account: "robin",
          branch: "c",
          caller: "orchestrator",
          id: "20261102-1400-aaaa",
          label: "t3code-ab",
          points_used: 2.5,
          provider: "claude",
          repo: "o/r",
          state: "closed",
          pr: "https://github.com/o/r/pull/9",
          over_cap: true,
        },
        {
          id: "20261102-1500-bbbb",
          provider: "claude",
          state: "failed-to-start",
          error: "claude exited 1",
        },
      ],
    });
    const { exec, calls } = fakeExec(() => ({ stdout: list }));
    const l = await claude(exec).list({ mine: true, label: "t3code-ab" });
    expect(
      l.ok &&
        l.value.map((r) => [
          r.id,
          r.state,
          r.pointsUsed,
          r.overCap,
          r.result?.url ?? null,
          r.error,
        ]),
    ).toEqual([
      ["20261102-1308-e85d", "awaiting-director", null, false, null, null],
      ["20261102-1400-aaaa", "closed", 2.5, true, "https://github.com/o/r/pull/9", null],
      ["20261102-1500-bbbb", "failed", null, false, null, "claude exited 1"],
    ]);
    expect(calls[0]!.args.slice(-4)).toEqual(["list", "--mine", "--label", "t3code-ab"]);
    expect(jsonLines('{"a":1}\nnot json\n{"b":2}\n')).toHaveLength(2);
  });
});

describe("transport 1: this computer's own harness", () => {
  it("shows plain states, with the exact line to sign in", async () => {
    const signedIn = fakeExec(() => ({ stdout: '{"loggedIn":true,"email":"me@example.org"}' }));
    expect((await claudeHarness(signedIn.exec).detect()).line).toBe(
      "Claude: signed in as me@example.org",
    );
    expect(signedIn.calls[0]!.args).toEqual(["auth", "status", "--json"]);
    const out = await claudeHarness(
      fakeExec(() => ({ stdout: '{"loggedIn":false}' })).exec,
    ).detect();
    expect(out).toMatchObject({
      installed: true,
      signedIn: false,
      signInCommand: "claude auth login",
    });
    expect(
      (await claudeHarness(fakeExec(() => ({ missing: true, code: null })).exec).detect())
        .installed,
    ).toBe(false);
    const codex = await codexHarness(
      fakeExec((c) => (c.args[0] === "login" ? { stdout: "Logged in using ChatGPT\n" } : {})).exec,
    ).detect();
    expect(codex).toMatchObject({ signedIn: true, line: "Codex: Logged in using ChatGPT" });
    expect(
      (await codexHarness(fakeExec(() => ({ code: 1, stderr: "Not logged in" })).exec).detect())
        .signInCommand,
    ).toBe("codex login");
  });

  it("holds a request, starts nothing until approved, then runs the harness once with its own login", async () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[0] === "--cloud"
        ? { stdout: "Started: https://claude.ai/code/session_abc\n" }
        : { stdout: '{"loggedIn":true,"email":"me@example.org"}' },
    );
    const { store, brief } = memoryStores();
    const h = claudeHarness(exec);
    const p = localProvider(h, store, brief);
    await p.detect();
    const made = await p.dispatch(input);
    expect(made.ok && made.value.state).toBe("awaiting-director");
    expect(calls.filter((c) => c.args[0] === "--cloud")).toHaveLength(0);
    expect((await p.approve("L-1", "someone@example.net", "r")).ok).toBe(false);
    const done = await p.approve("L-1", "me@example.org", "r");
    expect(done.ok && done.value).toMatchObject({
      state: "running",
      account: "me@example.org",
      sessionLink: "https://claude.ai/code/session_abc",
    });
    expect(calls.filter((c) => c.args[0] === "--cloud")).toHaveLength(1);
    expect(calls.every((c) => c.env === undefined)).toBe(true);
    expect((await p.approve("L-1", "me@example.org", "r")).ok).toBe(false);
  });

  it("starts a request once when two approvals arrive together, and a failed start can be approved again", async () => {
    let starts = 0;
    let failNext = true;
    const { exec } = fakeExec((c) => {
      if (c.args[0] !== "--cloud") return { stdout: '{"loggedIn":true,"email":"me@example.org"}' };
      starts += 1;
      if (failNext) return ((failNext = false), { code: 1 });
      return { stdout: "https://claude.ai/code/session_abc\n" };
    });
    const { store, brief } = memoryStores();
    const p = localProvider(claudeHarness(exec), store, brief);
    await p.detect();
    await p.dispatch(input);
    expect((await p.approve("L-1", "me@example.org", "r")).ok).toBe(false);
    expect(store.load()[0]!.state).toBe("awaiting-director");
    const [a, b] = await Promise.all([
      p.approve("L-1", "me@example.org", "r"),
      p.approve("L-1", "me@example.org", "r"),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(starts).toBe(2);
    expect(store.load()[0]!.state).toBe("running");
  });

  it("puts a request left approved by a crashed start back to waiting, but not one whose start is still running", async () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[0] === "--cloud"
        ? { stdout: "https://claude.ai/code/session_abc\n" }
        : { stdout: '{"loggedIn":true,"email":"me@example.org"}' },
    );
    const { store, brief } = memoryStores();
    const p = localProvider(claudeHarness(exec), store, brief);
    await p.detect();
    await p.dispatch(input);
    store.save(
      store.load().map((r) => ({ ...r, state: "approved" as const, account: "me@example.org" })),
    );
    const listed = await p.list({});
    expect(listed.ok && listed.value.map((r) => [r.state, r.account])).toEqual([
      ["awaiting-director", null],
    ]);
    expect((await p.approve("L-1", "me@example.org", "r")).ok).toBe(true);
    expect(calls.filter((c) => c.args[0] === "--cloud")).toHaveLength(1);

    let release = () => {};
    const slow: Exec = (file, args, o) =>
      args[0] === "--cloud"
        ? new Promise((resolve) => (release = () => resolve({ code: 0, stdout: "", stderr: "" })))
        : exec(file, args, o);
    const q = localProvider(claudeHarness(slow), store, brief);
    await q.detect();
    await q.dispatch(input);
    const pending = q.approve("L-2", "me@example.org", "r");
    const during = await q.list({});
    expect(during.ok && during.value.find((r) => r.id === "L-2")?.state).toBe("approved");
    release();
    expect((await pending).ok).toBe(true);
  });

  it("leaves a request another process is still starting, and resets one whose starter is gone or overran", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
    const { store, brief } = memoryStores();
    const p = localProvider(claudeHarness(fakeExec(() => ({})).exec), store, brief);
    await p.dispatch(input);
    await p.dispatch(input);
    await p.dispatch(input);
    // The desktop and the server share this list; a fresh start by a live process must survive the other's load.
    const owners = [
      { pid: process.pid, at: 10_000_000 },
      { pid: 2 ** 30, at: 10_000_000 },
      { pid: process.pid, at: 0 },
    ];
    store.save(
      store.load().map((r, i) => ({
        ...r,
        state: "approved" as const,
        account: "me",
        startedBy: owners[i]!,
      })),
    );
    const listed = await p.list({});
    expect(listed.ok && listed.value.map((r) => r.state)).toEqual([
      "approved",
      "awaiting-director",
      "awaiting-director",
    ]);
    expect((await p.approve("L-1", "me", "r")).ok).toBe(false);
  });

  it("withdraws a waiting request but not a running one, and denies without running", async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const { store, brief } = memoryStores();
    const p = localProvider(codexHarness(exec, { codexEnv: "env_1" }), store, brief);
    await p.dispatch(input);
    await p.dispatch(input);
    expect((await p.cancel("L-1")).ok).toBe(true);
    expect((await p.deny("L-2", "no")).ok).toBe(true);
    expect(store.load().map((r) => r.state)).toEqual(["cancelled", "denied"]);
    expect(calls).toHaveLength(0);
  });

  it("starts Codex with the named login folder and reads its diff", async () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[1] === "exec"
        ? { stdout: "Submitted task_abc123\n" }
        : c.args[1] === "diff"
          ? { stdout: "diff --git a b\n" }
          : {},
    );
    const { store, brief } = memoryStores();
    const p = localProvider(
      codexHarness(exec, { codexEnv: "env_1", codexHomes: { work: "/h/work" } }),
      store,
      brief,
    );
    await p.dispatch(input);
    const ok = await p.approve("L-1", "work", "r");
    expect(ok.ok && ok.value.sessionLink).toBe("task_abc123");
    expect(calls[0]).toMatchObject({ file: "codex", env: { CODEX_HOME: "/h/work" } });
    expect(calls[0]!.args.slice(0, 6)).toEqual([
      "cloud",
      "exec",
      "--env",
      "env_1",
      "--branch",
      "feat/x",
    ]);
    expect(calls[0]!.args[6]).toBe(input.brief);
    const d = await p.diff!("L-1");
    expect(d.ok && d.value).toContain("diff --git");
    expect(calls[1]!.args).toEqual(["cloud", "diff", "task_abc123"]);
    expect((await p.apply!("L-1", "")).ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect((await p.apply!("L-1", "/work/repo")).ok).toBe(true);
    expect(calls[2]).toMatchObject({ args: ["cloud", "apply", "task_abc123"], cwd: "/work/repo" });
  });

  it("needs a Codex environment before it starts anything", async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const { store, brief } = memoryStores();
    const p = localProvider(codexHarness(exec), store, brief);
    await p.dispatch(input);
    const r = await p.approve("L-1", "This computer's Codex login", "r");
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("transport 2: through the hub's connection", () => {
  const described = async (providers: Map<ProviderId, CloudProvider>) => {
    const r = await serveCloudCall(providers, { op: "describe" });
    return (r.ok ? r.value : []) as Described[];
  };

  it("runs a call on the hub's providers and returns plain data", async () => {
    const { exec } = fakeExec(() => ({ stdout: '{"loggedIn":true,"email":"hub@example.org"}' }));
    const { store, brief } = memoryStores();
    const providers = new Map<ProviderId, CloudProvider>([
      ["claude", localProvider(claudeHarness(exec), store, brief)],
    ]);
    const [d] = await described(providers);
    expect(d).toMatchObject({
      id: "claude",
      detection: { signedIn: true, identity: "hub@example.org" },
    });
    const far = hubProvider(d!, (op, provider, args) =>
      serveCloudCall(providers, { op, provider, args }),
    );
    const made = await far.dispatch(input);
    expect(made.ok && made.value.state).toBe("awaiting-director");
    expect((await far.list({})).ok).toBe(true);
    expect(far.transport).toBe("hub");
  });

  it("says plainly when the hub does not have the provider, and never throws", async () => {
    const r = await serveCloudCall(new Map(), { op: "dispatch", provider: "codex", args: {} });
    expect(r).toEqual({
      ok: false,
      error: "That cloud provider is not set up on the computer that runs cloud tasks.",
    });
    const { store, brief } = memoryStores();
    const boom = {
      ...localProvider(claudeHarness(fakeExec(() => ({})).exec), store, brief),
      status: async () => {
        throw new Error("secret detail");
      },
    };
    const e = await serveCloudCall(new Map([["claude", boom as CloudProvider]]), {
      op: "status",
      provider: "claude",
      args: { id: "1" },
    });
    expect(e).toEqual({
      ok: false,
      error: "The computer that runs cloud tasks failed on that request.",
    });
    expect((await serveCloudCall(new Map(), { op: "rm -rf" })).ok).toBe(false);
  });
});

describe("the approval card, for any provider", () => {
  const usage: Usage[] = [
    {
      provider: "claude",
      account: "sablebox",
      weeklyPercent: 9,
      resetsAt: "Monday 12:00 PKT",
      rejected: false,
      pointsThisWeek: 1,
    },
    {
      provider: "claude",
      account: "robin",
      weeklyPercent: 41,
      resetsAt: "Monday 14:00 PKT",
      rejected: false,
      pointsThisWeek: null,
    },
    {
      provider: "claude",
      account: "optima",
      weeklyPercent: 100,
      resetsAt: "Monday 18:00 PKT",
      rejected: true,
      pointsThisWeek: null,
    },
    {
      provider: "codex",
      account: "work",
      weeklyPercent: null,
      resetsAt: null,
      rejected: false,
      pointsThisWeek: null,
    },
  ];
  const providers: CloudProvider[] = [
    {
      ...sshProviders(SSH, fakeExec(() => ({ stdout: SHELL_USAGE })).exec).find(
        (p) => p.id === "claude",
      )!,
      accounts: () => ["sablebox", "robin", "optima"],
    },
    localProvider(
      codexHarness(fakeExec(() => ({})).exec, { codexHomes: { work: "/h" } }),
      memoryStores().store,
      memoryStores().brief,
    ),
    ...STUBS,
  ];
  const choices = providerChoices(providers, usage, new Set<ProviderId>(["claude", "codex"]));

  it("asks for the provider first; only set-up providers are enabled; nothing is preselected", () => {
    expect(choices.map((c) => [c.id, c.enabled])).toEqual([
      ["claude", true],
      ["codex", true],
      ["gemini", false],
      ["cursor", false],
      ["opencode", false],
      ["grok", false],
    ]);
    expect(choices.find((c) => c.id === "gemini")!.why).toContain("no adapter yet");
    expect(CARD_START).toEqual({ phase: "provider" });
    const notReady = providerChoices(providers, usage, new Set<ProviderId>(["claude"]));
    expect(notReady.find((c) => c.id === "codex")).toMatchObject({ enabled: false });
  });

  it("disables an account that is rejected or at 98% or more, and shows the live figures", () => {
    const claude = choices.find((c) => c.id === "claude")!;
    expect(claude.accounts.map((a) => [a.account, a.enabled, a.percent, a.resets])).toEqual([
      ["sablebox", true, 9, "Monday 12:00 PKT"],
      ["robin", true, 41, "Monday 14:00 PKT"],
      ["optima", false, 100, "Monday 18:00 PKT"],
    ]);
    expect(pickable({ weeklyPercent: 98, rejected: false }).enabled).toBe(false);
    expect(pickable({ weeklyPercent: 97, rejected: false }).enabled).toBe(true);
    expect(claude.accounts[2]!.why).toBe("rejected");
  });

  it("walks provider, account, confirm; a disabled choice cannot be picked; going back clears it", () => {
    let s: CardState = CARD_START;
    s = reduceCard(s, { type: "provider", provider: "gemini" }, choices);
    expect(s).toEqual(CARD_START);
    s = reduceCard(s, { type: "account", account: "robin" }, choices);
    expect(s).toEqual(CARD_START);
    s = reduceCard(s, { type: "provider", provider: "claude" }, choices);
    s = reduceCard(s, { type: "account", account: "optima" }, choices);
    expect(s).toEqual({ phase: "account", provider: "claude" });
    s = reduceCard(s, { type: "confirm" }, choices);
    expect(s.phase).toBe("account");
    s = reduceCard(s, { type: "account", account: "robin" }, choices);
    expect(s).toEqual({ phase: "confirm", provider: "claude", account: "robin" });
    expect(reduceCard(s, { type: "back" }, choices)).toEqual({
      phase: "account",
      provider: "claude",
    });
    s = reduceCard(s, { type: "confirm" }, choices);
    expect(s.phase).toBe("approving");
    expect(reduceCard(s, { type: "deny" }, choices).phase).toBe("approving");
    const failed = reduceCard(
      s,
      { type: "failed", message: "The approval key was not accepted." },
      choices,
    );
    expect(failed.phase).toBe("error");
    expect(reduceCard(failed, { type: "retry" }, choices)).toEqual({
      phase: "account",
      provider: "claude",
    });
    expect(reduceCard(s, { type: "approved" }, choices)).toEqual({
      phase: "done",
      provider: "claude",
      account: "robin",
    });
    expect(reduceCard(CARD_START, { type: "deny" }, choices)).toEqual({ phase: "denied" });
  });

  it("offers the card as one question with a button per open choice, deny and later, and no default", () => {
    const q = offerQuestion(choices, {
      pick: (l, a, u) => `${l} - ${a} (${u})`,
      deny: "Deny",
      later: "Decide later",
    });
    expect(q.buttons).toEqual([
      "Claude - sablebox (9% used)",
      "Claude - robin (41% used)",
      "Codex - work (usage unknown)",
      "Deny",
      "Decide later",
    ]);
    expect(q.picks[0]).toEqual({ kind: "pick", provider: "claude", account: "sablebox" });
    expect(q.picks.slice(-2)).toEqual([{ kind: "deny" }, { kind: "later" }]);
    expect(q.cancel).toBe(4);
    expect(q.buttons.join()).not.toContain("optima");
  });

  it("a spoken approval repeats the account, stops at the confirm step and reads the card back", () => {
    const ok = fromSpoken(choices, { account: "Robin" });
    expect("state" in ok && ok.state).toEqual({
      phase: "confirm",
      provider: "claude",
      account: "robin",
    });
    expect("readBack" in ok && ok.readBack).toContain("account robin, 41% used this week");
    expect(fromSpoken(choices, { account: "optima" })).toEqual({
      refused: "optima cannot be used now: rejected.",
    });
    expect("refused" in fromSpoken(choices, { account: "nobody" })).toBe(true);
    expect("refused" in fromSpoken(choices, { provider: "gemini", account: "robin" })).toBe(true);
  });
});

describe("one cap for every provider", () => {
  it("flags a run over 2 points on its own figure, and a provider with no figure never trips it", () => {
    expect(overCap({ pointsUsed: 2.5 })).toBe(true);
    expect(overCap({ pointsUsed: 2 })).toBe(false);
    expect(overCap({ pointsUsed: null })).toBe(false);
    expect(pickable(undefined)).toEqual({ enabled: true, why: "usage unknown" });
    expect(pickable({ weeklyPercent: null, rejected: false })).toEqual({
      enabled: true,
      why: "usage unknown",
    });
  });

  it("reads each login's weekly figure from T3's instances, and counts the points a finished task used", async () => {
    let week = 40;
    const weekly = async () => [
      { instanceId: "codex", label: "Codex", email: null, weeklyPercent: 12, resetsAt: null },
      {
        instanceId: "codex_work",
        label: "Work",
        email: null,
        weeklyPercent: week,
        resetsAt: "Mon",
      },
    ];
    let finished = false;
    const { exec } = fakeExec((c) =>
      c.args[1] === "exec"
        ? { stdout: "Submitted task_abc123\n" }
        : c.args[1] === "status"
          ? { stdout: finished ? "completed\n" : "running\n" }
          : {},
    );
    const { store, brief } = memoryStores();
    const p = localProvider(
      codexHarness(exec, { codexEnv: "env_1", codexHomes: { work: "/h/work" }, weekly }),
      store,
      brief,
    );
    const u = await p.usage();
    expect(u.ok && u.value.map((x) => [x.account, x.weeklyPercent, x.resetsAt])).toEqual([
      ["work", 40, "Mon"],
    ]);
    await p.dispatch(input);
    const ok = await p.approve("L-1", "work", "r");
    expect(ok.ok && ok.value.weeklyBefore).toBe(40);
    week = 43;
    expect((await p.status("L-1")).ok).toBe(true);
    expect(store.load()[0]).toMatchObject({ state: "running", pointsUsed: null });
    finished = true;
    const done = await p.status("L-1");
    expect(done.ok && done.value).toMatchObject({
      state: "done",
      weeklyAfter: 43,
      pointsUsed: 3,
      overCap: true,
    });
    expect(
      weeklyForLogin(await weekly(), "codex", "This computer's Codex login", true)?.percent,
    ).toBe(12);
  });

  it("shows a provider with no usage as unknown, not zero", async () => {
    const { store, brief } = memoryStores();
    const u = await localProvider(codexHarness(fakeExec(() => ({})).exec), store, brief).usage();
    expect(u.ok && u.value).toEqual([
      {
        provider: "codex",
        account: "This computer's Codex login",
        weeklyPercent: null,
        resetsAt: null,
        rejected: false,
        pointsThisWeek: null,
      },
    ]);
  });
});

describe("starting programs safely on any system", () => {
  const shim =
    '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const files = new Map<string, string>([
    ["C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\codex.cmd", shim],
    [
      "C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      "//",
    ],
    ["C:\\Program Files\\nodejs\\node.exe", ""],
    ["C:\\Tools\\claude.exe", ""],
  ]);
  const win = (extra: Partial<LaunchEnv> = {}): LaunchEnv => ({
    platform: "win32",
    path: 'C:\\Users\\Ann Lee\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs";C:\\Tools',
    pathext: ".COM;.EXE;.BAT;.CMD",
    exists: (f) => files.has(f),
    read: (f) => files.get(f) ?? null,
    ...extra,
  });

  it("passes the name and the arguments straight through on Linux and macOS", () => {
    const env: LaunchEnv = { ...win(), platform: "linux", path: "/usr/bin" };
    expect(launchPlan("claude", ["--cloud", "a b; rm -rf /"], env)).toEqual({
      ok: true,
      file: "claude",
      args: ["--cloud", "a b; rm -rf /"],
      viaCmd: false,
    });
  });

  it("starts a native Windows program by its full path, with the arguments as a list", () => {
    expect(launchPlan("claude", ["auth", "status"], win())).toEqual({
      ok: true,
      file: "C:\\Tools\\claude.exe",
      args: ["auth", "status"],
      viaCmd: false,
    });
  });

  it("runs an npm shim's script with node directly, so a brief with quotes and ampersands is only text", () => {
    const brief = 'Fix "the" test & delete %TEMP% | more\nnext line';
    const plan = launchPlan("codex", ["cloud", "exec", brief], win());
    expect(plan).toEqual({
      ok: true,
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        "cloud",
        "exec",
        brief,
      ],
      viaCmd: false,
    });
    expect(scriptOfNpmShim("C:\\a\\codex.cmd", shim)).toBe(
      "C:\\a\\node_modules\\@openai\\codex\\bin\\codex.js",
    );
  });

  it("falls back to cmd only for plain arguments, and otherwise says plainly why not", () => {
    const odd = win({ read: () => "no script in here" });
    expect(launchPlan("codex", ["login", "status"], odd)).toMatchObject({ ok: true, viaCmd: true });
    const refused = launchPlan("codex", ["cloud", "exec", "a & b"], odd);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("not safe for a task description");
    expect(launchPlan("gemini", [], win())).toEqual({
      ok: false,
      error: "gemini is not installed on this computer.",
    });
  });

  it("finds a program past a quoted path and a folder with spaces", () => {
    expect(findProgram("node", win())).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(findProgram("nothing", win())).toBeNull();
  });

  it("gives each named login its own folder: CLAUDE_CONFIG_DIR and CODEX_HOME, never another", async () => {
    const { exec, calls } = fakeExec((c) =>
      c.args[0] === "auth"
        ? {
            stdout: `{"loggedIn":true,"email":"${c.env?.["CLAUDE_CONFIG_DIR"] === "/h/a" ? "a@example.org" : "b@example.org"}"}`,
          }
        : c.args[0] === "--cloud"
          ? { stdout: "https://claude.ai/code/s_9" }
          : {},
    );
    const { store, brief } = memoryStores();
    const h = claudeHarness(exec, { claudeHomes: { a: "/h/a", b: "/h/b" } });
    const d = await h.detect();
    expect(d).toMatchObject({
      signedIn: true,
      line: "Claude: signed in as a@example.org, b@example.org",
    });
    expect(calls.map((c) => c.env?.["CLAUDE_CONFIG_DIR"])).toEqual(["/h/a", "/h/b"]);
    const p = localProvider(h, store, brief);
    await p.dispatch(input);
    await p.approve("L-1", "b@example.org", "r");
    expect(calls.at(-1)).toMatchObject({ env: { CLAUDE_CONFIG_DIR: "/h/b" } });
    expect(h.accounts()).toEqual(["a@example.org", "b@example.org"]);
  });
});
