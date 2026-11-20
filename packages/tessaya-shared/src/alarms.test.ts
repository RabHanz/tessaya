import { describe, expect, it } from "vite-plus/test";

import {
  alarmSetLine,
  alarmStep,
  isAlarm,
  nextClock,
  RING_GAP_MS,
  RING_VOLUMES,
} from "./alarms.ts";

const ZONE = "Asia/Karachi";
// 20 Nov 07:27 in Karachi (02:27Z): "wake me up around 8:45".
const NOW = Date.parse("2026-11-20T02:27:00Z");

describe("alarms", () => {
  it("finds the next 8:45 in his zone, today or tomorrow, and refuses a clock that is not one", () => {
    expect(nextClock("8:45", NOW, ZONE)).toBe(Date.parse("2026-11-20T03:45:00Z"));
    expect(nextClock("07:00", NOW, ZONE)).toBe(Date.parse("2026-11-21T02:00:00Z"));
    expect(nextClock("25:00", NOW, ZONE)).toBeNull();
    expect(nextClock("8.45pm", NOW, ZONE)).toBeNull();
  });

  it("says the time and how far off it is, so a misheard time is caught", () => {
    const at = nextClock("8:45", NOW, ZONE)!;
    expect(alarmSetLine({ at, now: NOW, timeZone: ZONE })).toBe(
      "Waking you at 8:45 am, in about an hour.",
    );
    expect(alarmSetLine({ at, now: NOW, timeZone: ZONE, hours: "24h" })).toBe(
      "Waking you at 08:45, in about an hour.",
    );
  });

  it("rings softly, then louder a minute apart, stops after the last, and records one missed for hours", () => {
    const due = NOW;
    expect(alarmStep({ due, now: due - 1, rung: 0, lastRingAt: null })).toEqual({ kind: "wait" });
    expect(alarmStep({ due, now: due, rung: 0, lastRingAt: null })).toEqual({
      kind: "ring",
      volume: RING_VOLUMES[0],
      late: false,
    });
    expect(alarmStep({ due, now: due + 10_000, rung: 1, lastRingAt: due })).toEqual({
      kind: "wait",
    });
    expect(alarmStep({ due, now: due + RING_GAP_MS, rung: 1, lastRingAt: due })).toMatchObject({
      kind: "ring",
      volume: RING_VOLUMES[1],
    });
    expect(
      alarmStep({ due, now: due + 9 * RING_GAP_MS, rung: RING_VOLUMES.length, lastRingAt: due }),
    ).toEqual({ kind: "done" });
    // Her brain was down at its time: a few minutes late still rings (and says so), hours late is missed.
    expect(alarmStep({ due, now: due + 5 * 60_000, rung: 0, lastRingAt: null })).toMatchObject({
      kind: "ring",
      late: true,
    });
    expect(alarmStep({ due, now: due + 3 * 3_600_000, rung: 0, lastRingAt: null })).toEqual({
      kind: "missed",
    });
  });

  it("tells an alarm from any other commitment", () => {
    expect(isAlarm({ ref: "alarm" })).toBe(true);
    expect(isAlarm({ ref: "alarm:snoozed" })).toBe(true);
    expect(isAlarm({ ref: "job:1" })).toBe(false);
    expect(isAlarm({})).toBe(false);
  });
});
