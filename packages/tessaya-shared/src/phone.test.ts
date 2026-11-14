import type { TessayaJob, WatchFinding } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPhoneState, checkWav, decisionLabel, parseDecision } from "./phone.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const job = (over: Record<string, unknown>) =>
  ({
    workSessionId: "j1",
    title: "Site",
    goal: "g",
    group: "running",
    state: "working",
    phase: "approved",
    limitReached: null,
    permissionsSummary: "Edit files in the shop",
    lastActivityAt: "2026-11-02T11:59:00Z",
    terms: {
      limits: { wallClockMinutes: 120, workerTurns: 40, dollars: null },
      revisions: [],
      permissions: { projects: [] },
    },
    ...over,
  }) as unknown as TessayaJob;

describe("buildPhoneState", () => {
  const state = buildPhoneState({
    jobs: [
      job({
        workSessionId: "plan",
        title: "Plan me",
        phase: "awaiting_agreement",
        state: "needs_approval",
      }),
      job({ workSessionId: "run", title: "Running one" }),
      job({ workSessionId: "bad", title: "Broken", group: "failed", state: "idle" }),
    ],
    findings: [
      { workSessionId: "s1", title: "Session", kind: "unanswered", minutes: 12 } as WatchFinding,
    ],
    weaves: [],
    now: NOW,
  });

  it("lists the plan as an approval he can answer, with the exact action, and counts the badge", () => {
    expect(state.approvals).toMatchObject([
      { ref: "plan", action: "Start the work as planned", answerable: true },
    ]);
    expect(state.badge).toBe(state.needs.length);
    expect(state.needs.map((n) => n.id)).toEqual(
      expect.arrayContaining(["ws:plan", "ws:bad", "ws:s1"]),
    );
  });

  it("offers Stop on a running job and Retry only where it is allowed, saying why not", () => {
    const by = (id: string) => state.jobs.find((j) => j.id === id)!;
    expect(by("run")).toMatchObject({ canStop: true, canRetry: false });
    expect(by("run").retryWhy).toContain("not failed");
    expect(by("bad")).toMatchObject({ canStop: false, canRetry: true, status: "failed" });
    expect(by("plan").canStop).toBe(false);
    expect(state.now).toEqual(["Running one: working"]);
  });
});

describe("the small checks", () => {
  it("labels the buttons with the exact action and reads only approve or deny", () => {
    expect(decisionLabel({ action: "Start the work as planned" }, "deny")).toBe(
      "Deny: Start the work as planned",
    );
    expect(parseDecision("approve")).toBe("approve");
    expect(parseDecision("yes please")).toBeNull();
  });
  it("takes only a 16 kHz mono 16-bit WAV of a sane size", () => {
    const wav = (rate: number, bits = 16) => {
      const b = new Uint8Array(44 + 100);
      const v = new DataView(b.buffer);
      b.set([82, 73, 70, 70], 0);
      b.set([87, 65, 86, 69], 8);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, rate, true);
      v.setUint16(34, bits, true);
      return b;
    };
    expect(checkWav(wav(16_000))).toBeNull();
    expect(checkWav(wav(44_100))).toContain("16 kHz");
    expect(checkWav(new Uint8Array(10))).toContain("empty");
    expect(checkWav(new Uint8Array(200))).toContain("not a WAV");
  });
});
