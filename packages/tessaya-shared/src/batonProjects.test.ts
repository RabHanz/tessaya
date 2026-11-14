import type {
  AdoptedSessionCandidate,
  BatonFleetEntry,
  ClaudeLiveSession,
  EnvironmentId,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  batonSessionSummaries,
  buildBatonProjects,
  paneWaiting,
  type EnvironmentLive,
} from "./batonProjects.ts";

const repo = { key: "github.com/rabhanz/vantageos", label: "VantageOS" };

const claude = (over: Partial<ClaudeLiveSession>): ClaudeLiveSession =>
  ({
    pid: 1,
    sessionId: "s",
    cwd: "/home/orbit/VantageOS",
    name: null,
    status: "idle",
    entrypoint: "cli",
    herdrPane: null,
    tmux: null,
    account: null,
    updatedAt: null,
    project: repo,
    ...over,
  }) as ClaudeLiveSession;

const env = (id: string, label: string, over: Partial<EnvironmentLive>): EnvironmentLive => ({
  environmentId: id as EnvironmentId,
  environmentLabel: label,
  entries: [],
  herdr: [],
  claude: [],
  ...over,
});

describe("one entry per project, across boxes and accounts (D72)", () => {
  it("puts sessions on two boxes and two accounts under one project", () => {
    const groups = buildBatonProjects({
      environments: [
        env("e1", "sablebox", {
          claude: [claude({ sessionId: "a", account: "optima", herdrPane: "fab-v~w1:p1" })],
        }),
        env("e2", "orbit", { claude: [claude({ sessionId: "b", account: "robin" })] }),
      ],
      resolveWorkProject: () => null,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("VantageOS");
    expect(groups[0]?.boxes).toEqual(["sablebox", "orbit"]);
    expect(groups[0]?.accounts.toSorted()).toEqual(["optima", "robin"]);
    expect(groups[0]?.rows.map((row) => row.key)).toEqual(["claude:a", "claude:b"]);
  });

  it("keeps a session's row through rotation and adoption: the key is the conversation", () => {
    const before = buildBatonProjects({
      environments: [
        env("e1", "sablebox", { claude: [claude({ sessionId: "a", pid: 10, account: "optima" })] }),
      ],
      resolveWorkProject: () => null,
    });
    const after = buildBatonProjects({
      environments: [
        env("e1", "sablebox", {
          claude: [claude({ sessionId: "a", pid: 99, account: "robin", herdrPane: "fab-v~w1:p2" })],
        }),
      ],
      resolveWorkProject: () => null,
    });
    expect(after[0]?.rows[0]?.key).toBe(before[0]?.rows[0]?.key);
    const row = after[0]?.rows[0];
    expect(row?.kind === "claude" && row.pane).toBe("fab-v~w1:p2");
  });

  it("files a T3 work session under the same project, and a bare Herdr pane by its folder", () => {
    const groups = buildBatonProjects({
      environments: [
        env("e1", "sablebox", {
          entries: [
            {
              workSessionId: "w1",
              projectId: "p1",
              title: "handoff",
              state: "working",
              needsUser: false,
            } as unknown as BatonFleetEntry,
          ],
          herdr: [
            {
              label: "tail -f",
              location: { pane: "w2:p1", workspace: "logs", host: null },
              state: "monitoring",
              runtimeState: "unknown",
              cwd: "/srv/logs",
            } as unknown as AdoptedSessionCandidate,
          ],
          claude: [claude({ sessionId: "a" })],
        }),
      ],
      resolveWorkProject: () => repo,
    });
    const vantageos = groups.find((group) => group.key === repo.key);
    expect(vantageos?.rows.map((row) => row.kind).toSorted()).toEqual(["claude", "work"]);
    expect(groups.find((group) => group.key === "dir:logs")?.rows[0]?.kind).toBe("pane");
  });
});

describe("the sessions Tessaya's own window lists", () => {
  it("reads state, thread and pane off the sidebar's rows, and nothing else", () => {
    const groups = [
      {
        key: "p",
        label: "VantageOS",
        boxes: ["orbit"],
        accounts: [],
        urgent: true,
        rows: [
          {
            kind: "pane" as const,
            key: "pane:e:1",
            environmentId: "e" as never,
            box: "orbit",
            title: "Scheduler",
            state: "needs_input",
            urgent: true,
            updatedAt: null,
            pane: "w1-p2",
            prompt: null,
          },
          {
            kind: "claude" as const,
            key: "claude:s1",
            environmentId: "e" as never,
            box: "orbit",
            title: "Planner",
            state: "running",
            urgent: false,
            updatedAt: "2026-11-01T10:00:00Z",
            account: "alex",
            where: "terminal",
            pane: null,
            sessionId: "s1",
            prompt: null,
          },
        ],
      },
    ];
    const [blocked, running] = batonSessionSummaries(groups, (row) =>
      row.kind === "claude" ? row.account : null,
    );
    expect(blocked).toMatchObject({
      state: "waiting",
      urgent: true,
      thread: null,
      pane: { environmentId: "e", pane: "w1-p2" },
      account: null,
    });
    expect(running).toMatchObject({ state: "working", pane: null, account: "alex" });
  });
  it("knows from the live rows when a pane is waiting on a question, so nothing is typed at it", () => {
    const groups = buildBatonProjects({
      environments: [
        env("e1", "box", {
          herdr: [
            {
              label: "api",
              location: { workspace: "w", pane: "s~1" },
              state: "needs_input",
              runtimeState: "running",
            } as never,
          ],
        }),
      ],
      resolveWorkProject: () => null,
    });
    expect(paneWaiting(groups, "e1", "s~1")).toBe(true);
    expect(paneWaiting(groups, "e1", "s~2")).toBe(false);
    expect(paneWaiting(groups, "e2", "s~1")).toBe(false);
  });
  it("files a linked server's work under the project that server resolved", () => {
    const entry = {
      workSessionId: "w1",
      title: "Fix login",
      projectId: "p1",
      state: "running",
      needsUser: false,
      threads: [],
      project: { key: "github.com/x/shop", label: "Shop" },
    } as unknown as BatonFleetEntry;
    const groups = buildBatonProjects({
      environments: [env("box", "box", { entries: [entry] })],
      resolveWorkProject: () => null,
    });
    expect(groups.map((group) => group.label)).toEqual(["Shop"]);
  });
});
