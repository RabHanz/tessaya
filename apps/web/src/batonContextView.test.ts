import type { BatonFleetEntry, BatonInjectionReport } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dictationModeLabel,
  dictationRefusal,
  focusedWorkSessionFromThreads,
} from "./batonContextView";

const entry = (workSessionId: string, threadIds: readonly string[]): BatonFleetEntry =>
  ({
    workSessionId,
    title: "Scheduler reconnect race",
    projectId: "project-vantageos",
    lifecycle: "active",
    state: "working",
    needsUser: false,
    activeThreadId: threadIds[0] ?? null,
    threads: threadIds.map((threadId) => ({
      threadId,
      title: "Implementation",
      state: "working",
      providerInstanceId: "claude-a",
      providerDriver: "claudeAgent",
      branch: null,
      worktreePath: null,
      lastActivityAt: null,
    })),
    synopsis: null,
    updatedAt: "2026-09-18T07:00:00.000Z",
  }) as unknown as BatonFleetEntry;

const entries = [entry("ws-scheduler", ["thread-a", "thread-b"]), entry("ws-search", ["thread-c"])];

describe("focusedWorkSessionFromThreads", () => {
  it("turns the thread on screen into the work it belongs to", () => {
    // §14 rung 3 finally has a producer: before this, `focusedWorkSessionId`
    // was always null and "tell it to stop" always fell to what moved last.
    expect(focusedWorkSessionFromThreads(entries, "env-1", "env-1:thread-b")).toBe("ws-scheduler");
    expect(focusedWorkSessionFromThreads(entries, "env-1", "env-1:thread-c")).toBe("ws-search");
  });

  it("ignores a thread from another environment", () => {
    // A thread id is not unique across environments, and resolving one
    // environment's thread against another's fleet is how a message lands in
    // the wrong place.
    expect(focusedWorkSessionFromThreads(entries, "env-1", "env-2:thread-b")).toBeNull();
  });

  it("answers nothing when nothing is open, or the thread belongs to no work", () => {
    expect(focusedWorkSessionFromThreads(entries, "env-1", null)).toBeNull();
    expect(focusedWorkSessionFromThreads(entries, "env-1", "env-1:thread-zzz")).toBeNull();
  });
});

describe("dictationRefusal", () => {
  const wayland: BatonInjectionReport = {
    platform: "linux",
    displayServer: "wayland",
    capabilities: [
      {
        method: "application",
        available: false,
        reason: "no application integration is connected.",
      },
      {
        method: "accessibility",
        available: false,
        reason: "Wayland does not let one application type into another.",
      },
      { method: "clipboard", available: false, reason: "this host has no clipboard access." },
      { method: "keystrokes", available: false, reason: "Wayland does not allow synthetic input." },
    ],
  };

  it("uses the host's own words when the host said why", () => {
    const refusal = dictationRefusal({
      report: wayland,
      targetReason: "Nothing editable is focused.",
    });
    expect(refusal).toContain("no application integration is connected");
  });

  it("falls back to why there is no target", () => {
    const refusal = dictationRefusal({
      report: null,
      targetReason: "Gmail compose cannot take dictated text from here.",
    });
    expect(refusal).toBe("Gmail compose cannot take dictated text from here.");
  });

  it("never refuses without saying something", () => {
    const refusal = dictationRefusal({ report: null, targetReason: "" });
    expect(refusal.length).toBeGreaterThan(0);
    expect(refusal).toContain("Nothing is reporting one");
  });
});

describe("dictationModeLabel", () => {
  it("says where the words are going, and admits when they are going nowhere", () => {
    expect(dictationModeLabel({ label: "Gmail compose" })).toBe("Dictating into Gmail compose");
    // The mode must never be invisible: dictation that silently goes nowhere
    // is the failure §18 is written against.
    expect(dictationModeLabel(null)).toBe("Dictating — nowhere to put it");
  });
});
