import type { TessayaSessionSummary } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickSession, prLine, prUrlsIn, readableExcerpt, steerText } from "./sessionInsight.ts";

const row = (
  key: string,
  session: string,
  project: string,
  state: "working" | "waiting" | "idle",
  updatedAt: string,
): TessayaSessionSummary => ({
  key,
  session,
  project,
  account: null,
  state,
  urgent: false,
  box: "studio",
  updatedAt,
  thread: null,
  pane: null,
});

describe("the session he means", () => {
  const rows = [
    row("claude:1", "Build lane", "t3code", "idle", "2026-11-20T01:00:00Z"),
    row("claude:2", "Release build", "t3code", "working", "2026-11-20T02:00:00Z"),
    row("claude:3", "Parity sync", "t3code", "idle", "2026-11-20T03:00:00Z"),
  ];
  it("takes its key, else the most words, then the liveliest", () => {
    expect(pickSession(rows, "claude:3")?.key).toBe("claude:3");
    expect(pickSession(rows, "the parity PR")?.key).toBe("claude:3");
    expect(pickSession(rows, "build lane")?.key).toBe("claude:1");
    expect(pickSession(rows, "the build session")?.key).toBe("claude:2");
    expect(pickSession(rows, "the session")).toBeNull();
    expect(pickSession(rows, "mascot")).toBeNull();
  });
});

describe("what a model may read of it", () => {
  it("marks secrets, leaves out private pack text, and keeps the newest part", () => {
    const pack = "she keeps these words for him alone and never says them to anyone else at all";
    const out = readableExcerpt(
      ["ran the tests", `token ${"sk-" + "ant-api03-" + "a".repeat(40)}`, `quoting: ${pack}`],
      [pack],
    );
    expect(out).toContain("ran the tests");
    expect(out).not.toContain("sk-ant");
    expect(out).not.toContain("never says them");
    expect(readableExcerpt(["a".repeat(50), "end"], [], 10)).toBe("a".repeat(5) + "\n\nend");
  });
});

describe("its pull requests and their state", () => {
  it("finds the newest three links and says each in one line", () => {
    const text = [1, 2, 3, 4, 2]
      .map((n) => `see https://github.com/acme/tessaya/pull/${n}`)
      .join(" ");
    expect(prUrlsIn(text)).toEqual([
      "https://github.com/acme/tessaya/pull/2",
      "https://github.com/acme/tessaya/pull/4",
      "https://github.com/acme/tessaya/pull/3",
    ]);
    expect(
      prLine({
        state: "OPEN",
        reviewDecision: null,
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
      }),
    ).toBe("open, 1 check failing, no review yet, blocked from merging");
    expect(prLine({ state: "MERGED" })).toBe("merged");
  });
});

it("says who his steering is from", () => {
  expect(steerText("Sam", " rerun the tests ")).toBe("From Sam, via Tessaya: rerun the tests");
});
