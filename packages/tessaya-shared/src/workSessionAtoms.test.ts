import {
  EMPTY_SYNOPSIS,
  ProjectId,
  ThreadId,
  WorkSessionId,
  type WorkSession,
  type WorkSessionStreamItem,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyWorkSessionStreamItem } from "./workSessionAtoms.ts";

const projectId = ProjectId.make("project");

const workSession = (input: {
  id: string;
  title?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  activeThreadId?: string | null;
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
  status: input.archivedAt != null ? "archived" : input.settledAt != null ? "settled" : "active",
  riskClass: "low",
  priority: "normal",
  activeThreadId: input.activeThreadId == null ? null : ThreadId.make(input.activeThreadId),
  providerSessions: [],
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: input.updatedAt ?? "2026-09-18T00:00:00.000Z",
  settledAt: input.settledAt ?? null,
  archivedAt: input.archivedAt ?? null,
});

describe("applyWorkSessionStreamItem", () => {
  it("replaces the list wholesale on a snapshot", () => {
    const before = [workSession({ id: "stale" })];
    const snapshot: WorkSessionStreamItem = {
      kind: "snapshot",
      workSessions: [workSession({ id: "a" }), workSession({ id: "b" })],
    };
    expect(applyWorkSessionStreamItem(before, snapshot).map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("puts a created work session at the front", () => {
    const before = [workSession({ id: "a" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.workSession.created",
      workSession: workSession({ id: "b" }),
    });
    expect(after.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("replaces an existing entry rather than duplicating it, and moves it to the front", () => {
    const before = [workSession({ id: "a" }), workSession({ id: "b" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.workSession.updated",
      workSession: workSession({ id: "b", title: "renamed" }),
    });
    expect(after.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(after[0]?.title).toBe("renamed");
  });

  it("drops a work session the server reports as archived", () => {
    const before = [workSession({ id: "a" }), workSession({ id: "b" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.workSession.statusChanged",
      workSession: workSession({ id: "a", archivedAt: "2026-09-18T01:00:00.000Z" }),
      previousStatus: "active",
    });
    expect(after.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("brings an unarchived work session back without a refetch", () => {
    const before = [workSession({ id: "b" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.workSession.statusChanged",
      workSession: workSession({ id: "a" }),
      previousStatus: "archived",
    });
    expect(after.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("keeps a settled work session in the list", () => {
    const before = [workSession({ id: "a" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.workSession.statusChanged",
      workSession: workSession({ id: "a", settledAt: "2026-09-18T01:00:00.000Z" }),
      previousStatus: "active",
    });
    expect(after.map((entry) => entry.id)).toEqual(["a"]);
    expect(after[0]?.status).toBe("settled");
  });

  it("applies a synopsis update in place, without reordering the list", () => {
    // The synopsis moves far more often than the work does. Letting it
    // reshuffle would make the list unreadable while anything is running.
    const before = [workSession({ id: "a" }), workSession({ id: "b" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.synopsis.updated",
      workSessionId: WorkSessionId.make("b"),
      synopsis: {
        ...EMPTY_SYNOPSIS("2026-09-18T04:09:00.000Z"),
        currentAction: "Running the reconnect tests",
      },
    });
    expect(after.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(after[1]?.synopsis?.currentAction).toBe("Running the reconnect tests");
  });

  it("ignores a synopsis update for a work session it does not hold", () => {
    const before = [workSession({ id: "a" })];
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.synopsis.updated",
      workSessionId: WorkSessionId.make("absent"),
      synopsis: EMPTY_SYNOPSIS("2026-09-18T04:09:00.000Z"),
    });
    expect(after).toEqual(before);
  });

  it("carries the whole record on a provider attachment, so no follow-up read is needed", () => {
    const before = [workSession({ id: "a" })];
    const attached = workSession({ id: "a", activeThreadId: "thread-1" });
    const after = applyWorkSessionStreamItem(before, {
      kind: "fabric.workSession.providerAttached",
      workSession: attached,
      providerSession: {
        threadId: ThreadId.make("thread-1"),
        providerInstanceId: null,
        providerDriver: null,
        role: "implementation",
        origin: "attached",
        attachedAt: "2026-09-18T01:00:00.000Z",
        detachedAt: null,
      },
    });
    expect(after[0]?.activeThreadId).toBe("thread-1");
  });
});
