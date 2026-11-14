import {
  EMPTY_SYNOPSIS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkSessionId,
  type BatonFleetAdopted,
  type WorkSession,
  type WorkSessionProviderSession,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBatonFleet, filterFleetNeedsUser, type FleetThreadInput } from "./fleet.ts";

const projectId = ProjectId.make("vantageos");
const OBSERVED = "2026-09-18T04:10:00.000Z";

const thread = (overrides: Partial<FleetThreadInput> & { threadId: string }): FleetThreadInput => ({
  title: "Reconnect reproduction",
  branch: "main",
  worktreePath: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  sessionStatus: null,
  sessionLastError: null,
  backgroundLiveness: null,
  latestTurnState: null,
  latestTurnCompletedAt: null,
  updatedAt: "2026-09-18T04:05:00.000Z",
  ...overrides,
});

const providerSession = (input: {
  threadId: string;
  instanceId?: string;
  detachedAt?: string | null;
}): WorkSessionProviderSession => ({
  threadId: ThreadId.make(input.threadId),
  providerInstanceId:
    input.instanceId === undefined ? null : ProviderInstanceId.make(input.instanceId),
  providerDriver: null,
  role: "implementation",
  origin: "attached",
  attachedAt: "2026-09-18T04:00:00.000Z",
  detachedAt: input.detachedAt ?? null,
});

const workSession = (input: {
  id: string;
  title?: string;
  activeThreadId?: string | null;
  providerSessions: readonly WorkSessionProviderSession[];
  synopsisUpdatedAt?: string;
  updatedAt?: string;
}): WorkSession => ({
  id: WorkSessionId.make(input.id),
  projectId,
  title: input.title ?? input.id,
  objective: "",
  constraints: [],
  acceptanceCriteria: [],
  environmentAffinity: [],
  repositoryIdentity: null,
  primaryWorktreePath: null,
  baseBranch: null,
  status: "active",
  riskClass: "low",
  priority: "normal",
  activeThreadId: input.activeThreadId == null ? null : ThreadId.make(input.activeThreadId),
  providerSessions: input.providerSessions,
  synopsis: input.synopsisUpdatedAt === undefined ? null : EMPTY_SYNOPSIS(input.synopsisUpdatedAt),
  createdAt: "2026-09-18T03:00:00.000Z",
  updatedAt: input.updatedAt ?? "2026-09-18T04:00:00.000Z",
  settledAt: null,
  archivedAt: null,
});

const build = (input: {
  workSessions: readonly WorkSession[];
  threads: readonly FleetThreadInput[];
  environmentOnline?: boolean;
  exhausted?: readonly string[];
  lastVisitedAt?: (threadId: string) => string | null;
  adopted?: ReadonlyMap<string, ReadonlyArray<BatonFleetAdopted>>;
}) =>
  buildBatonFleet({
    workSessions: input.workSessions,
    threads: new Map(input.threads.map((entry) => [entry.threadId, entry])),
    environmentOnline: input.environmentOnline ?? true,
    exhaustedProviderInstanceIds: new Set(input.exhausted ?? []),
    lastVisitedAt: input.lastVisitedAt ?? (() => null),
    observedAt: OBSERVED,
    ...(input.adopted === undefined ? {} : { adopted: input.adopted }),
  });

