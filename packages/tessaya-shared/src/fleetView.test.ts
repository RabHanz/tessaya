import {
  EMPTY_SYNOPSIS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkSessionId,
  type TessayaFleetEntry,
  type WorkSessionSynopsis,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFleetRows, countFleetRows, filterFleetRows } from "./fleetView.ts";

const environmentId = EnvironmentId.make("home-linux");
const projectId = ProjectId.make("vantageos");
const NOW = Date.parse("2026-09-18T04:10:00.000Z");

const entry = (input: {
  id: string;
  title: string;
  state: TessayaFleetEntry["state"];
  needsUser?: boolean;
  instanceId?: string;
  synopsis?: WorkSessionSynopsis | null;
}): TessayaFleetEntry => ({
  workSessionId: WorkSessionId.make(input.id),
  title: input.title,
  projectId,
  lifecycle: "active",
  state: input.state,
  adopted: [],
  needsUser: input.needsUser ?? false,
  activeThreadId: ThreadId.make(`${input.id}-thread`),
  threads: [
    {
      threadId: ThreadId.make(`${input.id}-thread`),
      title: "Reconnect reproduction",
      state: input.state,
      providerInstanceId:
        input.instanceId === undefined ? null : ProviderInstanceId.make(input.instanceId),
      providerDriver: null,
      branch: "main",
      worktreePath: null,
      lastActivityAt: "2026-09-18T04:05:00.000Z",
    },
  ],
  synopsis: input.synopsis ?? null,
  updatedAt: "2026-09-18T04:05:00.000Z",
});

const rowsFor = (entries: readonly TessayaFleetEntry[]) =>
  buildFleetRows({
    entries: entries.map((value) => ({ environmentId, entry: value })),
    resolveProjectLabel: () => "VantageOS",
    resolveEnvironmentLabel: () => "home-linux",
    resolveProviderAccount: (_environmentId: string, instanceId: string) =>
      instanceId === "claude-b"
        ? { label: "Claude B", email: "b@example.com" }
        : instanceId === "codex"
          ? { label: "Codex", email: null }
          : null,
    now: NOW,
  });

describe("buildFleetRows", () => {
  it("says which account is running the work, by name and by address", () => {
    // "The mechanism runs, nothing puts it in front of you" was the honest gap
    // after D52. A row already said "Claude B"; which *login* that is, is the
    // thing that goes wrong silently when two config directories end up
    // sharing credentials.
    const rows = rowsFor([
      entry({ id: "a", title: "A", state: "working", instanceId: "claude-b" }),
    ]);

    expect(rows[0]?.account).toEqual({ label: "Claude B", email: "b@example.com" });
    // The attribution line is unchanged: the address renders separately, and
    // redacted, because a sidebar is the thing people screenshot.
    expect(rows[0]?.attribution).toBe("Claude B · home-linux");
  });

  it("carries no account for a provider that reports no address", () => {
    const rows = rowsFor([entry({ id: "a", title: "A", state: "working", instanceId: "codex" })]);

    expect(rows[0]?.account).toEqual({ label: "Codex", email: null });
  });

  it("renders the §33 line: glyph, project and work, then the state", () => {
    const [row] = rowsFor([
      entry({
        id: "scheduler",
        title: "Scheduler reconnect race",
        state: "working",
        instanceId: "claude-b",
      }),
    ]);
    expect(row?.glyph).toBe("●");
    expect(row?.heading).toBe("VantageOS / Scheduler reconnect race");
    expect(row?.stateLabel).toBe("Working");
    expect(row?.attribution).toBe("Claude B · home-linux");
  });

  it("marks what needs the user with the attention glyph", () => {
    const [row] = rowsFor([
      entry({ id: "deploy", title: "Deploy", state: "needs_approval", needsUser: true }),
    ]);
    expect(row?.glyph).toBe("!");
    expect(row?.stateLabel).toBe("Approval needed");
    expect(row?.needsUser).toBe(true);
  });

  it("shows a finished session with the done glyph", () => {
    const [row] = rowsFor([entry({ id: "search", title: "Search", state: "done_unseen" })]);
    expect(row?.glyph).toBe("✓");
    expect(row?.stateLabel).toBe("Done");
  });

  it("carries the synopsis line and flags it once it is stale", () => {
    const fresh = rowsFor([
      entry({
        id: "a",
        title: "A",
        state: "working",
        synopsis: {
          ...EMPTY_SYNOPSIS("2026-09-18T04:09:45.000Z"),
          currentAction: "Running the reconnect tests",
        },
      }),
    ])[0];
    expect(fresh?.detail).toBe("Running the reconnect tests");
    expect(fresh?.detailStale).toBe(false);

    const stale = rowsFor([
      entry({
        id: "b",
        title: "B",
        state: "working",
        synopsis: {
          ...EMPTY_SYNOPSIS("2026-09-18T04:00:00.000Z"),
          currentAction: "Running the reconnect tests",
        },
      }),
    ])[0];
    expect(stale?.detailStale).toBe(true);
  });

  it("omits the project prefix when the project has no label", () => {
    const rows = buildFleetRows({
      entries: [{ environmentId, entry: entry({ id: "a", title: "A", state: "idle" }) }],
      resolveProjectLabel: () => null,
      resolveEnvironmentLabel: () => null,
      resolveProviderAccount: () => null,
      now: NOW,
    });
    expect(rows[0]?.heading).toBe("A");
    expect(rows[0]?.attribution).toBeNull();
  });
});

describe("filterFleetRows", () => {
  it("is the top-level Needs me filter, and counts what it would hide", () => {
    const rows = rowsFor([
      entry({ id: "deploy", title: "Deploy", state: "needs_approval", needsUser: true }),
      entry({ id: "scheduler", title: "Scheduler", state: "working" }),
    ]);
    expect(countFleetRows(rows)).toEqual({ total: 2, needsUser: 1 });
    expect(filterFleetRows(rows, true).map((row) => row.heading)).toEqual(["VantageOS / Deploy"]);
    expect(filterFleetRows(rows, false)).toHaveLength(2);
  });
});
