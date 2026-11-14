// @effect-diagnostics nodeBuiltinImport:off
import type { BatonJob, WatchFinding } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { answerNeeds } from "./needsAnswer.ts";

describe("answering what needs me", () => {
  it("lists the failed session first and says a source it could not read", async () => {
    const text = await answerNeeds({
      jobs: [] as ReadonlyArray<BatonJob>,
      sessions: [],
      findings: [
        { workSessionId: "w1", title: "Deploy", kind: "failed", minutes: 20 },
      ] as unknown as ReadonlyArray<WatchFinding>,
      config: { repos: ["o/r"], deadlinesFile: null },
      now: Date.parse("2026-11-02T12:00:00Z"),
      run: async () => {
        throw new Error("offline");
      },
    });
    expect(text).toBe("1. Deploy: failed (20 min) [id: w1]\nI could not read: the ledger o/r.");
  });

  it("lists an expected source with no feed as not connected, and reads a fresh one", async () => {
    const NodeFS = await import("node:fs");
    const NodeOS = await import("node:os");
    const NodePath = await import("node:path");
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "feeds-"));
    const file = NodePath.join(dir, "cockpit.json");
    const now = Date.parse("2026-11-02T12:00:00Z");
    NodeFS.writeFileSync(
      file,
      JSON.stringify({
        source: "Cockpit approvals",
        asOf: "2026-11-02T11:00:00Z",
        items: [{ id: "1", title: "Approve the offer", why: "waiting", weight: 90 }],
      }),
    );
    const text = await answerNeeds({
      jobs: [],
      sessions: [],
      findings: [],
      config: {
        repos: [],
        deadlinesFile: null,
        feeds: [file],
        expect: ["Cockpit approvals", "Peers' status"],
      },
      now,
    });
    expect(text).toBe(
      "1. Approve the offer: waiting (Cockpit approvals)\nI could not read: Peers' status (not connected).",
    );
  });
});
