import { describe, expect, it } from "vite-plus/test";

import { EMERGENCY_MIN_GAP_MS, emergencyRateOk, emergencyRefusal } from "./commsEmergency.ts";

const kind = (who: "any" | "adults" | "owner", automations = false) => ({
  id: "fire",
  label: "Fire",
  text: "Fire: get out now",
  who,
  children: true,
  automations,
});

describe("emergencyRefusal", () => {
  it.each([
    ["any", "child", false, null],
    ["any", "guest", false, "Only members of this home can do that."],
    ["adults", "adult", false, null],
    ["adults", "child", false, "A grown-up sets off Fire; I'll tell your parents you need them."],
    ["owner", "adult", false, "Only the owner sets off Fire."],
    ["owner", "admin", false, null],
  ] as const)("%s, by a %s", (who, role, service, why) => {
    expect(emergencyRefusal(kind(who), { role, service })).toBe(why);
  });

  it("lets an automation set off only a kind the owner opened to automations", () => {
    expect(emergencyRefusal(kind("owner"), { role: "owner", service: true })).toBe(
      "Fire can't be set off by an automation.",
    );
    expect(emergencyRefusal(kind("owner", true), { role: "owner", service: true })).toBeNull();
  });
});

describe("emergencyRateOk", () => {
  it("allows one trigger of a kind per gap", () => {
    expect(emergencyRateOk(null, 0)).toBe(true);
    expect(emergencyRateOk(1_000, 1_000 + EMERGENCY_MIN_GAP_MS - 1)).toBe(false);
    expect(emergencyRateOk(1_000, 1_000 + EMERGENCY_MIN_GAP_MS)).toBe(true);
  });
});
