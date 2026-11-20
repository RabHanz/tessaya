import type { UpcomingItem } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { countdownText, nextDailyAt, nextTickMs, orderUpcoming, timedRunFate } from "./upcoming.ts";

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);
const MIN = 60_000;
const item = (id: string, at: number | null, extra: Partial<UpcomingItem> = {}): UpcomingItem => ({
  id,
  source: "house",
  title: id,
  line: "",
  at,
  condition: at === null ? "Waiting for something" : null,
  repeats: null,
  paused: false,
  can: { cancel: true, pause: true, move: at !== null },
  ...extra,
});

describe("the order of what is coming up", () => {
  it("puts timed items soonest first, then the ones waiting on a condition, and leaves out what is too far or long past", () => {
    const order = orderUpcoming(
      [
        item("waits", null, { source: "rule" }),
        item("tomorrow", NOW + 24 * 60 * MIN),
        item("in 5", NOW + 5 * MIN),
        item("next month", NOW + 31 * 24 * 60 * MIN),
        item("a minute ago", NOW - MIN),
        item("an hour ago", NOW - 60 * MIN),
        item("house waits", null),
        item("paused in 2", NOW + 2 * MIN, { paused: true }),
        item("birthday today", NOW - 9 * 60 * MIN, { source: "date", allDay: true }),
      ],
      NOW,
    ).map((i) => i.id);
    expect(order).toEqual([
      "birthday today",
      "a minute ago",
      "paused in 2",
      "in 5",
      "tomorrow",
      "house waits",
      "waits",
    ]);
  });
});

describe("the countdown", () => {
  it("reads in seconds only in the last minute, and ticks each second only then", () => {
    expect(countdownText(item("a", NOW + 45_000), NOW)).toBe("in 45 s");
    expect(countdownText(item("a", NOW + 18 * MIN), NOW)).toBe("in 18 min");
    expect(countdownText(item("a", NOW + 125 * MIN), NOW)).toBe("in 2 h 5 min");
    expect(countdownText(item("a", NOW + 3 * 24 * 60 * MIN), NOW)).toBe("in 3 days");
    expect(countdownText(item("a", NOW - 1000), NOW)).toBe("running now");
    expect(countdownText(item("a", NOW + MIN, { paused: true }), NOW)).toBe("paused");
    expect(countdownText(item("a", null), NOW)).toBe("waiting");

    expect(nextTickMs([item("a", NOW + 45_000)], NOW)).toBe(1000);
    expect(nextTickMs([item("a", NOW + 45_000, { paused: true })], NOW)).toBe(MIN);
    expect(nextTickMs([item("a", NOW + 18 * MIN)], NOW + 20_000)).toBe(40_000);
  });
});

describe("a house time trigger's next run", () => {
  it("comes later today, or tomorrow once today's has passed", () => {
    // 10:00:00 on the house's clock.
    const clock = 10 * 3600;
    expect(nextDailyAt("10:15:00", clock, NOW)).toBe(NOW + 15 * MIN);
    expect(nextDailyAt("09:00", clock, NOW)).toBe(NOW + 23 * 60 * MIN);
    expect(nextDailyAt("10:00:00", clock, NOW)).toBe(NOW + 24 * 60 * MIN);
    expect(nextDailyAt("sunset", clock, NOW)).toBeNull();
  });
});

describe("what became of a timer's due run", () => {
  it("waits, sees it ran, makes up a short gap, and calls a long one missed", () => {
    const due = NOW;
    const fate = (now: number, lastTriggered: number | null, expiresAt: number | null = null) =>
      timedRunFate({ dueAt: due, setAt: due - 20 * MIN, lastTriggered, expiresAt, now });
    expect(fate(due + 30_000, null)).toBe("waiting");
    expect(fate(due + 2 * MIN, due)).toBe("ran");
    // The house or this server was down at its time.
    expect(fate(due + 2 * MIN, due - 24 * 60 * MIN)).toBe("late");
    expect(fate(due + 11 * MIN, null)).toBe("missed");
    expect(fate(due + 5 * MIN, null, due + 4 * MIN)).toBe("missed");
    // Set after its clock time last came: today's run is still ahead.
    expect(
      timedRunFate({
        dueAt: due,
        setAt: due + MIN,
        lastTriggered: null,
        expiresAt: null,
        now: due + 5 * MIN,
      }),
    ).toBe("waiting");
  });
});
