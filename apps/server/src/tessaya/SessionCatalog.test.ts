import type { ClaudeLiveSession } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSessionCatalog,
  newSessionSelection,
  sendOutcome,
  type CatalogPorts,
  type TranscriptInfo,
} from "./SessionCatalog.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const OLD = "99999999-2222-3333-4444-555555555555";
const live = (over: Partial<ClaudeLiveSession> = {}): ClaudeLiveSession =>
  ({
    pid: 1,
    sessionId: ID,
    cwd: "/work/shop",
    name: "Shop",
    status: "idle",
    entrypoint: "cli",
    herdrPane: "fab-shop~p1",
    tmux: null,
    account: "ann",
    updatedAt: "2026-11-02T10:00:00.000Z",
    ...over,
  }) as ClaudeLiveSession;
const transcript = (over: Partial<TranscriptInfo> = {}): TranscriptInfo => ({
  sessionId: ID,
  cwd: "/work/shop",
  title: "Fix the checkout",
  lastActivityAt: "2026-11-01T09:00:00.000Z",
  account: "ann",
  ...over,
});

/** A machine where the session is stopped, and `baton --resume` brings it up in a Herdr pane a moment later. */
const machine = (over: Partial<CatalogPorts> = {}) => {
  const typed: Array<[string, string]> = [];
  const batonCalls: ReadonlyArray<string>[] = [];
  let sessions: ReadonlyArray<ClaudeLiveSession> = [];
  let clock = 0;
  let upAt = Infinity;
  const ports: CatalogPorts = {
    machine: "box",
    live: async () => (clock >= upAt ? sessions : []),
    transcripts: async () => [
      transcript(),
      transcript({
        sessionId: OLD,
        title: "Old work",
        lastActivityAt: "2026-10-01T09:00:00.000Z",
        cwd: "/gone/folder",
      }),
    ],
    history: async () => [],
    dirExists: (d) => d === "/work/shop" || d === "/work/new",
    baton: async (args) => {
      batonCalls.push(args);
      upAt = clock + 1_500;
      sessions =
        args[0] === "--resume"
          ? [live()]
          : [live({ sessionId: "new-1", cwd: args[0]!, herdrPane: "fab-new~p9" })];
      return { ok: true, out: "baton: claude running in fab-shop pane p1" };
    },
    type: async (pane, text) => (typed.push([pane, text]), "sent" as const),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    ...over,
  };
  return { catalog: createSessionCatalog(ports), typed, batonCalls };
};

