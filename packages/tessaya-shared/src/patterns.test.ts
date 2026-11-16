import { describe, expect, it } from "vite-plus/test";

import {
  calibrationOf,
  EMPTY_STATS,
  findings,
  observe,
  predictNext,
  type LocalClock,
} from "./patterns.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
// UTC: day 0 of the epoch was a Thursday.
const clock: LocalClock = (at) => ({
  weekday: (Math.floor(at / DAY) + 4) % 7,
  hour: Math.floor(at / HOUR) % 24,
});
const fold = (events: ReadonlyArray<readonly [string, number]>) =>
  events.reduce((s, [k, at]) => observe(s, k, at, clock), EMPTY_STATS);

describe("patterns", () => {
  it("learns that one event follows another, predicts it, and scores the prediction", () => {
    const events: Array<readonly [string, number]> = [];
    for (let d = 0; d < 8; d++)
      events.push(
        ["job:failed", d * DAY + 10 * HOUR],
        ["assistant_turn:answered", d * DAY + 10 * HOUR + 60_000],
      );
    const s = fold(events);
    expect(predictNext(s, "job:failed")).toMatchObject({
      key: "assistant_turn:answered",
      p: 1,
      n: 8,
    });
    // From the fourth event on, each was predicted by the one before (the first pair only teaches).
    expect(calibrationOf(s)).toMatchObject({ scored: 13, hitRate: 1, brier: 0 });
    expect(findings(s, 8 * DAY, clock).map((f) => f.id)).toContain(
      "stat:seq:job:failed>assistant_turn:answered",
    );
  });

  it("finds a weekly routine but not a scattered key", () => {
    const routine = Array.from(
      { length: 5 },
      (_, w) => ["standup", w * 7 * DAY + 9 * HOUR] as const,
    );
    const scattered = Array.from({ length: 5 }, (_, i) => ["random", i * 29 * HOUR] as const);
    const ids = findings(fold([...routine, ...scattered]), 40 * DAY, clock).map((f) => f.id);
    expect(ids.some((id) => id.startsWith("stat:routine:standup:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("stat:routine:random:"))).toBe(false);
  });

  it("flags an hour far busier than that hour usually is, and not an ordinary one", () => {
    const usual: Array<readonly [string, number]> = [];
    for (let w = 0; w < 30; w++)
      usual.push(
        ["x", w * 7 * DAY + 14 * HOUR],
        ["x", w * 7 * DAY + 14 * HOUR + 1],
        ["y", w * 7 * DAY + 20 * HOUR],
      );
    const now = 30 * 7 * DAY + 14 * HOUR;
    const burst = Array.from({ length: 12 }, (_, i) => ["x", now + i * 1000] as const);
    const busy = (events: ReadonlyArray<readonly [string, number]>) =>
      findings(fold(events), now + 20_000, clock).some((f) => f.id.startsWith("stat:busy:"));
    expect(busy([...usual, ...burst])).toBe(true);
    expect(busy([...usual, ["x", now], ["x", now + 1]])).toBe(false);
  });

  it("notices a change in daily volume", () => {
    const events: Array<readonly [string, number]> = [];
    for (let d = 0; d < 28; d++) {
      const n = d < 21 ? 3 + (d % 2) : 12;
      for (let i = 0; i < n; i++) events.push(["e", d * DAY + i * HOUR]);
    }
    const f = findings(fold(events), 27 * DAY + 20 * HOUR, clock);
    expect(f.some((x) => x.id.startsWith("stat:change:"))).toBe(true);
  });
});
