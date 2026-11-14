import type { TessayaJob } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { jobAction, jobControls, usageLine } from "./jobRows.ts";

const job = (
  id: string,
  group: string,
  phase = "approved",
  scheduleTaskId: string | null = null,
): TessayaJob =>
  ({
    workSessionId: id,
    title: id,
    group,
    phase,
    limitReached: null,
    permissionsSummary: "read",
    terms: { scheduleTaskId },
  }) as unknown as TessayaJob;

describe("the Jobs area", () => {
  it("lists what needs him first, with Approve, Stop, an answer line and a schedule where each applies", () => {
    const jobs = [
      job("a", "done"),
      job("b", "needs_you", "awaiting_agreement"),
      job("c", "running", "approved", "task-1"),
    ];
    const rows = jobControls(jobs);
    expect(rows.map((r) => r.id)).toEqual(["j:b", "ja:b", "j:c", "js:c", "j:a", "jk:a", "js:a"]);
    expect(rows[0]).toMatchObject({ button: "Approve", secondary: "Stop", lead: true });
    expect(rows[1]).toMatchObject({ kind: "session", canSend: true });
    expect(rows[2]).toMatchObject({ button: "Open T3", secondary: "Stop" });
    expect(rows[3]).toMatchObject({ button: "Turn off", more: true });
    expect(rows[5]).toMatchObject({ button: "Draft a skill" });
    expect(rows[6]).toMatchObject({ button: "Run daily" });
  });
  it("maps an action back to its job and what it asks for", () => {
    const jobs = [
      job("b", "needs_you", "awaiting_agreement"),
      job("c", "running", "approved", "t"),
    ];
    expect(jobAction(jobs, "j:b")).toMatchObject({ id: "b", kind: "primary", approve: true });
    expect(jobAction(jobs, "j:b:later")).toMatchObject({ kind: "stop" });
    expect(jobAction(jobs, "ja:b")).toMatchObject({ kind: "answer" });
    expect(jobAction(jobs, "js:c")).toMatchObject({ kind: "schedule", scheduled: true });
    expect(jobAction(jobs, "j:zzz")).toBeNull();
  });
});

describe("employee flows in the Jobs area", () => {
  it("offers Retry only to an agreed job that failed inside its budget, and shows the last report", () => {
    const failed = {
      workSessionId: "f",
      title: "f",
      group: "failed",
      phase: "approved",
      limitReached: null,
      permissionsSummary: "read",
      terms: {
        scheduleTaskId: null,
        limits: { wallClockMinutes: 120, workerTurns: 40, dollars: null },
        revisions: [{ at: "t", text: "Report: f has run 2 h. Doing: x." }],
      },
    } as unknown as TessayaJob;
    const rows = jobControls([failed]);
    expect(rows.map((r) => r.id)).toContain("jr:f");
    expect(rows.find((r) => r.id === "j:f")?.hint).toContain(
      "Last report: f has run 2 h. Doing: x.",
    );
    expect(jobAction([failed], "jr:f")).toMatchObject({ kind: "retry", id: "f" });
    const spent = {
      ...failed,
      terms: {
        ...failed.terms,
        revisions: [
          { at: "t", text: "Retry 1 of 2: a" },
          { at: "t", text: "Retry 2 of 2: b" },
        ],
      },
    } as unknown as TessayaJob;
    expect(jobControls([spent]).map((r) => r.id)).not.toContain("jr:f");
  });
});

describe("what a job has used", () => {
  it("says minutes and turns against the caps once agreed, and nothing before", () => {
    const j = {
      phase: "approved",
      usage: { minutes: 42, turns: 11 },
      terms: { limits: { wallClockMinutes: 120, workerTurns: 40 } },
    } as unknown as TessayaJob;
    expect(usageLine(j)).toBe("Used 42 of 120 min and 11 of 40 turns.");
    const priced = {
      ...j,
      usage: { minutes: 1, turns: 2, tokens: 12_345, dollars: 0.5, partial: true },
      terms: { limits: { wallClockMinutes: 120, workerTurns: 40, dollars: 5 } },
    } as unknown as TessayaJob;
    expect(usageLine(priced)).toBe(
      "Used 1 of 120 min and 2 of 40 turns. About $0.50 of $5 or more, 12,345 tokens.",
    );
    expect(usageLine({ ...j, phase: "awaiting_agreement" } as TessayaJob)).toBe("");
    expect(usageLine({ ...j, usage: undefined } as unknown as TessayaJob)).toBe("");
  });
});
