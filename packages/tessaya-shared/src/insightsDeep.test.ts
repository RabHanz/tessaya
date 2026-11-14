// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  computeDeepInsights,
  countFixes,
  describeSpeed,
  type InsightTurn,
} from "./insightsDeep.ts";

const now = Date.parse("2026-11-02T12:00:00");
const DAY = 86_400_000;
const turn = (daysAgo: number, raw: string, extra: Partial<InsightTurn> = {}): InsightTurn => ({
  at: new Date(now - daysAgo * DAY).toISOString(),
  kind: "dictation",
  app: "code.exe",
  raw,
  cleaned: raw,
  seconds: null,
  ...extra,
});

describe("deep insights", () => {
  it("counts the words that were fixed, not punctuation", () => {
    expect(countFixes("um so ths is it", "So this is it.")).toBe(2);
    expect(countFixes("same words here", "Same words here.")).toBe(0);
  });

  it("totals words, the month against the one before, and by kind of app", () => {
    const list = [
      turn(1, "one two three"),
      turn(3, "four five", { app: "slack.exe" }),
      turn(40, "six seven eight nine"),
      turn(2, "a spoken turn", { kind: "spoken" }),
    ];
    const r = computeDeepInsights(list, now);
    expect(r.totalWords).toBe(9);
    expect(r.monthWords).toBe(5);
    expect(r.previousMonthWords).toBe(4);
    expect(r.byCategory).toEqual([
      { label: "Everything else", words: 7 },
      { label: "Work messages", words: 2 },
    ]);
  });

  it("measures speed against his own past, with no percentile", () => {
    const list = [
      turn(1, "w ".repeat(120).trim(), { seconds: 60 }),
      turn(30, "w ".repeat(60).trim(), { seconds: 60 }),
    ];
    const r = computeDeepInsights(list, now);
    expect(r.wpm).toMatchObject({ recent: 120, before: 60 });
    expect(describeSpeed(r.wpm)).toContain("60 faster than before");
    expect(describeSpeed(r.wpm)).toContain("not a ranking");
    expect(describeSpeed(computeDeepInsights([], now).wpm)).toContain("Not enough");
  });

  it("builds a 50 day calendar with levels, the streak (today may be empty) and the best run", () => {
    const list = [turn(1, "a b"), turn(2, "a b c d"), turn(3, "a"), turn(10, "a"), turn(11, "a")];
    const r = computeDeepInsights(list, now);
    expect(r.calendar).toHaveLength(50);
    expect(r.calendar.at(-1)!.words).toBe(0);
    expect(r.calendar.at(-3)!.level).toBe(4);
    expect(r.streak).toBe(3);
    expect(r.bestStreak).toBe(3);
  });
});