describe("sending to a stopped session", () => {
  it("on a machine with no Herdr it comes back as a thread and does not call baton", async () => {
    const { catalog, batonCalls } = machine({
      thread: async (id) => ({ threadId: `import:claudeAgent:${id}` }),
    });
    expect(await catalog.resume({ sessionId: ID })).toEqual({
      state: "running",
      pane: null,
      detail: null,
      threadId: `import:claudeAgent:${ID}`,
    });
    expect(batonCalls).toEqual([]);
    const sent = await catalog.send({ sessionId: ID, text: "hi" });
    expect(sent.delivered).toBe(false);
    expect(sent.detail).toContain("thread");
  });

  it("a resumed thread's row is running while the thread is open, stoppable during a turn, and stopped once archived, deleted or stopped", async () => {
    let state: "gone" | "idle" | "working" = "idle";
    const { catalog } = machine({
      thread: async (id) => ({ threadId: `import:claudeAgent:${id}` }),
      threadState: async () => state,
    });
    const row = async () => (await catalog.list({})).sessions.find((r) => r.id === ID);
    await catalog.resume({ sessionId: ID });
    expect(await row()).toMatchObject({ state: "running", threadId: `import:claudeAgent:${ID}` });
    expect((await row())?.turnRunning).toBeUndefined();
    state = "working";
    expect(await row()).toMatchObject({ state: "running", turnRunning: true });
    state = "gone";
    expect(await row()).toMatchObject({ state: "stopped" });
    expect((await row())?.threadId).toBeUndefined();
    state = "idle";
    await catalog.resume({ sessionId: ID });
    expect(catalog.forgetResumed(ID)).toBe(`import:claudeAgent:${ID}`);
    expect(await row()).toMatchObject({ state: "stopped" });
  });

  it("a new session on a machine with no Herdr is a thread with the model, effort and first message asked for, and no baton call", async () => {
    const launched: unknown[] = [];
    const { catalog, batonCalls } = machine({
      launch: async (input) => (launched.push(input), { threadId: "thread-1" }),
    });
    const made = await catalog.create({
      cwd: "/work/new",
      model: "opus",
      effort: "high",
      message: "Read BRIEF.md",
    });
    expect(made).toMatchObject({ state: "running", threadId: "thread-1", pane: null });
    expect(launched).toEqual([
      { cwd: "/work/new", model: "opus", effort: "high", message: "Read BRIEF.md" },
    ]);
    expect(batonCalls).toEqual([]);
    const missing = await catalog.create({ cwd: "/work/nope" });
    expect(missing.state).toBe("failed");
  });

  it("a new session goes to a Herdr pane when Where new sessions run says a terminal", async () => {
    const launched: unknown[] = [];
    const { catalog, batonCalls } = machine({
      launch: async (input) => (launched.push(input), { threadId: "thread-1" }),
      newSessionsInTerminal: async () => true,
    });
    expect(await catalog.create({ cwd: "/work/new" })).toMatchObject({ pane: "fab-new~p9" });
    expect(launched).toEqual([]);
    expect(batonCalls).toEqual([["/work/new", "claude"]]);
  });

  it("a long import answers 'resuming' at once, the kept message goes into the thread when it is done, or the reason it failed", async () => {
    let finish: (v: { threadId: string } | { detail: string }) => void = () => undefined;
    const intoThread: Array<[string, string]> = [];
    const { catalog } = machine({
      resumeWaitMs: 5,
      thread: () => new Promise((r) => (finish = r)),
      threadSend: async (threadId, text) => (intoThread.push([threadId, text]), true),
    });
    const first = await catalog.send({ sessionId: ID, text: "hello" });
    expect(first).toMatchObject({ state: "resuming", detail: expect.stringMatching(/kept/) });
    const during = (await catalog.list({})).sessions.find((s) => s.id === ID);
    expect(during).toMatchObject({ state: "resuming" });
    finish({ threadId: `import:claudeAgent:${ID}` });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const after = (await catalog.list({})).sessions.find((s) => s.id === ID);
    expect(after).toMatchObject({
      state: "running",
      threadId: `import:claudeAgent:${ID}`,
      waiting: 0,
    });
    expect(intoThread).toEqual([[`import:claudeAgent:${ID}`, "hello"]]);
    const failing = machine({
      resumeWaitMs: 5,
      thread: async () => ({ detail: "The transcript could not be read." }),
    }).catalog;
    await failing.resume({ sessionId: ID });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect((await failing.list({})).sessions.find((s) => s.id === ID)).toMatchObject({
      state: "failed",
      detail: "The transcript could not be read.",
    });
  });

  it("resumes it in the right folder, waits until it is ready, then delivers the message once", async () => {
    const { catalog, typed, batonCalls } = machine();
    const sent = await catalog.send({ sessionId: ID, text: "carry on with the tests" });
    expect(batonCalls).toEqual([["--resume", ID, "/work/shop"]]);
    expect(sent).toEqual({ state: "running", delivered: true, detail: null });
    expect(typed).toEqual([["fab-shop~p1", "carry on with the tests"]]);
  });

  it("keeps the message and says why when it cannot be resumed, and never reports 'not delivered' as final", async () => {
    const { catalog, typed } = machine({
      baton: async () => ({ ok: false, out: "herdr: no server" }),
    });
    const sent = await catalog.send({ sessionId: ID, text: "hello" });
    expect(sent.state).toBe("failed");
    expect(sent.delivered).toBe(false);
    expect(sent.detail).toContain("Herdr would not start it: herdr: no server");
    expect(sent.detail).toContain("Your message is kept.");
    expect(typed).toEqual([]);
    const row = (await catalog.list({})).sessions.find((r) => r.id === ID)!;
    expect(row).toMatchObject({ state: "failed", waiting: 1 });
  });

  it("a kept message survives a restart and goes on the next resume; one the pane refuses stays kept", async () => {
    let disk: Record<string, ReadonlyArray<string>> = {};
    const kept = {
      read: () => disk,
      write: (all: Record<string, ReadonlyArray<string>>) => void (disk = all),
    };
    const down = machine({ kept, baton: async () => ({ ok: false, out: "herdr: no server" }) });
    await down.catalog.send({ sessionId: ID, text: "hello" });
    expect(disk).toEqual({ [ID]: ["hello"] });

    const refusing = machine({ kept, type: async () => "refused" as const });
    expect((await refusing.catalog.list({})).sessions.find((r) => r.id === ID)).toMatchObject({
      waiting: 1,
    });
    await refusing.catalog.resume({ sessionId: ID });
    expect(disk).toEqual({ [ID]: ["hello"] });

    // Once the question is answered, sending again sends the kept one first, then the new one.
    const after = machine({ kept, live: async () => [live()] });
    const again = await after.catalog.send({ sessionId: ID, text: "and this" });
    expect(after.typed).toEqual([
      ["fab-shop~p1", "hello"],
      ["fab-shop~p1", "and this"],
    ]);
    expect(again).toMatchObject({ delivered: true });
    expect(disk).toEqual({});

    // A send Herdr never answered may have arrived: dropped, said so, never typed again.
    const unsure = machine({
      kept,
      live: async () => [live()],
      type: async () => "unsure" as const,
    });
    const maybe = await unsure.catalog.send({ sessionId: ID, text: "maybe" });
    expect(maybe).toMatchObject({
      delivered: false,
      detail: expect.stringMatching(/may already be/),
    });
    expect(disk).toEqual({});
  });

  it("a message sent while kept ones are being typed goes after them, once, and a second Resume types nothing twice", async () => {
    let disk: Record<string, ReadonlyArray<string>> = { [ID]: ["first"] };
    const kept = {
      read: () => disk,
      write: (all: Record<string, ReadonlyArray<string>>) => void (disk = all),
    };
    const typed: string[] = [];
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = new Promise((r) => (release = r));
    let started: () => void = () => undefined;
    const typing = new Promise<void>((r) => (started = r));
    const { catalog } = machine({
      kept,
      type: async (_pane, text) => {
        started();
        if (gate !== null) await gate;
        gate = null;
        typed.push(text);
        return "sent" as const;
      },
    });
    const resumed = catalog.resume({ sessionId: ID });
    await typing;
    const during = await catalog.send({ sessionId: ID, text: "second" });
    expect(during.delivered).toBe(false);
    expect(await catalog.resume({ sessionId: ID })).toMatchObject({ state: "resuming" });
    release();
    await resumed;
    expect(typed).toEqual(["first", "second"]);
    expect(disk).toEqual({});
  });

  it("names Claude's folder-trust question when that is what the session is waiting on", async () => {
    const { catalog, typed } = machine({
      live: async () => [],
      screen: async () =>
        " Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder",
    });
    const sent = await catalog.send({ sessionId: ID, text: "hello" });
    expect(sent.detail).toContain("asking whether to trust this folder");
    expect(sent.detail).toContain("herdr --session fab-shop");
    expect(sent.detail).toContain("Your message is kept.");
    expect(typed).toEqual([]);
  });

  it("times out with a readable reason when it starts but never becomes ready", async () => {
    const { catalog } = machine({ live: async () => [] });
    const sent = await catalog.send({ sessionId: ID, text: "hello" });
    expect(sent.detail).toContain("did not become ready within 45 seconds");
  });

  it("delivers a message sent while it is already resuming, in order, with one resume", async () => {
    const { catalog, typed, batonCalls } = machine();
    const first = catalog.send({ sessionId: ID, text: "one" });
    const second = await catalog.send({ sessionId: ID, text: "two" });
    expect(second.state).toBe("resuming");
    await first;
    expect(batonCalls).toHaveLength(1);
    expect(typed.map((t) => t[1])).toEqual(["one", "two"]);
  });

  it("types straight into a session that is already running in Herdr", async () => {
    const { catalog, typed, batonCalls } = machine({ live: async () => [live()] });
    expect((await catalog.send({ sessionId: ID, text: "now" })).delivered).toBe(true);
    expect(batonCalls).toEqual([]);
    expect(typed).toEqual([["fab-shop~p1", "now"]]);
  });

  it("does not pretend to reach a session in a plain terminal", async () => {
    const { catalog, typed } = machine({ live: async () => [live({ herdrPane: null })] });
    const sent = await catalog.send({ sessionId: ID, text: "now" });
    expect(sent.state).toBe("failed");
    expect(sent.detail).toContain("plain terminal");
    expect(typed).toEqual([]);
  });
});

