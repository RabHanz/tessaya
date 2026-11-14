import { describe, expect, it } from "vite-plus/test";

import {
  limitsAge,
  maskedEmail,
  queuedText,
  accountByWords,
  roomDetail,
  roomText,
  roomTone,
} from "./accountRoom.ts";

const now = Date.parse("2026-10-30T12:00:00Z");
// @effect-diagnostics-next-line globalDate:off -- a display label, not a date value
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("limitsAge", () => {
  it("states a fresh reading's age", () => {
    expect(limitsAge(ago(0), now)).toEqual({ text: "Read just now", stale: false });
    expect(limitsAge(ago(4), now)).toEqual({ text: "Read 4 min ago", stale: false });
  });

  it("calls a reading stale once the probe has missed three ticks", () => {
    expect(limitsAge(ago(15), now)?.stale).toBe(false);
    expect(limitsAge(ago(16), now)).toEqual({ text: "Stale: last read 16 min ago", stale: true });
    expect(limitsAge(ago(180), now)?.text).toBe("Stale: last read 3 h ago");
    expect(limitsAge(ago(2880), now)?.text).toBe("Stale: last read 2 d ago");
  });

  it("does not invent an age from a bad timestamp", () => {
    expect(limitsAge("not a date", now)).toBeNull();
  });
});

describe("room as % used", () => {
  const limit = (usedPercent: number, resetsAt: string | null = null) => ({
    usedPercent,
    resetsAt,
  });

  it("reads both windows, or the weekly one alone, and turns amber at 80% and red at the limit", () => {
    expect(roomText({ fiveHour: limit(34.4), weekly: limit(62) }, now)).toBe("5h 34% · wk 62%");
    expect(roomText({ fiveHour: null, weekly: limit(14) }, now)).toBe("wk 14%");
    expect(roomText({ fiveHour: null, weekly: null }, now)).toBeNull();
    expect(maskedEmail("someone@example.com")).toBe("so•••••@example.com");
    expect(roomTone({ fiveHour: limit(79), weekly: limit(12) })).toBe("ok");
    expect(roomTone({ fiveHour: limit(86), weekly: limit(12) })).toBe("warn");
    expect(roomTone({ fiveHour: limit(100), weekly: limit(12) })).toBe("limit");
  });

  it("says when a spent account is back, and resets in GMT+5, never UTC", () => {
    const room = {
      fiveHour: limit(100, "2026-10-30T13:00:00Z"),
      weekly: limit(62, "2026-11-05T04:00:00Z"),
    };
    expect(roomText(room, now)).toBe("at limit · back 18:00 (GMT+5)");
    expect(roomDetail(room, now)).toEqual([
      "5-hour: 100% used · resets 18:00 (GMT+5)",
      "Weekly: 62% used · resets Thu 09:00 (GMT+5)",
    ]);
  });
});

describe("a terminal session's queued change", () => {
  it("names the account it moves to and what else waits for the turn to end", () => {
    const accounts = [{ label: "Work", liveSwitchKey: "1" }];
    expect(queuedText({ accountKey: "1", effort: "high" }, accounts)).toBe(
      "Switches to Work, effort high when this turn ends",
    );
    expect(queuedText({ accountKey: "9" }, accounts)).toBe(
      "Switches to another account when this turn ends",
    );
    expect(queuedText({ accountKey: "1" }, accounts, true)).toBe("Switches to Work now");
  });
});

describe("the login his words name", () => {
  it("takes an address, or a name only one login has", () => {
    const accounts = [
      { label: "Work", email: "work@example.com" },
      { label: "Home", email: "homeoffice@example.com" },
      { label: "Studio", email: "studio@example.com" },
    ];
    expect(accountByWords(accounts, "the work account")?.label).toBe("Work");
    expect(accountByWords(accounts, "HOMEOFFICE@example.com")?.label).toBe("Home");
    expect(accountByWords(accounts, "stud")?.label).toBe("Studio");
    // Several match, or none: never a guess.
    expect(accountByWords(accounts, "o")).toBeNull();
    expect(accountByWords(accounts, "garden")).toBeNull();
    expect(accountByWords(accounts, "account")).toBeNull();
  });
});
