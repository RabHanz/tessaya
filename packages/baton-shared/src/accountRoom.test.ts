import { describe, expect, it } from "vite-plus/test";

import { limitsAge } from "./accountRoom.ts";

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
