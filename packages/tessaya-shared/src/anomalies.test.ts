import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  anomalyFromCi,
  anomalyFromJobs,
  anomalyFromPressure,
  EMPTY_TRACK,
  titleKey,
  trackJobs,
} from "./anomalies.ts";

const MIN = 60_000;

describe("anomalies", () => {
  it("treats a dated repeat of a job as the same job", () => {
    expect(titleKey("Nightly report 2026-11-01")).toBe(titleKey("Nightly report 2026-11-02"));
  });

  it("flags a job far slower than its usual, only after enough history", () => {
    let t = EMPTY_TRACK;
    let at = 0;
    for (let n = 1; n <= 3; n++) {
      t = trackJobs(t, [{ id: `a${n}`, title: `Report ${n}`, group: "running" }], at);
      at += 10 * MIN;
      t = trackJobs(t, [{ id: `a${n}`, title: `Report ${n}`, group: "done" }], at);
    }
    expect(t.history["report"]).toEqual([10, 10, 10]);
    t = trackJobs(t, [{ id: "b", title: "Report 4", group: "running" }], at);
    expect(anomalyFromJobs(t, at + 20 * MIN)).toEqual([]);
    const slow = anomalyFromJobs(t, at + 40 * MIN);
    expect(slow.map((x) => x.kind)).toEqual(["job_slow"]);
    expect(slow[0]?.offer).toBe(
      "Report 4 has run for 40 minutes; it usually takes about 10 minutes. Want me to look?",
    );
    expect(
      anomalyFromJobs(
        trackJobs(EMPTY_TRACK, [{ id: "c", title: "New", group: "running" }], 0),
        500 * MIN,
      ),
    ).toEqual([]);
  });

  it("raises the same job failing three times in a row, and a success resets it", () => {
    let t = EMPTY_TRACK;
    for (let n = 0; n < 3; n++) {
      t = trackJobs(t, [{ id: `f${n}`, title: "Sync", group: "running" }], n * 100);
      t = trackJobs(t, [{ id: `f${n}`, title: "Sync", group: "failed" }], n * 100 + 5);
    }
    expect(anomalyFromJobs(t, 1000).map((x) => x.kind)).toEqual(["step_repeating"]);
    t = trackJobs(t, [{ id: "ok", title: "Sync", group: "running" }], 2000);
    t = trackJobs(t, [{ id: "ok", title: "Sync", group: "done" }], 2005);
    expect(anomalyFromJobs(t, 3000)).toEqual([]);
  });

  it("raises a workflow whose last three runs failed", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const run = (id: number, conclusion: string, ago: number) => ({
      repo: "o/r",
      runId: id,
      name: "verify",
      branch: "main",
      conclusion,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - ago * MIN)),
    });
    expect(
      anomalyFromCi([run(3, "failure", 5), run(2, "failure", 60), run(1, "failure", 120)], now),
    ).toHaveLength(1);
    expect(
      anomalyFromCi([run(3, "failure", 5), run(2, "success", 60), run(1, "failure", 120)], now),
    ).toEqual([]);
  });

  it("warns on low disk or memory on this machine and stays quiet otherwise", () => {
    expect(
      anomalyFromPressure({ freeDiskGb: 40, totalDiskGb: 500, freeMemPct: 30 }, "this PC"),
    ).toEqual([]);
    const low = anomalyFromPressure(
      { freeDiskGb: 2.4, totalDiskGb: 500, freeMemPct: 3 },
      "this PC",
    );
    expect(low.map((x) => x.id)).toEqual(["pressure:disk:this PC", "pressure:mem:this PC"]);
  });
});
