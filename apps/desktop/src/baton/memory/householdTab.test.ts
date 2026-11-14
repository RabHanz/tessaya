import type { BatonHouseholdMember } from "@t3tools/tessaya-contracts";
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

const setup = (
  members: ReadonlyArray<BatonHouseholdMember>,
  hello?: { readonly account: string; readonly says: "verified" | "declined" | "unavailable" },
) => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const enrolled: Array<string> = [];
  const tab = createHouseholdTab({
    call: async (op, args) => {
      calls.push([op, args]);
      return op === "list"
        ? { status: "done", line: "", members }
        : op === "preferences"
          ? {
              status: "done",
              line: "",
              preferences: args?.["id"] === "owner" ? { units: "metric" } : {},
            }
          : {
              status: "done",
              line: `${op} done`,
              code: "ABCD2345",
              codeExpiresAt: "2026-11-14T06:00:00.000Z",
            };
    },
    enrol: (m) => enrolled.push(m.id),
    refresh: () => undefined,
    ...(hello === undefined
      ? {}
      : {
          windowsAccount: hello.account,
          hello: async () => {
            calls.push(["hello", undefined]);
            return hello.says;
          },
        }),
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

  it("edits your own preferences, and the owner anyone's; a worded one sets and clears, a name is renamed", async () => {
    const me = member({ id: "owner", name: "Owner", role: "owner", you: true });
    const t = setup([me, member({})]);
    await t.tab.load();
    const ids = () => t.tab.controls().map((c) => c.id);
    expect(ids()).toContain("m.hh.prefsFor");
    expect(t.tab.controls().find((c) => c.id === "m.hh.pref:units")).toMatchObject({
      value: "metric",
    });
    t.tab.act("m.hh.pref:name:add", "Zaid, Z-A-Y-D");
    t.tab.act("m.hh.pref:units", "");
    await t.settle();
    expect(t.calls).toContainEqual([
      "setPreference",
      { id: "owner", key: "name", value: "Zaid, Z-A-Y-D" },
    ]);
    expect(t.calls).toContainEqual(["setPreference", { id: "owner", key: "units", value: null }]);
    t.tab.act("m.hh.prefsFor", "sara-1");
    await t.settle();
    t.tab.act("m.hh.pref:music:rm", "jazz");
    t.tab.act("m.hh.rename:add", " Sarah ");
    await t.settle();
    expect(t.calls).toContainEqual(["setPreference", { id: "sara-1", key: "music", value: null }]);
    expect(t.calls).toContainEqual(["rename", { id: "sara-1", name: "Sarah" }]);
  });
  it("shows a member only their own preferences", async () => {
    const t = setup([member({ you: true }), member({ id: "owner", name: "Owner", role: "owner" })]);
    await t.tab.load();
    const ids = t.tab.controls().map((c) => c.id);
    expect(ids).not.toContain("m.hh.prefsFor");
    expect(t.calls).toContainEqual(["preferences", { id: "sara-1" }]);
  });

  it("asks Windows Hello once before what needs him, only where this account is his alone, and never for his own preferences", async () => {
    const me = member({
      id: "owner",
      name: "Owner",
      role: "owner",
      you: true,
      windowsAccount: "laptop\\rab",
    });
    const t = setup([me, member({})], { account: "laptop\\rab", says: "verified" });
    await t.tab.load();
    expect(t.tab.controls().find((c) => c.id === "m.hh.hello")).toMatchObject({ value: "owner" });
    // Hello proves him here, so no PIN row.
    expect(t.tab.controls().some((c) => c.id === "m.hh.pin")).toBe(false);
    t.tab.act("m.hh.pref:units", "metric");
    t.tab.act("m.hh.role:sara-1", "child");
    t.tab.act("m.hh.member:sara-1", null);
    await t.settle();
    const ops = t.calls.map(([op]) => op).filter((op) => op !== "list" && op !== "preferences");
    expect(ops).toEqual(["setPreference", "hello", "stepUp", "setRole", "remove"]);
    expect(t.calls).toContainEqual(["stepUp", { hello: "laptop\\rab" }]);
  });
  it("without Hello for him, offers his PIN, and an admin act just goes to the server (his phone's yes)", async () => {
    const t = setup([member({ id: "owner", name: "Owner", role: "owner", you: true })], {
      account: "laptop\\rab",
      says: "unavailable",
    });
    await t.tab.load();
    expect(t.tab.controls().some((c) => c.id === "m.hh.pin")).toBe(true);
    t.tab.act("m.hh.invite:add", "Adam");
    t.tab.act("m.hh.pin:add", "27182818");
    await t.settle();
    expect(t.calls.some(([op]) => op === "hello")).toBe(false);
    expect(t.calls).toContainEqual(["stepUp", { pin: "27182818" }]);
  });
});