describe("resuming", () => {
  it("is one tap: the right folder, ready in Herdr, and a second tap while it works changes nothing", async () => {
    const { catalog, batonCalls } = machine();
    const first = catalog.resume({ sessionId: ID });
    expect(await catalog.resume({ sessionId: ID })).toMatchObject({ state: "resuming" });
    expect(await first).toMatchObject({ state: "running", pane: "fab-shop~p1" });
    expect(batonCalls).toHaveLength(1);
    expect(await catalog.resume({ sessionId: ID })).toMatchObject({ state: "running" });
    expect(batonCalls).toHaveLength(1);
  });

  it("says plainly when the folder is gone or unknown", async () => {
    const { catalog } = machine();
    expect(await catalog.resume({ sessionId: OLD })).toMatchObject({
      state: "failed",
      detail: "The folder /gone/folder is not on this machine.",
    });
    expect(await catalog.resume({ sessionId: "nope" })).toMatchObject({ state: "failed" });
    expect((await catalog.resume({ sessionId: "nope" })).detail).toContain("which folder");
  });
});

describe("browsing", () => {
  it("lists running and stopped sessions newest first with project, title, account and machine, and says why one cannot be resumed", async () => {
    const { catalog } = machine({
      live: async () => [
        live({
          sessionId: "run-1",
          cwd: "/work/api",
          name: "API",
          updatedAt: "2026-11-02T12:00:00.000Z",
          account: "bob",
        }),
      ],
      // OLD died after its last activity; ID was run again by hand after its death.
      died: (id) =>
        id === OLD || id === ID
          ? {
              // A reason that ends in a full stop gets no second one.
              why: "auto-resume is off here.",
              at: Date.parse(id === OLD ? "2026-10-02T00:00:00.000Z" : "2026-10-30T00:00:00.000Z"),
            }
          : null,
    });
    const { sessions, machine: name } = await catalog.list({});
    expect(name).toBe("box");
    expect(sessions.map((s) => [s.id, s.state, s.project, s.account, s.canResume])).toEqual([
      ["run-1", "running", "api", "bob", false],
      [ID, "stopped", "shop", "ann", true],
      [OLD, "stopped", "folder", "ann", false],
    ]);
    expect(sessions[2]!.detail).toContain("not on this machine");
    expect(sessions[1]!.title).toBe("Fix the checkout");
    // One that died mid-turn and was not brought back says so, and why, beside its other reason.
    expect(sessions[2]!.crashed).toBe(true);
    expect(sessions[2]!.detail).toBe(
      "Died mid-turn and was not resumed: auto-resume is off here. Its folder is not on this machine, so it cannot be resumed here.",
    );
    // One run again by hand since its death is a plain stopped session.
    expect(sessions[1]!.crashed).toBeUndefined();
    // A live thread checks its own session by id; the history index may not have it.
    const byId = (await catalog.list({ query: "run-1" })).sessions;
    expect(byId.map((s) => [s.id, s.state])).toEqual([["run-1", "running"]]);
  });

  it("finds older sessions through the history index when words are given, and marks them read-only when the transcript is gone", async () => {
    const { catalog } = machine({
      history: async (q) =>
        q.includes("invoice")
          ? [
              { sessionId: "hist-1", project: "-home-ann-books", at: "2026-09-01T10:00:00.000Z" },
              { sessionId: ID, project: "-work-shop", at: null },
            ]
          : [],
    });
    expect((await catalog.list({})).sessions.some((s) => s.source === "history")).toBe(false);
    const found = (await catalog.list({ query: "invoice" })).sessions;
    const hist = found.find((s) => s.id === "hist-1")!;
    expect(hist).toMatchObject({ source: "history", canResume: false, project: "ann-books" });
    expect(hist.detail).toContain("no longer on this machine");
    expect(found.filter((s) => s.id === ID)).toHaveLength(1);
  });

  it("pages by time and offers folders worth starting in", async () => {
    const { catalog } = machine();
    const page = await catalog.list({ limit: 1 });
    expect(page.sessions).toHaveLength(1);
    expect(page.more).toBe(true);
    const older = await catalog.list({ before: page.sessions[0]!.lastActivityAt! });
    expect(older.sessions.map((s) => s.id)).toEqual([OLD]);
    expect((await catalog.folders({})).folders.map((f) => f.cwd)).toEqual(["/work/shop"]);
  });
});