describe("buildBatonFleet", () => {
  it("answers the five Phase 4 questions for two threads in different states", () => {
    // §29 Phase 4's exit criterion, as one assertion: what is running, where,
    // under which account, what needs the user, what recently completed.
    const fleet = build({
      workSessions: [
        workSession({
          id: "scheduler",
          title: "Scheduler reconnect race",
          activeThreadId: "t-working",
          providerSessions: [providerSession({ threadId: "t-working", instanceId: "claude-b" })],
        }),
        workSession({
          id: "deploy",
          title: "Production deploy",
          activeThreadId: "t-approval",
          providerSessions: [providerSession({ threadId: "t-approval", instanceId: "claude-a" })],
        }),
      ],
      threads: [
        thread({ threadId: "t-working", sessionStatus: "running", branch: "reconnect" }),
        thread({ threadId: "t-approval", hasPendingApprovals: true }),
      ],
    });

    // What needs the user sorts first.
    expect(fleet.entries.map((entry) => entry.title)).toEqual([
      "Production deploy",
      "Scheduler reconnect race",
    ]);
    const [deploy, scheduler] = fleet.entries;
    expect(deploy?.state).toBe("needs_approval");
    expect(deploy?.needsUser).toBe(true);
    expect(deploy?.threads[0]?.providerInstanceId).toBe("claude-a");
    expect(scheduler?.state).toBe("working");
    expect(scheduler?.needsUser).toBe(false);
    expect(scheduler?.threads[0]?.providerInstanceId).toBe("claude-b");
    expect(scheduler?.threads[0]?.branch).toBe("reconnect");
    expect(fleet.observedAt).toBe(OBSERVED);
  });

  it("keeps a work session whose thread is gone, with no thread rows", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "orphaned",
          activeThreadId: null,
          providerSessions: [providerSession({ threadId: "t-gone", instanceId: "claude-a" })],
        }),
      ],
      threads: [],
    });
    expect(fleet.entries).toHaveLength(1);
    expect(fleet.entries[0]?.threads).toHaveLength(0);
    expect(fleet.entries[0]?.state).toBe("idle");
  });

  it("ignores detached attachments", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "handed-off",
          activeThreadId: "t-new",
          providerSessions: [
            providerSession({ threadId: "t-old", instanceId: "claude-a", detachedAt: OBSERVED }),
            providerSession({ threadId: "t-new", instanceId: "claude-b" }),
          ],
        }),
      ],
      threads: [
        thread({ threadId: "t-old" }),
        thread({ threadId: "t-new", sessionStatus: "running" }),
      ],
    });
    expect(fleet.entries[0]?.threads.map((entry) => entry.threadId)).toEqual(["t-new"]);
  });

  it("reports everything offline when the environment is unreachable", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "scheduler",
          activeThreadId: "t",
          providerSessions: [providerSession({ threadId: "t", instanceId: "claude-b" })],
        }),
      ],
      threads: [thread({ threadId: "t", sessionStatus: "running" })],
      environmentOnline: false,
    });
    expect(fleet.entries[0]?.state).toBe("offline");
  });

  it("marks work on an exhausted account limited", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "scheduler",
          activeThreadId: "t",
          providerSessions: [providerSession({ threadId: "t", instanceId: "claude-a" })],
        }),
      ],
      threads: [thread({ threadId: "t", sessionStatus: "stopped" })],
      exhausted: ["claude-a"],
    });
    expect(fleet.entries[0]?.state).toBe("limited");
    expect(fleet.entries[0]?.needsUser).toBe(true);
  });

  it("uses the synopsis timestamp for recency when two rows share a state", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "older",
          activeThreadId: "t1",
          providerSessions: [providerSession({ threadId: "t1" })],
          synopsisUpdatedAt: "2026-09-18T04:01:00.000Z",
        }),
        workSession({
          id: "newer",
          activeThreadId: "t2",
          providerSessions: [providerSession({ threadId: "t2" })],
          synopsisUpdatedAt: "2026-09-18T04:09:00.000Z",
        }),
      ],
      threads: [
        thread({ threadId: "t1", sessionStatus: "running" }),
        thread({ threadId: "t2", sessionStatus: "running" }),
      ],
    });
    expect(fleet.entries.map((entry) => entry.workSessionId)).toEqual(["newer", "older"]);
  });

  it("takes the most demanding state across parallel threads", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "scheduler",
          activeThreadId: "t-impl",
          providerSessions: [
            providerSession({ threadId: "t-impl", instanceId: "claude-b" }),
            providerSession({ threadId: "t-review", instanceId: "codex" }),
          ],
        }),
      ],
      threads: [
        thread({ threadId: "t-impl", sessionStatus: "running" }),
        thread({ threadId: "t-review", hasPendingUserInput: true }),
      ],
    });
    expect(fleet.entries[0]?.state).toBe("needs_input");
  });

  it("answers done_unseen more strictly for a client that knows when it last looked", () => {
    const completed = "2026-09-18T04:05:00.000Z";
    const threads = [
      thread({ threadId: "t", latestTurnState: "completed", latestTurnCompletedAt: completed }),
    ];
    const sessions = [
      workSession({
        id: "scheduler",
        activeThreadId: "t",
        providerSessions: [providerSession({ threadId: "t" })],
      }),
    ];
    // A server has no idea when the user last looked.
    expect(build({ workSessions: sessions, threads }).entries[0]?.state).toBe("done_unseen");
    // A client does.
    expect(
      build({
        workSessions: sessions,
        threads,
        lastVisitedAt: () => "2026-09-18T04:06:00.000Z",
      }).entries[0]?.state,
    ).toBe("idle");
  });
});

describe("filterFleetNeedsUser", () => {
  it("keeps only the work that cannot move without the user", () => {
    const fleet = build({
      workSessions: [
        workSession({
          id: "blocked",
          activeThreadId: "t1",
          providerSessions: [providerSession({ threadId: "t1" })],
        }),
        workSession({
          id: "running",
          activeThreadId: "t2",
          providerSessions: [providerSession({ threadId: "t2" })],
        }),
      ],
      threads: [
        thread({ threadId: "t1", hasPendingApprovals: true }),
        thread({ threadId: "t2", sessionStatus: "running" }),
      ],
    });
    expect(filterFleetNeedsUser(fleet).entries.map((entry) => entry.workSessionId)).toEqual([
      "blocked",
    ]);
  });
});

describe("adopted sessions in the fleet", () => {
  const adoptedRow = (state: BatonFleetAdopted["state"]): BatonFleetAdopted => ({
    id: "herdr:ops:hermes",
    runtime: "herdr",
    label: "hermes",
    state,
    canSendInput: true,
  });

  it("puts a terminal Baton did not start on the work it belongs to", () => {
    const fleet = build({
      workSessions: [workSession({ id: "ws-1", title: "Scheduler", providerSessions: [] })],
      threads: [],
      adopted: new Map([["ws-1", [adoptedRow("working")]]]),
    });
    const entry = fleet.entries[0];
    expect(entry?.adopted).toHaveLength(1);
    expect(entry?.adopted[0]?.label).toBe("hermes");
    // The work session has no thread of its own; the adopted pane is what it
    // is doing, and the fleet says so rather than calling the work idle.
    expect(entry?.state).toBe("working");
  });

  it("lets an adopted terminal make the work need the user", () => {
    // A session Baton cannot control still tells the truth about what the
    // work is waiting for.
    const fleet = build({
      workSessions: [workSession({ id: "ws-1", title: "Scheduler", providerSessions: [] })],
      threads: [],
      adopted: new Map([["ws-1", [adoptedRow("needs_input")]]]),
    });
    expect(fleet.entries[0]?.state).toBe("needs_input");
    expect(fleet.entries[0]?.needsUser).toBe(true);
  });

  it("is an empty list on every environment without one", () => {
    const fleet = build({
      workSessions: [workSession({ id: "ws-1", title: "Scheduler", providerSessions: [] })],
      threads: [],
    });
    expect(fleet.entries[0]?.adopted).toEqual([]);
  });
});
