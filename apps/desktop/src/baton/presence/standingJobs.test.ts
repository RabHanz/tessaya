// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { BatonJob, WatchFinding } from "@t3tools/tessaya-contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createStandingStore,
  EMPTY_STANDING,
  latestRuns,
  migrateStanding,
  missedRunOf,
  runStandingJobs,
  statusOf,
  type StandingInput,
  type StandingOps,
  type StandingState,
} from "./standingJobs.ts";

const NOW = Date.parse("2026-11-03T09:00:00Z");
const allOn: StandingState = {
  ...EMPTY_STANDING,
  on: {
    ci_look: true,
    morning_brief: true,
    waiting_remind: true,
    job_summary: true,
    nightly_learning: true,
  },
};
const ci = (runId: number) => ({
  repo: "o/r",
  runId,
  name: "ci",
  branch: "main",
  conclusion: "failure",
  createdAt: "2026-11-03T08:00:00Z",
});
const waiting = {
  workSessionId: "w1",
  title: "Build",
  kind: "unanswered",
  minutes: 90,
} as WatchFinding;
const done = (id: string, at: string) =>
  ({
    workSessionId: id,
    title: id,
    group: "done",
    phase: "approved",
    lastActivityAt: at,
    usage: { minutes: 12, turns: 5, dollars: 0.5 },
  }) as unknown as BatonJob;

const fakes = () => {
  const log = {
    looked: [] as string[],
    said: [] as string[],
    noted: [] as string[],
    briefs: 0,
    learned: 0,
  };
  const ops: StandingOps = {
    look: async (t) => (log.looked.push(t.id), "read-only job started"),
    brief: async () => (log.briefs++, "the brief"),
    say: (t) => void log.said.push(t),
    note: async (id) => void log.noted.push(id),
    learn: async () => (log.learned++, "Learned nothing new; 6 replays."),
  };
  return { log, ops };
};
const input = (over: Partial<StandingInput> = {}): StandingInput => ({
  state: allOn,
  refusal: () => null,
  now: NOW,
  day: "Tue",
  hour: 9,
  findings: [waiting],
  ci: [ci(1)],
  jobs: [done("j1", "2026-11-03T08:30:00Z"), done("old", "2026-10-01T08:30:00Z")],
  ...over,
});

