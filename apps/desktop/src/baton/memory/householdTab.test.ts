import type { BatonHouseholdMember } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { createHouseholdTab } from "./householdTab.ts";

const member = (over: Partial<BatonHouseholdMember>): BatonHouseholdMember => ({
  id: "sara-1",
  name: "Sara",
  role: "adult",
  state: "active",
  machine: false,
  guardians: [],
  adultAge: null,
  born: null,
  devices: 1,
  connected: false,
  inviteCode: null,
  inviteExpiresAt: null,
  purgeAfter: null,
  you: false,
  ...over,
});

const setup = (members: ReadonlyArray<BatonHouseholdMember>) => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const enrolled: Array<string> = [];
  const tab = createHouseholdTab({
    call: async (op, args) => {
      calls.push([op, args]);
      return op === "list"
        ? { status: "done", line: "", members }
        : {
            status: "done",
            line: `${op} done`,
            code: "ABCD2345",
            codeExpiresAt: "2026-11-14T06:00:00.000Z",
          };
    },
    enrol: (m) => enrolled.push(m.id),
    refresh: () => undefined,
  });
  return { tab, calls, enrolled, settle: () => tab.settled() };
};

describe("the Household area", () => {
  it("adds someone with the chosen role and shows their code, and enrols a member's voice under their id", async () => {
    const t = setup([member({})]);
    await t.tab.load();
    t.tab.act("m.hh.inviteRole", "child");
    t.tab.act("m.hh.invite:add", " Adam ");
    await t.settle();
    expect(t.calls).toContainEqual(["invite", { name: "Adam", role: "child" }]);
    expect(t.tab.controls().find((c) => c.id === "m.hh.code")?.label).toContain("ABCD2345");
    t.tab.act("m.hh.member:sara-1:later", null);
    expect(t.enrolled).toEqual(["sara-1"]);
  });

  it("destroys a leaving member's data only on a second click of Remove now", async () => {
    const t = setup([member({ state: "leaving", purgeAfter: "2026-11-20T06:00:00.000Z" })]);
    await t.tab.load();
    t.tab.act("m.hh.leaving:sara-1:later", null);
    await t.settle();
    expect(t.calls.some(([op]) => op === "remove")).toBe(false);
    t.tab.act("m.hh.leaving:sara-1:later", null);
    await t.settle();
    expect(t.calls).toContainEqual(["remove", { id: "sara-1", now: true }]);
  });
});
