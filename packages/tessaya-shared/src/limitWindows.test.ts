import { describe, expect, it } from "vite-plus/test";

import { absentSessionWindow } from "./limitWindows.ts";

const session = { id: "five_hour", kind: "session" };
const weekly = { id: "seven_day", kind: "weekly" };

describe("a limit window an account does not have", () => {
  it("is noticed when only the weekly window is reported", () => {
    expect(absentSessionWindow([weekly])).toBe(true);
  });

  it("goes away by itself when the session window returns", () => {
    expect(absentSessionWindow([session, weekly])).toBe(false);
  });

  it("says nothing with no reading at all, or for providers without a weekly window", () => {
    expect(absentSessionWindow([])).toBe(false);
    expect(absentSessionWindow([{ id: "monthly", kind: "monthly" }])).toBe(false);
  });
});
