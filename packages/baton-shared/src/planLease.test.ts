import { describe, expect, it } from "vite-plus/test";

import {
  browserProfileFor,
  leaseDecision,
  leaseProblem,
  planActs,
  type PlanLease,
} from "./planLease.ts";

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

describe("the act set a plan names", () => {
  it("reads the sites, apps and act kinds, however the labels are styled", () => {
    expect(
      planActs(
        "## What it may do\n- **Sites:** https://www.Booking.com/search, maps.google.com\n- Apps: none\n- Acts: open, read, click, type",
      ),
    ).toEqual({
      sites: ["www.booking.com", "maps.google.com"],
      apps: [],
      acts: ["open", "read", "click", "type"],
    });
  });
  it("drops the notes a plan adds after a site, an app or an act", () => {
    expect(
      planActs(
        "- Sites: github.com (read-only, on the issues pages), docs.github.com for the API\n- Apps: none. This uses no app.\n- Acts: read (pages only), scroll",
      ),
    ).toEqual({ sites: ["github.com", "docs.github.com"], apps: [], acts: ["read", "scroll"] });
  });
  it("leases nothing for a plan that names no site or app, no act kinds, or a risky act", () => {
    expect(planActs("Acts: open, read")).toBeNull();
    expect(planActs("Sites: github.com")).toBeNull();
    expect(planActs("Sites: github.com\nActs: open, submit")).toBeNull();
    expect(planActs("Sites: *.github.com\nActs: open")).toBeNull();
  });
});
