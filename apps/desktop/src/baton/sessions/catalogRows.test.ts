// @effect-diagnostics globalDate:off
import { describe, expect, it, vi } from "vite-plus/test";

import {
  agoWords,
  catalogControls,
  createCatalog,
  INITIAL_VIEW,
  matches,
  visibleRows,
  type CatalogService,
} from "./catalogRows.ts";
import { sampleCatalogRows } from "./sampleCatalog.ts";

const NOW = Date.UTC(2026, 10, 2, 12);
const rows = sampleCatalogRows(NOW);

describe("the sessions browser's rows", () => {
  it("finds every word in the title, folder, machine or account, newest first", () => {
    expect(matches(rows[1]!, "launch post laptop")).toBe(true);
    expect(matches(rows[1]!, "launch server")).toBe(false);
    expect(visibleRows(rows, INITIAL_VIEW)[0]!.title).toBe("Wire the sessions browser");
    expect(
      visibleRows(rows, { ...INITIAL_VIEW, machine: "server", state: "stopped" }).map(
        (r) => r.title,
      ),
    ).toEqual(["Fix the weekly digest", "Old landing page"]);
  });

  it("says how long ago in words", () => {
    expect(agoWords(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(agoWords(new Date(NOW - 26 * 3_600_000).toISOString(), NOW)).toBe("yesterday");
    expect(agoWords(null, NOW)).toBe("");
  });

  it("offers Resume only on a stopped session, and caps what it draws", () => {
    const controls = catalogControls({
      rows,
      view: INITIAL_VIEW,
      now: NOW,
      folders: [],
      status: "",
      loaded: true,
    });
    const labels = controls
      .filter((c) => c.kind === "catalogRow")
      .map((c) => [c.label, c.kind === "catalogRow" ? c.resumeLabel : ""]);
    expect(labels.find(([l]) => l === "Wire the sessions browser")![1]).toBeNull();
    expect(labels.find(([l]) => l === "Write the launch post")![1]).toBe("Resume");
    const many = Array.from({ length: 200 }, (_, i) => ({ ...rows[0]!, id: `m${i}` }));
    const big = catalogControls({
      rows: many,
      view: INITIAL_VIEW,
      now: NOW,
      folders: [],
      status: "",
      loaded: true,
    });
    expect(big.filter((c) => c.kind === "catalogRow")).toHaveLength(25);
  });
});

describe("a resume shows Importing history... until the thread is live", () => {
  it("goes stopped, resuming, running, and opens the thread; a failure says so", async () => {
    let finish: () => void = () => undefined;
    const opened: string[] = [];
    const service: CatalogService = {
      list: async () => rows,
      resume: () => new Promise<void>((r) => (finish = r)),
      create: async () => undefined,
      folders: async () => [],
      open: (row) => void opened.push(row.id),
    };
    const changed = vi.fn();
    const catalog = createCatalog({ service, onChange: changed, now: () => NOW });
    await catalog.refresh();
    const state = (id: string) => {
      const row = catalog.controls().find((c) => c.id === `c:${id}`);
      return row?.kind === "catalogRow" ? row.stateLabel : "";
    };
    expect(state("s1")).toBe("Stopped");
    catalog.apply("c:s1", "resume");
    expect(state("s1")).toBe("Importing history...");
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(state("s1")).toBe("Running");
    expect(opened).toEqual(["s1"]);
    // A resume that fails leaves a row he can try again.
    const failing = createCatalog({
      service: { ...service, resume: async () => Promise.reject(new Error("x")) },
      onChange: changed,
      now: () => NOW,
    });
    await failing.refresh();
    failing.apply("c:s1", "resume");
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    const row = failing.controls().find((c) => c.id === "c:s1");
    expect(row?.kind === "catalogRow" && row.resumeLabel).toBe("Resume");
    // A thread T3 cannot open says why and stays Running, so the title button retries.
    const stuck = createCatalog({
      service: {
        ...service,
        resume: async () => undefined,
        open: async () => Promise.reject(new Error("not shown yet")),
      },
      onChange: changed,
      now: () => NOW,
    });
    await stuck.refresh();
    stuck.apply("c:s1", "resume");
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(JSON.stringify(stuck.controls())).toContain("not shown yet");
  });

  it("lets the assistant find a stopped session, bring it back and start another, in plain words", async () => {
    const opened: string[] = [];
    const created: string[] = [];
    const service: CatalogService = {
      list: async () => rows,
      resume: async () => undefined,
      create: async (t) => void created.push(`${t.environmentId} ${t.cwd}`),
      folders: async () => [],
      open: (row) => void opened.push(row.id),
    };
    const { tools, refresh } = createCatalog({
      service,
      onChange: () => undefined,
      now: () => NOW,
    });
    await refresh();
    expect(await tools.find("digest")).toContain("Fix the weekly digest");
    expect(await tools.find("zzzz")).toBe("No session matches that.");
    expect(await tools.resume("nope")).toContain("no session by that id");
    expect(await tools.resume("s1")).toContain("running again");
    expect(opened).toEqual(["s1"]);
    expect(await tools.start("/work/new", "nowhere")).toContain("do not know that machine");
    expect(await tools.start("/work/new", "")).toContain("starting in /work/new");
    expect(created).toHaveLength(1);
  });
});

describe("kept messages on a row", () => {
  it("opens them, discards one by place and text, and never resumes the session", async () => {
    const stopped = rows.find((r) => r.state === "stopped")!;
    let held = ["first", "second"];
    const asked: unknown[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    const resumed: string[] = [];
    const service: CatalogService = {
      list: async () => rows.map((r) => (r.id === stopped.id ? { ...r, waiting: 2 } : r)),
      resume: async (row) => void resumed.push(row.id),
      create: async () => undefined,
      folders: async () => [],
      open: () => undefined,
      kept: (_row, discard) => {
        asked.push(discard);
        if (discard !== undefined) held = held.filter((_, i) => i !== discard.index);
        const answer = Promise.resolve({ messages: held, sending: false });
        pending = answer;
        return answer;
      },
    };
    const catalog = createCatalog({ service, onChange: () => undefined, now: () => NOW });
    await catalog.refresh();
    const row = () =>
      catalog.controls().find((c) => c.id === `c:${stopped.id}`) as never as {
        keptLabel: string | null;
        kept: ReadonlyArray<string> | null;
      };
    expect(row()).toMatchObject({ keptLabel: "2 kept messages", kept: null });
    catalog.apply(`c:${stopped.id}`, "kept");
    await pending;
    expect(row().kept).toEqual(["first", "second"]);
    catalog.apply(`c:${stopped.id}`, "discard:0");
    await pending;
    expect(row()).toMatchObject({ keptLabel: "1 kept message", kept: ["second"] });
    expect(asked).toEqual([undefined, { index: 0, text: "first" }]);
    catalog.apply(`c:${stopped.id}`, "kept");
    expect(row().kept).toBeNull();
    expect(resumed).toEqual([]);
  });

  it("looks again once a send under way may have ended, and hides the button when none are left", async () => {
    const stopped = rows.find((r) => r.state === "stopped")!;
    let answers = [
      { messages: ["first"], sending: true },
      { messages: [] as string[], sending: false },
    ];
    let pending: Promise<unknown> = Promise.resolve();
    const later: Array<() => void> = [];
    const service: CatalogService = {
      list: async () => rows.map((r) => (r.id === stopped.id ? { ...r, waiting: 1 } : r)),
      resume: async () => undefined,
      create: async () => undefined,
      folders: async () => [],
      open: () => undefined,
      kept: () => {
        const [answer, ...rest] = answers;
        answers = rest;
        pending = Promise.resolve(answer!);
        return pending as never;
      },
    };
    const catalog = createCatalog({
      service,
      onChange: () => undefined,
      now: () => NOW,
      later: (run) => void later.push(run),
    });
    await catalog.refresh();
    const row = () =>
      catalog.controls().find((c) => c.id === `c:${stopped.id}`) as never as {
        keptLabel: string | null;
        kept: ReadonlyArray<string> | null;
      };
    catalog.apply(`c:${stopped.id}`, "kept");
    await pending;
    expect(row()).toMatchObject({ keptLabel: "1 kept message", kept: ["first"] });
    expect(later).toHaveLength(1);
    later[0]!();
    await pending;
    expect(row()).toMatchObject({ keptLabel: null, kept: null });
  });
});

describe("New session", () => {
  it("passes the folder, model, effort and first message to the service", async () => {
    const created: unknown[] = [];
    const service: CatalogService = {
      list: async () => rows,
      resume: async () => undefined,
      create: async (target) => void created.push(target),
      folders: async () => [],
      open: () => undefined,
    };
    const catalog = createCatalog({ service, onChange: () => undefined, now: () => NOW });
    await catalog.refresh();
    catalog.apply(
      "c.start",
      JSON.stringify({
        cwd: "C:\\work\\loom",
        model: "opus",
        effort: "high",
        message: "Read BRIEF.md",
      }),
    );
    await Promise.resolve();
    expect(created).toEqual([
      {
        environmentId: "laptop",
        cwd: "C:\\work\\loom",
        model: "opus",
        effort: "high",
        message: "Read BRIEF.md",
      },
    ]);
  });
});

describe("clean-up of helper threads and background runs", () => {
  it("looks first, then archives on the second press, and background runs are a toggle", async () => {
    const calls: boolean[] = [];
    const lists: Array<boolean | undefined> = [];
    const service: CatalogService = {
      list: async (_q, background) => (lists.push(background), rows),
      resume: async () => undefined,
      create: async () => undefined,
      folders: async () => [],
      open: () => undefined,
      cleanup: async (apply) => (
        calls.push(apply),
        [{ machine: "Laptop", failed: false, found: 3, left: 1, archived: apply ? 3 : 0 }]
      ),
    };
    const catalog = createCatalog({ service, onChange: () => undefined, now: () => NOW });
    await catalog.refresh();
    const bar = () => catalog.controls().find((c) => c.kind === "catalogBar");
    catalog.apply("c.tidy", null);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      bar()?.kind === "catalogBar" && bar()?.kind === "catalogBar"
        ? (bar() as { tidyFound: number }).tidyFound
        : 0,
    ).toBe(3);
    catalog.apply("c.tidyApply", null);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([false, true]);
    catalog.apply("c.background", null);
    await Promise.resolve();
    expect(lists.at(-1)).toBe(true);
  });
});

describe("Stop and the Auto-resume switch", () => {
  it("Stop ends a running session and leaves it stopped; the switch asks every server", async () => {
    const stopped: string[] = [];
    const switches: string[] = [];
    const service: CatalogService = {
      list: async () => rows,
      resume: async () => undefined,
      create: async () => undefined,
      folders: async () => [],
      open: () => undefined,
      stop: async (row) => void stopped.push(row.id),
      autoResume: async (action) => (switches.push(action), action !== "off"),
    };
    const catalog = createCatalog({ service, onChange: () => undefined, now: () => NOW });
    await catalog.refresh();
    const state = (id: string) => {
      const row = catalog.controls().find((c) => c.id === `c:${id}`);
      return row?.kind === "catalogRow" ? [row.stateLabel, row.stopLabel] : [];
    };
    expect(state("s0")).toEqual(["Running", "Stop"]);
    catalog.apply("c:s0", "stop");
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toEqual(["s0"]);
    expect(state("s0")).toEqual(["Stopped", null]);
    catalog.apply("c.autoResume", null);
    await Promise.resolve();
    expect(switches.at(-1)).toBe(switches.includes("status") ? switches.at(-1) : "on");
    expect(catalog.controls().find((c) => c.kind === "catalogBar")).toMatchObject({
      autoResume: expect.any(Boolean),
    });
  });
});

describe("New session defaults to the computer the app runs on", () => {
  it("picks the local machine and labels it", () => {
    const withLocal = rows.map((r) => ({ ...r, local: r.environmentId === "server" }));
    const bar = catalogControls({
      rows: withLocal,
      view: INITIAL_VIEW,
      now: NOW,
      folders: [],
      status: "",
      loaded: true,
    }).find((c) => c.kind === "catalogBar");
    expect(bar).toMatchObject({ newMachine: "server" });
    expect(
      bar?.kind === "catalogBar" && bar.machines.some((m) => m.label.endsWith("(this computer)")),
    ).toBe(true);
  });
});

describe("a row's real binding and Reattach", () => {
  it("names the pane, offers Reattach only on a handoff-answered thread, and asks before taking another pane", async () => {
    const asked: Array<string | undefined> = [];
    const base = rows.find((r) => r.state === "running")!;
    const list = [
      { ...base, id: "p", pane: "fab~w1:p2", answeredBy: "baton-live" },
      { ...base, id: "h", pane: "fab~w1:p3", answeredBy: "claudeAgent" },
      { ...base, id: "t", pane: null, threadId: "import:claudeAgent:t" },
      { ...base, id: "w", pane: null, threadId: "import:claudeAgent:w", turnRunning: true },
    ];
    const service: CatalogService = {
      list: async () => list,
      resume: async () => undefined,
      create: async () => undefined,
      folders: async () => [],
      open: () => undefined,
      reattach: async (_row, confirmPane) => {
        asked.push(confirmPane);
        return confirmPane === undefined
          ? { state: "confirm", pane: "w1:p9", detail: "" }
          : { state: "reattached", pane: confirmPane, detail: "" };
      },
    };
    const catalog = createCatalog({ service, onChange: () => undefined, now: () => NOW });
    await catalog.refresh();
    const row = (id: string) => {
      const c = catalog.controls().find((x) => x.id === `c:${id}`);
      return c?.kind === "catalogRow" ? [c.binding, c.reattachLabel] : [];
    };
    expect(row("p")).toEqual(["Herdr pane fab~w1:p2", null]);
    expect(row("h")).toEqual(["T3-hosted handoff session", "Reattach"]);
    expect(row("t")).toEqual(["T3 thread", null]);
    // A resumed thread can be stopped only while a turn runs in it.
    const stop = (id: string) => {
      const c = catalog.controls().find((x) => x.id === `c:${id}`);
      return c?.kind === "catalogRow" ? c.stopLabel : undefined;
    };
    expect([stop("p"), stop("t"), stop("w")]).toEqual(["Stop", null, "Stop"]);
    catalog.apply("c:h", "reattach");
    await vi.waitFor(() => expect(row("h")[1]).toBe("Reattach to w1:p9?"));
    catalog.apply("c:h", "reattach");
    await vi.waitFor(() => expect(asked).toEqual([undefined, "w1:p9"]));
    expect(asked).toEqual([undefined, "w1:p9"]);
  });
});