describe("starting a new session", () => {
  it("starts baton in the folder and returns the session once it reports in", async () => {
    const { catalog, batonCalls } = machine();
    const made = await catalog.create({ cwd: "/work/new" });
    expect(batonCalls).toEqual([["/work/new", "claude"]]);
    expect(made).toEqual({
      state: "running",
      sessionId: "new-1",
      pane: "fab-new~p9",
      detail: null,
    });
  });

  it("refuses a folder that is not here", async () => {
    const { catalog, batonCalls } = machine();
    expect(await catalog.create({ cwd: "/nowhere" })).toMatchObject({
      state: "failed",
      detail: "The folder /nowhere is not on this machine.",
    });
    expect(batonCalls).toEqual([]);
  });
});

describe("kept messages", () => {
  const disk = (start: Record<string, ReadonlyArray<string>>) => {
    const box = { all: start };
    return {
      box,
      kept: {
        read: () => box.all,
        write: (all: Record<string, ReadonlyArray<string>>) => void (box.all = all),
      },
    };
  };

  it("the watchdog's resume leaves them kept; only a user's send or Resume sends them", async () => {
    const { box, kept } = disk({ [ID]: ["old"] });
    const { catalog, typed } = machine({ kept });
    expect(await catalog.resume({ sessionId: ID, deliver: false })).toMatchObject({
      state: "running",
    });
    expect(typed).toEqual([]);
    expect(box.all).toEqual({ [ID]: ["old"] });
  });

  it("a send that fails mid-resume does not leave the session stuck resuming", async () => {
    const { box, kept } = disk({});
    let fail = true;
    const typed: string[] = [];
    const { catalog } = machine({
      kept,
      type: async (_pane, text) => {
        if (fail) throw ((fail = false), new Error("herdr crashed"));
        typed.push(text);
        return "sent" as const;
      },
    });
    await expect(catalog.send({ sessionId: ID, text: "hello" })).rejects.toThrow("herdr crashed");
    expect(await catalog.send({ sessionId: ID, text: "again" })).toMatchObject({ delivered: true });
    expect(typed).toEqual(["hello", "again"]);
    expect(box.all).toEqual({});
  });

  it("a send during a resume that then fails is sent by that send, not promised to a flush that never runs", async () => {
    let calls = 0;
    const { catalog, typed } = machine({
      // Stopped when the resume looks, then up in Herdr but mid-turn, so the resume times out waiting for ready.
      live: async () => (calls++ === 0 ? [] : [live({ status: "busy" })]),
    });
    const resumed = catalog.resume({ sessionId: ID });
    const sent = await catalog.send({ sessionId: ID, text: "hi" });
    expect(sent).toMatchObject({ delivered: true });
    expect(typed).toEqual([["fab-shop~p1", "hi"]]);
    await resumed;
  });

  it("an unsure send in one flush is not reported against a later, unrelated send", async () => {
    const { kept } = disk({ [ID]: ["a"] });
    let outcome: "sent" | "unsure" = "unsure";
    const { catalog } = machine({ kept, type: async () => outcome });
    await catalog.resume({ sessionId: ID });
    outcome = "sent";
    expect(await catalog.send({ sessionId: ID, text: "b" })).toEqual({
      state: "running",
      delivered: true,
      detail: null,
    });
  });

  it("a refusal that is not a question says so, and the message stays kept", async () => {
    const { box, kept } = disk({});
    const { catalog } = machine({
      kept,
      live: async () => [live()],
      type: async () => "refused" as const,
    });
    const sent = await catalog.send({ sessionId: ID, text: "hi" });
    expect(sent.detail).not.toMatch(/question/);
    expect(sent.detail).toMatch(/nothing was typed/);
    expect(box.all).toEqual({ [ID]: ["hi"] });
  });

  it("can be read and discarded one at a time, by place and text, but not while they are being sent", async () => {
    const { box, kept } = disk({ [ID]: ["one", "two", "three"] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let typing: () => void = () => undefined;
    const started = new Promise<void>((r) => (typing = r));
    const { catalog } = machine({
      kept,
      live: async () => [live()],
      type: async () => (typing(), await gate, "sent" as const),
    });
    expect(catalog.waitingFor(ID)).toEqual({ messages: ["one", "two", "three"], sending: false });
    // A stale view (the text at that place changed) drops nothing.
    expect(catalog.waitingFor(ID, { index: 1, text: "three" }).messages).toHaveLength(3);
    expect(catalog.waitingFor(ID, { index: 1, text: "two" })).toEqual({
      messages: ["one", "three"],
      sending: false,
    });
    expect(box.all).toEqual({ [ID]: ["one", "three"] });
    const sent = catalog.send({ sessionId: ID, text: "four" });
    await started;
    expect(catalog.waitingFor(ID, { index: 1, text: "three" })).toMatchObject({ sending: true });
    expect(box.all[ID]).toContain("three");
    release();
    await sent;
    expect(catalog.waitingFor(ID)).toEqual({ messages: [], sending: false });
  });

  it("are dropped, and no longer counted, once the session's transcript is gone", async () => {
    const { box, kept } = disk({ [ID]: ["keep me"], gone: ["lost"] });
    const { catalog } = machine({ kept, hasTranscript: (id) => id === ID });
    await catalog.list({});
    expect(box.all).toEqual({ [ID]: ["keep me"] });
  });
});

describe("sendOutcome", () => {
  // The real answers from HerdrAdapterLive.sendInput and herdrSend: only these keep a message.
  it.each([
    [{ delivered: true, detail: "sent to shop and submitted." }, "sent"],
    [
      {
        delivered: false,
        detail:
          "shop is waiting on a question or an approval in its terminal, so nothing was sent. Answer it there first, then send again.",
      },
      "blocked",
    ],
    [{ delivered: false, detail: "No Herdr pane fab-shop~p1 is running here now." }, "refused"],
    [
      { delivered: false, detail: "Herdr is not available here: herdr is not installed" },
      "refused",
    ],
    [{ delivered: false, detail: "Not sent: TimeoutException" }, "unsure"],
    [{ delivered: false, detail: "the text reached shop, but return did not: exit 1" }, "unsure"],
  ] as const)("%j is %s", (result, expected) => {
    expect(sendOutcome(result)).toBe(expected);
  });
});

describe("listing sessions by words", () => {
  it("searches the history index only when asked to, so an agent cannot test words against every transcript", async () => {
    const searched: string[] = [];
    const { catalog } = machine({
      history: async (q) => (
        searched.push(q),
        [{ sessionId: "gone-1", project: "-work-shop", at: null }]
      ),
    });
    await catalog.list({ query: "deploy key", history: false });
    expect(searched).toEqual([]);
    await catalog.list({ query: "deploy key" });
    expect(searched).toEqual(["deploy key"]);
  });
});

describe("the account a new Tessaya session starts on", () => {
  const pick = (over: Partial<Parameters<typeof newSessionSelection>[0]>) =>
    newSessionSelection({
      defaultSelection: { instanceId: "claude-work", model: "claude-sonnet" },
      defaultIsClaude: true,
      fallbackInstance: "claudeAgent",
      fallbackModel: "claude-opus",
      askedModel: undefined,
      ...over,
    });
  it("is the Account for new threads default, with its model unless one is asked for", () => {
    expect(pick({})).toEqual({ instanceId: "claude-work", model: "claude-sonnet" });
    expect(pick({ askedModel: "claude-haiku" })).toEqual({
      instanceId: "claude-work",
      model: "claude-haiku",
    });
    expect(pick({ askedModel: "opus" })).toEqual({
      instanceId: "claude-work",
      model: "claude-opus",
    });
  });
  it("falls back to the default Claude instance when that default is not Claude or not set", () => {
    expect(pick({ defaultIsClaude: false })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus",
    });
    expect(pick({ defaultSelection: null })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus",
    });
  });
});
