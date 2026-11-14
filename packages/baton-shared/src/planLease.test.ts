import { describe, expect, it } from "vite-plus/test";

import { browserProfileFor, leaseDecision, leaseProblem, type PlanLease } from "./planLease.ts";

const lease: PlanLease = {
  job: "j1",
  persona: "butler",
  sites: ["booking.com"],
  apps: [],
  acts: ["open", "click", "type", "read"],
  until: 100,
};
const act = (over = {}) => ({
  persona: "butler",
  job: "j1",
  kind: "click",
  site: "secure.booking.com",
  ...over,
});

describe("a plan lease for computer use", () => {
  it("runs acts inside the plan, asks outside it, and always asks for a risky act", () => {
    expect(leaseDecision(act(), [lease], 0)).toBe("run");
    expect(leaseDecision(act({ site: "notbooking.com" }), [lease], 0)).toBe("ask");
    expect(leaseDecision(act({ kind: "scroll" }), [lease], 0)).toBe("ask");
    expect(leaseDecision(act({ persona: "engineering" }), [lease], 0)).toBe("ask");
    expect(leaseDecision(act({ job: null }), [lease], 0)).toBe("ask");
    expect(leaseDecision(act(), [lease], 100)).toBe("ask");
    expect(leaseDecision(act({ kind: "pay" }), [lease], 0)).toBe("ask-risky");
    // An act that names no site or app is never covered: the set must be concrete.
    expect(leaseDecision({ persona: "butler", job: "j1", kind: "click" }, [lease], 0)).toBe("ask");
  });
  it("refuses a lease that is not concrete or that leases a risky act", () => {
    expect(leaseProblem({ ...lease, sites: [] })).not.toBeNull();
    expect(leaseProblem({ ...lease, sites: ["*.com"] })).not.toBeNull();
    expect(leaseProblem({ ...lease, acts: ["click", "pay"] })).not.toBeNull();
    expect(leaseProblem(lease)).toBeNull();
  });
  it("keeps research out of his logged-in browser", () => {
    expect(browserProfileFor("research")).toBe("research");
    expect(browserProfileFor("as-him")).toBe("his");
  });
});
