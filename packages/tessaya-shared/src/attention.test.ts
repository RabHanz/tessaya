// @effect-diagnostics globalDate:off
import type { TessayaJob, TessayaRecordEntry, WatchFinding } from "@t3tools/tessaya-contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  freshFindings,
  inQuietHours,
  isSilenced,
  morningBrief,
  noticeLine,
  planReadyLine,
} from "./attention.ts";

const f = (id: string, kind: WatchFinding["kind"]) =>
  ({ workSessionId: id, title: `Work ${id}`, kind, minutes: 40 }) as unknown as WatchFinding;

describe("unprompted notices", () => {
  it("wraps quiet hours over midnight, and none is never quiet", () => {
    expect(inQuietHours("22-8", 23)).toBe(true);
    expect(inQuietHours("22-8", 7)).toBe(true);
    expect(inQuietHours("22-8", 8)).toBe(false);
    expect(inQuietHours("0-9", 3)).toBe(true);
    expect(inQuietHours("none", 3)).toBe(false);
  });
  it("announces a finding once, again after it clears, and leaves 'unseen' for the morning", () => {
    const a = freshFindings([f("1", "failed"), f("2", "unseen")], new Set());
    expect(a.fresh.map((x) => x.workSessionId)).toEqual(["1"]);
    expect(freshFindings([f("1", "failed")], a.next).fresh).toEqual([]);
    expect(freshFindings([], a.next).next.size).toBe(0);
    expect(freshFindings([f("1", "failed")], new Set()).fresh).toHaveLength(1);
  });
  it("says one line however many there are", () => {
    expect(noticeLine([])).toBeNull();
    expect(noticeLine([f("1", "failed")])).toBe("Work 1 failed.");
    expect(noticeLine([f("1", "unanswered"), f("2", "failed"), f("3", "failed")])).toBe(
      "Work 1 is waiting for you, and 2 more need a look.",
    );
  });
});

describe("the morning brief", () => {
  const NOW = Date.parse("2026-11-03T08:00:00.000Z");
  const job = (title: string, group: string, hoursAgo: number) =>
    ({
      title,
      group,
      lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - hoursAgo * 3_600_000)),
    }) as unknown as TessayaJob;
  it("reports the last day only, and says so when nothing happened", () => {
    const text = morningBrief({
      jobs: [
        job("Site", "done", 5),
        job("Old", "done", 80),
        job("Audit", "running", 30),
        job("Tax", "needs_you", 2),
      ],
      findings: [f("9", "failed")],
      now: NOW,
    });
    expect(text).toBe(
      "Good morning. Finished: Site. Failed: Work 9. Waiting for you: Tax. Still running: Audit.",
    );
    expect(morningBrief({ jobs: [], findings: [], now: NOW })).toContain("Nothing happened");
    // What the server's watch kept since the last brief: named as past when it cleared, once, by session.
    expect(
      morningBrief({
        jobs: [],
        findings: [f("1", "failed")],
        earlier: [f("1", "failed"), f("2", "failed"), f("2", "failed"), f("3", "stalled")],
        now: NOW,
      }),
    ).toBe("Good morning. Failed: Work 1. Failed overnight: Work 2. Stalled earlier: Work 3.");
    // Two sessions with one title are two; a brief days ago says so.
    const same = (id: string) => ({ ...f(id, "failed"), title: "Deploy" }) as WatchFinding;
    expect(
      morningBrief({
        jobs: [],
        findings: [],
        earlier: [same("7"), same("8"), same("8")],
        since: NOW - 3 * 24 * 3_600_000,
        now: NOW,
      }),
    ).toBe("Good morning. Failed since the last brief: Deploy, Deploy.");
  });

  it("carries the Record's note when a persona or the team passed the turn guide in the last day", () => {
    const note = (actor: string, n: number, hoursAgo: number) =>
      ({
        kind: "background_turns",
        actor,
        at: DateTime.formatIso(DateTime.makeUnsafe(NOW - hoursAgo * 3_600_000)),
        subject: `${actor} has used ${n} background turns today, past the guide of 40. Nothing was stopped.`,
      }) as unknown as TessayaRecordEntry;
    expect(
      morningBrief({
        jobs: [],
        findings: [],
        now: NOW,
        guide: [note("Freya", 41, 3), note("team", 130, 2), note("Alfred", 50, 30)],
      }),
    ).toBe(
      "Good morning. Past the daily guide for background turns: Freya 41, the team 130. Nothing was stopped.",
    );
  });
});

describe("being silenced", () => {
  const at = new Date(2026, 10, 3, 12, 0, 0);
  it("is silent for quiet hours, Do not disturb, or a snooze that has not ended", () => {
    expect(isSilenced({ quietHours: "none" }, at)).toBe(false);
    expect(isSilenced({ quietHours: "11-13" }, at)).toBe(true);
    expect(isSilenced({ quietHours: "none", doNotDisturb: true }, at)).toBe(true);
    expect(isSilenced({ quietHours: "none", snoozeUntil: at.getTime() + 1 }, at)).toBe(true);
    expect(isSilenced({ quietHours: "none", snoozeUntil: at.getTime() }, at)).toBe(false);
  });
});

describe("a plan ready for his yes", () => {
  const job = (id: string, phase: "drafting_plan" | "awaiting_agreement" | "approved") => ({
    workSessionId: id as never,
    title: `Job ${id}`,
    phase,
  });
  it("is said once, pointing at its thread, and again only when it is ready again", () => {
    const first = planReadyLine(
      [job("a", "awaiting_agreement"), job("b", "drafting_plan")],
      new Set(),
    );
    expect(first.line).toBe("The plan for Job a is ready in its thread.");
    expect(planReadyLine([job("a", "awaiting_agreement")], first.next).line).toBeNull();
    const agreed = planReadyLine([job("a", "approved")], first.next);
    expect(planReadyLine([job("a", "awaiting_agreement")], agreed.next).line).not.toBeNull();
  });
});
