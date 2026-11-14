import type { BatonJob } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReport,
  jobsDigest,
  reportCadence,
  reportDue,
  retryRefusal,
  retryText,
  type ReportInput,
} from "./jobReport.ts";

const job = (
  over: Record<string, unknown> = {},
  revisions: Array<{ at: string; text: string }> = [],
  limits: Record<string, unknown> = {},
) =>
  ({
    title: "Site",
    phase: "approved",
    group: "failed",
    limitReached: null,
    lastActivityAt: "2026-11-02T10:00:00Z",
    terms: {
      limits: { wallClockMinutes: 120, workerTurns: 40, dollars: null, ...limits },
      revisions,
    },
    ...over,
  }) as unknown as BatonJob;

const base: ReportInput = {
  title: "Site",
  state: "working",
  minutes: 130,
  turns: 14,
  dollars: 1.2,
  partial: true,
  doing: "running the tests",
  findings: ["found the broken import", "fixed it"],
  changedFiles: ["a.ts", "b.ts"],
  next: ["rebuild"],
  needsUser: true,
  failedChecks: 1,
  limitReached: null,
};

describe("job reports", () => {
  it("says what happened, what is next and what blocks, in one paragraph", () => {
    expect(buildReport(base)).toBe(
      "Report: Site has run 2 h, 14 turns, about $1.20 or more. Doing: running the tests. So far: found the broken import; fixed it; changed a.ts, b.ts. Next: rebuild. Blockers: waiting for his answer; 1 failed check.",
    );
    expect(
      buildReport({
        ...base,
        findings: [],
        changedFiles: [],
        next: [],
        needsUser: false,
        failedChecks: 0,
        dollars: null,
        doing: null,
      }),
    ).toContain("So far: nothing new recorded. Next: not stated. Blockers: none.");
  });
  it("is due when the last report, or the start, is older than the cadence, and never when off", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    expect(reportDue([], "2026-11-02T10:30:00Z", 60, now)).toBe(true);
    expect(reportDue([], "2026-11-02T11:30:00Z", 60, now)).toBe(false);
    expect(
      reportDue(
        [{ at: "2026-11-02T11:45:00Z", text: "Report: x" }],
        "2026-11-02T08:00:00Z",
        60,
        now,
      ),
    ).toBe(false);
    expect(reportDue([], "2026-11-02T01:00:00Z", 0, now)).toBe(false);
    expect(reportCadence(job())).toBe(60);
    expect(reportCadence(job({}, [], { reportEveryMinutes: 15 }))).toBe(15);
  });
});

describe("retrying a failed worker", () => {
  it("allows a retry with a reason inside the budget, and says why not past it or when it has not failed", () => {
    expect(retryRefusal(job())).toBeNull();
    expect(retryRefusal(job({ group: "running" }))).toContain("not failed");
    expect(retryRefusal(job({ phase: "awaiting_agreement" }))).toContain("agreed");
    const used = [
      { at: "t", text: "Retry 1 of 2: x" },
      { at: "t", text: "Retry 2 of 2: y" },
    ];
    expect(retryRefusal(job({}, used))).toContain("used its 2 retries");
    expect(retryRefusal(job({}, used, { retries: 3 }))).toBeNull();
    expect(
      retryText(
        job({}, [{ at: "t", text: "Retry 1 of 2: x" }]),
        "the build timed out",
        "ran pnpm test",
      ),
    ).toBe(
      "Retry 2 of 2: the build timed out (last it did: ran pnpm test). Try again from where it stopped. If the same step failed, take a different approach and say what you changed.",
    );
  });
});

describe("the jobs digest", () => {
  it("counts the last day and leaves out an old job", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const a = job({ group: "done", usage: { minutes: 1, turns: 5, dollars: 0.5 } });
    const b = job({
      title: "Mail",
      group: "failed",
      usage: { minutes: 1, turns: 3, dollars: 1.1 },
    });
    const old = job({ lastActivityAt: "2026-10-30T10:00:00Z" });
    expect(jobsDigest([a, b, old], now)).toBe(
      "Jobs: 2 jobs worked in the last day; 1 finished; 1 failed or stopped at a limit (Mail); 8 worker turns; about $1.60 as far as the logs show.",
    );
    expect(jobsDigest([old], now)).toBeNull();
  });
});
