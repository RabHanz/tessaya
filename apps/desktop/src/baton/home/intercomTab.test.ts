// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { createIntercomTab, dndUntil, kindOf } from "./intercomTab.ts";

describe("intercom helpers", () => {
  it("turns a do-not-disturb choice into its end", () => {
    const now = new Date(2026, 10, 14, 22, 30);
    expect(dndUntil("1h", now)).toBe(new Date(2026, 10, 14, 23, 30).toISOString());
    expect(dndUntil("morning", now)).toBe(new Date(2026, 10, 15, 7, 0).toISOString());
    expect(dndUntil("morning", new Date(2026, 10, 14, 5, 0))).toBe(
      new Date(2026, 10, 14, 7, 0).toISOString(),
    );
    expect(dndUntil("", now)).toBeNull();
  });

  it("reads an emergency from one typed line, or nothing", () => {
    expect(kindOf("Fire: get out now", "adults")).toEqual({
      id: "fire",
      label: "Fire",
      text: "get out now",
      who: "adults",
      children: true,
      automations: false,
    });
    expect(kindOf("Fire", "any")).toBeNull();
    expect(kindOf(": nothing", "any")).toBeNull();
  });
});

describe("createIntercomTab", () => {
  it("asks the server for each change, as the server's own ops", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const tab = createIntercomTab({
      call: async (op, args) => {
        calls.push([op, args]);
        return {
          status: "done",
          line: "",
          settings: { enabled: false, quietHours: null, dndUntil: null },
        };
      },
      members: async () => [
        { id: "owner", name: "Omid", role: "owner", state: "active", you: true } as never,
        { id: "sara", name: "Sara", role: "adult", state: "active", you: false } as never,
      ],
      refresh: () => undefined,
    });
    await tab.load();
    expect(tab.controls().map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "ic.enabled",
        "ic.quiet",
        "ic.dnd",
        "ic.consent:sara",
        "ic.kinds",
        "ic.who",
      ]),
    );
    calls.length = 0;
    tab.act("ic.enabled", true);
    tab.act("ic.consent:sara", "allow");
    tab.act("ic.kinds:add", "Fire: get out now");
    tab.act("ic.alarm:later", undefined);
    await tab.settled();
    const ops = calls.map(([op]) => op);
    expect(calls.find(([op]) => op === "consentSet")?.[1]).toEqual({
      target: "person:owner",
      caller: "sara",
      state: "allow",
    });
    expect(calls.find(([op, a]) => op === "settings" && a !== undefined)?.[1]).toEqual({
      enabled: true,
    });
    expect(calls.find(([op, a]) => op === "emergencyKinds" && a !== undefined)?.[1]).toMatchObject({
      kinds: [{ id: "fire", text: "get out now" }],
    });
    expect(ops).toContain("emergencyCancel");
  });
});
