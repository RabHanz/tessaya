// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_STANDING } from "./standingJobs.ts";
import { standingAction, standingReport } from "./standingReport.ts";

const now = new Date(2026, 10, 9, 7, 0).getTime(); // a Monday, 07:00 here
const at = (h: number, m = 0, d = 9) => new Date(2026, 10, d, h, m).getTime();
const morning = {
  id: "user:1",
  title: "CI check",
  instruction: "check CI and tell me what broke",
  owner: "executive",
  tools: ["jobs_list"],
  on: true,
  proposed: false,
  from: "him" as const,
  missed: "once" as const,
  createdAt: 0,
  trigger: { kind: "time" as const, hour: 8, minute: 0, days: [] },
};
const state = { ...EMPTY_STANDING, on: { nightly_learning: true, ci_look: true } };
const input = { jobs: [morning], runs: [], state, now };

describe("standing jobs for Coming up", () => {
  it("reports each job's next run, what an event job waits for, and leaves proposals out", () => {
    const report = standingReport({
      ...input,
      jobs: [morning, { ...morning, id: "user:2", proposed: true }],
    });
    const byId = Object.fromEntries(report.map((j) => [j.id, j]));
    expect(byId["user:1"]).toMatchObject({ on: true, at: at(8), movable: true });
    expect(byId["user:2"]).toBeUndefined();
    expect(byId["nightly_learning"]).toMatchObject({ on: true, at: at(2, 0, 10), movable: true });
    expect(byId["ci_look"]).toMatchObject({ at: null, movable: false });
    expect(byId["ci_look"]!.condition).toMatch(/^Runs when/);
  });

  it("turns a change into his switch, a moved run within its day, or nothing", () => {
    expect(standingAction({ id: "user:1", op: "pause" }, input)).toEqual({
      kind: "user",
      id: "user:1",
      patch: { on: false },
    });
    expect(standingAction({ id: "user:1", op: "move", at: at(8, 15) }, input)).toEqual({
      kind: "user",
      id: "user:1",
      patch: { moved: { day: "2026-11-09", at: at(8, 15) } },
    });
    expect(standingAction({ id: "user:1", op: "move", at: at(8, 15, 10) }, input)).toBeNull();
    expect(standingAction({ id: "nightly_learning", op: "resume" }, input)).toEqual({
      kind: "builtin",
      id: "nightly_learning",
      on: true,
    });
    expect(standingAction({ id: "user:9", op: "pause" }, input)).toBeNull();
  });
});
