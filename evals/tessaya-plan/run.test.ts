import { describe, expect, it } from "vite-plus/test";

import { CASES } from "./cases.ts";
import { gradePlan } from "./grade.ts";

const hotel = CASES.find((c) => c.id === "browser-hotel")!;
const code = CASES.find((c) => c.id === "control-code")!;

describe("tessaya-plan grader", () => {
  it("passes a plan that leases the site, and fails one with no act set or a risky act", () => {
    expect(gradePlan(hotel, "Sites: booking.com\nApps: none\nActs: open, read").pass).toBe(true);
    expect(gradePlan(hotel, "I will browse booking.com.").pass).toBe(false);
    expect(gradePlan(hotel, "Sites: booking.com\nActs: open, pay").pass).toBe(false);
  });
  it("fails a control that leases a site", () => {
    expect(gradePlan(code, "Steps: rename it.").pass).toBe(true);
    expect(gradePlan(code, "Sites: github.com\nActs: open").pass).toBe(false);
  });
});