describe("standing jobs", () => {
  it("does nothing while all are off", async () => {
    const { log, ops } = fakes();
    const r = await runStandingJobs(input({ state: EMPTY_STANDING }), ops);
    expect(r.did).toEqual([]);
    expect(log).toEqual({ looked: [], said: [], noted: [], briefs: 0, learned: 0 });
  });

  it("runs each switched-on playbook once for what it saw, and logs it", async () => {
    const { log, ops } = fakes();
    const first = await runStandingJobs(input(), ops);
    expect(first.did.map((d) => d.id).toSorted()).toEqual([
      "ci_look",
      "job_summary",
      "morning_brief",
      "nightly_learning",
      "waiting_remind",
    ]);
    expect(log.learned).toBe(1);
    expect(log.noted).toEqual(["j1"]);
    expect(log.said).toHaveLength(1);
    const again = await runStandingJobs(input({ state: first.state }), ops);
    expect(again.did).toEqual([]);
    expect(first.state.brief).toEqual({ day: "Tue", text: "the brief" });
  });

  it("is never capped: every run is counted, and each runs once for what it saw", async () => {
    const { log, ops } = fakes();
    const r = await runStandingJobs(
      input({ ci: [1, 2, 3, 4, 5].map((n) => ({ ...ci(n), repo: `o/r${n}` })) }),
      ops,
    );
    expect(log.looked).toHaveLength(5);
    expect(r.state.counts.ci_look).toBe(5);
  });

  it("holds a job its owner may not run by itself, once, and runs nothing for it", async () => {
    const { log, ops } = fakes();
    const r = await runStandingJobs(
      input({
        refusal: (job) =>
          job.id === "job_summary" ? "job_refine is not one of Alfred's tools." : null,
      }),
      ops,
    );
    expect(log.noted).toEqual([]);
    expect(r.did.find((d) => d.id === "job_summary")).toMatchObject({
      outcome: "held",
      text: "Held: job_refine is not one of Alfred's tools.",
    });
    expect(r.state.counts.job_summary).toBeUndefined();
    const again = await runStandingJobs(input({ state: r.state }), ops);
    expect(again.did.some((d) => d.id === "job_summary")).toBe(false);
  });

  it("moves an older playbooks file over, keeping a brief he was getting either way", () => {
    const old = {
      on: { ci_look: true },
      runs: [{ id: "ci_look", key: "k", at: 1, text: "t" }],
      brief: null,
    };
    const moved = migrateStanding(old, true);
    // Nightly learning starts on (the Director asked for it); one he turned off stays off.
    expect(moved.on).toEqual({ ci_look: true, morning_brief: true, nightly_learning: true });
    expect(moved.runs[0]?.outcome).toBe("ran");
    expect(migrateStanding(null, false).on).toEqual({
      morning_brief: false,
      nightly_learning: true,
    });
    expect(migrateStanding({ on: { nightly_learning: false } }, true).on.nightly_learning).toBe(
      false,
    );
    expect(migrateStanding({ on: { morning_brief: true } }, false).on.morning_brief).toBe(true);
  });

  it("does not give a second brief on the day of the upgrade when the old switch already gave one", async () => {
    const { log, ops } = fakes();
    const state = migrateStanding(null, true, "Tue");
    await runStandingJobs(input({ state }), ops);
    expect(log.briefs).toBe(0);
    await runStandingJobs(input({ state, day: "Wed" }), ops);
    expect(log.briefs).toBe(1);
  });

  it("a pass saves its runs but never undoes a switch he flipped while it ran", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-standing-"));
    const store = createStandingStore(dir, () => ({ briefOn: false, briefGivenOn: null }));
    store.setOn("job_summary", true);
    const started = store.load();
    store.setOn("job_summary", false);
    store.saveRun({ ...started, counts: { job_summary: 1 } });
    expect(store.load().on.job_summary).toBe(false);
    expect(store.load().counts.job_summary).toBe(1);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("records a failing op and still runs the others", async () => {
    const { log, ops } = fakes();
    const r = await runStandingJobs(input(), {
      ...ops,
      look: async () => {
        throw new Error("no gh");
      },
    });
    expect(r.did.find((d) => d.id === "ci_look")?.text).toContain("Failed: no gh");
    expect(log.briefs).toBe(1);
  });

  it("says nothing aloud while silenced, and still reminds once it ends", async () => {
    const { log, ops } = fakes();
    const quiet = await runStandingJobs(input({ quiet: true }), ops);
    expect(log.said).toEqual([]);
    expect(quiet.did.some((d) => d.id === "waiting_remind")).toBe(false);
    await runStandingJobs(input({ state: quiet.state }), ops);
    expect(log.said).toHaveLength(1);
  });

  it("learns once a night, from two o'clock, as the lead's job", async () => {
    const { log, ops } = fakes();
    const early = await runStandingJobs(input({ hour: 1 }), ops);
    expect(log.learned).toBe(0);
    const night = await runStandingJobs(input({ state: early.state, hour: 2, quiet: true }), ops);
    expect(night.did.find((d) => d.id === "nightly_learning")?.text).toBe(
      "Learned nothing new; 6 replays.",
    );
    await runStandingJobs(input({ state: night.state, hour: 3 }), ops);
    expect(log.learned).toBe(1);
  });

  it("makes up a timed job missed while it was off once the same day, or skips it, as set per job", async () => {
    const once = fakes();
    // Off at six, first running at nine: the default runs it once, and not again that day.
    const back = await runStandingJobs(input({ hour: 9 }), once.ops);
    await runStandingJobs(input({ state: back.state, hour: 10 }), once.ops);
    expect(once.log.briefs).toBe(1);
    const skip = fakes();
    const skipping: StandingState = {
      ...allOn,
      missed: { morning_brief: "skip", nightly_learning: "skip" },
    };
    await runStandingJobs(input({ state: skipping, hour: 9 }), skip.ops);
    expect(skip.log.briefs).toBe(0);
    expect(skip.log.learned).toBe(0);
    expect(missedRunOf(allOn, "morning_brief")).toBe("once");
  });

  it("does not count quiet hours or a clock change as a missed hour, even when set to skip", async () => {
    const skipping: StandingState = {
      ...allOn,
      missed: { morning_brief: "skip", nightly_learning: "skip" },
    };
    // Running since one in the morning: quiet hours hold the brief at six, and it comes at eight when they end.
    const { log, ops } = fakes();
    const night = await runStandingJobs(input({ state: skipping, hour: 1 }), ops);
    const six = await runStandingJobs(input({ state: night.state, hour: 6, quiet: true }), ops);
    expect(log.briefs).toBe(0);
    await runStandingJobs(input({ state: six.state, hour: 8 }), ops);
    expect(log.briefs).toBe(1);
    // A spring-forward night with no two o'clock: learning runs at three, the next hour there is.
    const spring = fakes();
    const one = await runStandingJobs(input({ state: skipping, hour: 1 }), spring.ops);
    expect(spring.log.learned).toBe(0);
    await runStandingJobs(input({ state: one.state, hour: 3 }), spring.ops);
    expect(spring.log.learned).toBe(1);
  });

  it("builds no brief before six, nor in quiet hours", async () => {
    const { log, ops } = fakes();
    await runStandingJobs(input({ hour: 5 }), ops);
    await runStandingJobs(input({ quiet: true }), ops);
    expect(log.briefs).toBe(0);
  });

  it("records each run's status: ok, error, timed out, or cancelled when One Trust held it", async () => {
    const { ops } = fakes();
    const failing: StandingOps = {
      ...ops,
      learn: async () => Promise.reject(new Error("no model")),
    };
    const errored = await runStandingJobs(input({ hour: 3 }), failing);
    expect(errored.did.find((d) => d.id === "nightly_learning")?.status).toBe("error");
    const held = await runStandingJobs(input({ hour: 3, refusal: () => "asks first" }), ops);
    expect(held.did.every((d) => d.status === "cancelled")).toBe(true);
    // Runs saved before statuses existed read from their outcome.
    expect(statusOf({ id: "ci_look", key: "k", at: 0, outcome: "failed", text: "" })).toBe("error");
  });

  it("ends a run that runs out of time, and tells its op so it does nothing late", async () => {
    const { ops } = fakes();
    let seen: AbortSignal | null = null;
    const stuck: StandingOps = {
      ...ops,
      learn: (signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    };
    vi.useFakeTimers();
    try {
      const pass = runStandingJobs(input({ hour: 3, runTimeoutMs: 60_000 }), stuck);
      await vi.advanceTimersByTimeAsync(60_000);
      const timed = await pass;
      const run = timed.did.find((d) => d.id === "nightly_learning")!;
      expect(statusOf(run)).toBe("timeout");
      expect(run.text).toContain("Timed out");
      expect(seen!.aborted).toBe(true);
      expect(latestRuns(timed.state)[0]?.id).toBe(timed.state.runs.at(-1)?.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an event job quiet when the same failure repeats, but not after a fix, nor after six hours", async () => {
    const { log, ops } = fakes();
    const quiet: StandingState = { ...allOn, quiet: { ci_look: true } };
    const first = await runStandingJobs(input({ state: quiet, ci: [ci(1)] }), ops);
    expect(log.looked).toHaveLength(1);
    const later = (runId: number, minutes: number, conclusion = "failure") => ({
      ...ci(runId),
      conclusion,
      createdAt: new Date(Date.parse("2026-11-03T08:00:00Z") + minutes * 60_000).toISOString(),
    });
    // The same workflow on the same branch fails again: kept, said nothing, started nothing.
    const again = await runStandingJobs(input({ state: first.state, ci: [later(2, 30)] }), ops);
    expect(log.looked).toHaveLength(1);
    expect(again.did.at(-1)?.text).toMatch(/^Unchanged: /);
    // It went green, then failed anew: that is news.
    await runStandingJobs(
      input({ state: again.state, ci: [later(3, 40, "success"), later(4, 50)] }),
      ops,
    );
    expect(log.looked).toHaveLength(2);
    // The same failure seven hours on is reported again.
    const fresh = fakes();
    const one = await runStandingJobs(input({ state: quiet, ci: [ci(1)] }), fresh.ops);
    await runStandingJobs(
      input({ state: one.state, now: NOW + 7 * 3_600_000, ci: [later(5, 60)] }),
      fresh.ops,
    );
    expect(fresh.log.looked).toHaveLength(2);
  });
});
