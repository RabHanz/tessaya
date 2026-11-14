import { describe, expect, it } from "vite-plus/test";

import { parseSync } from "./nightly.ts";
import { summariseChecks, syncCapability, syncNeeds, type SyncState } from "./syncState.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const status = (over: Record<string, unknown>) =>
  parseSync(
    JSON.stringify({
      at: "2026-11-03T03:00:00Z",
      result: "merged",
      ok: true,
      behindCommits: 12,
      conflictingFiles: [],
      ...over,
    }),
  );
const state = (over: Partial<SyncState> = {}): SyncState => ({
  localBehind: null,
  status: status({}),
  pr: null,
  ...over,
});

describe("the upstream sync on the Now page", () => {
  it("is quiet and green when the last run was recent and clean", () => {
    expect(syncNeeds(state(), NOW)).toEqual([]);
    const row = syncCapability(state({ localBehind: 3 }), NOW);
    expect(row.state).toBe("works");
    expect(row.why).toContain("3 commits behind upstream.");
    expect(row.why).toContain("The last run was 9 h ago: merged.");
  });

  it("prefers the count from the checkout and says when it is the last run's", () => {
    expect(syncCapability(state(), NOW).why).toContain(
      "12 commits behind upstream (as of the last run).",
    );
  });

  it("needs him when nothing has run for more than a day", () => {
    const old = state({ status: status({ at: "2026-11-01T03:00:00Z" }) });
    const [row] = syncNeeds(old, NOW);
    expect(row).toMatchObject({ id: "sync:stalled", weight: 85 });
    expect(syncCapability(old, NOW).state).toBe("limited");
  });

  it("needs him when the run stopped, and names the files", () => {
    const [row] = syncNeeds(
      state({
        status: status({ result: "conflict", ok: false, conflictingFiles: ["a/ChatView.tsx"] }),
      }),
      NOW,
    );
    expect(row?.id).toBe("sync:stopped");
    expect(row?.why).toContain("a/ChatView.tsx");
  });

  it("needs him when the open sync PR is failing, and shows its checks otherwise", () => {
    const pr = (checks: "pass" | "fail" | "pending") => ({
      number: 292,
      url: "u",
      title: "sync: upstream to abc",
      checks,
    });
    expect(syncNeeds(state({ pr: pr("fail") }), NOW).map((n) => n.id)).toEqual(["sync:pr:292"]);
    expect(syncNeeds(state({ pr: pr("pending") }), NOW)).toEqual([]);
    expect(syncCapability(state({ pr: pr("pending") }), NOW).why).toContain(
      "Sync PR #292: checks still running.",
    );
  });

  it("does not guess when it can read nothing", () => {
    expect(syncCapability({ localBehind: null, status: null, pr: null }, NOW).state).toBe(
      "unknown",
    );
    expect(syncNeeds({ localBehind: null, status: null, pr: null }, NOW)).toEqual([]);
  });

  it("sums up a check rollup", () => {
    expect(summariseChecks([])).toBe("none");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("pass");
    expect(summariseChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("fail");
    expect(
      summariseChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }]),
    ).toBe("pending");
  });
});
