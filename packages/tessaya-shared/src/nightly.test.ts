import { describe, expect, it } from "vite-plus/test";

import { buildNightly, nightlyRow, parseNightly, parseSync, resultOf, syncRow } from "./nightly.ts";

const NOW = Date.parse("2026-11-03T06:00:00Z");
const status = (outcomes: Record<string, string | undefined>) =>
  buildNightly({
    now: "2026-11-03T03:30:00Z",
    runUrl: "https://example.test/run/1",
    main: "abc1234",
    release: "baton-v0.1.40",
    checks: Object.entries(outcomes).map(([key, outcome]) => ({
      name: key.split("@")[0]!,
      ref: key.endsWith("@release") ? "release" : "main",
      outcome,
    })),
  });

describe("the nightly status file", () => {
  it("maps job outcomes to pass, fail or skipped, and round-trips through the file", () => {
    expect([
      resultOf("success"),
      resultOf("failure"),
      resultOf("cancelled"),
      resultOf("skipped"),
      resultOf(undefined),
    ]).toEqual(["pass", "fail", "fail", "skipped", "skipped"]);
    const built = status({ "memory evals": "success", "voice proof@release": "failure" });
    expect(parseNightly(JSON.stringify(built))).toEqual(built);
    expect(parseNightly("{}")).toBeNull();
    expect(parseNightly("not json")).toBeNull();
    expect(
      parseNightly(
        JSON.stringify({ ...built, checks: [{ name: "x", ref: "main", result: "maybe" }] }),
      ),
    ).toBeNull();
  });

  it("tells the Now page what works, what failed on which build, and when it does not know", () => {
    expect(
      nightlyRow(
        status({ "memory evals": "success", "intent harness": "success", "hands loop": "skipped" }),
        NOW,
      ),
    ).toMatchObject({ state: "works", why: "All 2 checks passed 2 h ago." });
    const bad = nightlyRow(
      status({ "memory evals": "success", "voice proof@release": "failure" }),
      NOW,
    );
    expect(bad).toMatchObject({ state: "limited" });
    expect(bad.why).toContain("1 of 2 checks failed");
    expect(bad.why).toContain("voice proof on baton-v0.1.40");
    expect(nightlyRow(null, NOW).state).toBe("unknown");
    expect(nightlyRow(status({ "memory evals": "success" }), NOW + 3 * 86_400_000)).toMatchObject({
      state: "limited",
    });
  });
});

describe("the sync debt row", () => {
  const sync = (over: Record<string, unknown>) =>
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
  it("shows how far behind, and names the files when the last run stopped", () => {
    expect(syncRow(sync({}), NOW)).toMatchObject({ state: "works" });
    expect(syncRow(sync({}), NOW).why).toContain("12 commits behind");
    const stopped = syncRow(
      sync({
        result: "conflict",
        ok: false,
        behindCommits: 700,
        conflictingFiles: ["a/ChatView.tsx"],
      }),
      NOW,
    );
    expect(stopped.state).toBe("limited");
    expect(stopped.why).toContain("700 commits behind");
    expect(stopped.why).toContain("a/ChatView.tsx");
    expect(syncRow(null, NOW).state).toBe("unknown");
    expect(parseSync("{}")).toBeNull();
  });
});
