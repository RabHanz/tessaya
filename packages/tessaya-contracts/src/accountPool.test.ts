import { describe, expect, it } from "vite-plus/test";

import {
  setClaudeAccountInstances,
  accountForInstance,
  accountRefusal,
  accountReturnsAt,
} from "./accountPool.ts";

const spent = {
  label: "Optima",
  unusableReason: null,
  headroomPercent: 0,
  windows: [
    { id: "five_hour", label: "5h", usedPercent: 0, resetsAt: null },
    {
      id: "seven_day",
      label: "7d",
      usedPercent: 100,
      resetsAt: "2026-11-02T13:00:00.000Z",
    },
  ],
} as const;

setClaudeAccountInstances({
  claudeAgent_robin: "4",
  claudeAgent_optima: "5",
  claudeAgent_sablebox: "6",
});

describe("accountRefusal", () => {
  it("names when a spent account returns", () => {
    expect(accountReturnsAt(spent)).toBe("2026-11-02T13:00:00.000Z");
    expect(accountRefusal(spent)).toBe("Optima has no quota left until 2026-11-02 13:00 UTC");
  });

  it("refuses a signed-out account and lets an unread or roomy one through", () => {
    expect(accountRefusal({ ...spent, unusableReason: "signed-out" })).toBe("Optima is signed out");
    expect(accountRefusal({ ...spent, headroomPercent: 40 })).toBeNull();
    expect(accountRefusal({ ...spent, headroomPercent: null })).toBeNull();
  });
});

describe("instance and account mapping", () => {
  it("reads a pinned instance's account, and the active one for the default", () => {
    const accounts = [
      { key: "4", active: true },
      { key: "6", active: false },
    ];
    expect(accountForInstance("claudeAgent_sablebox", accounts)?.key).toBe("6");
    expect(accountForInstance("claudeAgent", accounts)?.key).toBe("4");
    // A token instance with no slot is unknown, never the active login (it would borrow its limits).
    expect(accountForInstance("claudeAgent_unmapped", accounts)).toBeUndefined();
  });
});
