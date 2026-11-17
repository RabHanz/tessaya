import { describe, expect, it } from "vite-plus/test";

import { forgottenRow, purgeTap } from "./recentlyForgotten.ts";

describe("Recently forgotten rows", () => {
  const at = "2026-11-10T09:00:00.000Z";

  it("names a person, or a fact under whose it was, without the list dash, and who forgot it", () => {
    expect(forgottenRow({ id: "p", name: "Ali", by: "owner", at }).label).toBe("Ali");
    expect(forgottenRow({ id: "p", name: null, by: "expiry", at }).hint).toMatch(
      /^Forgotten on .+: no one saved them$/,
    );
    const fact = forgottenRow({ id: "f", name: "Sara", by: "member", at, fact: "- likes tea" });
    expect(fact.label).toBe("Sara: likes tea");
    expect(fact.hint).toMatch(/^Forgot themselves on /);
    expect(forgottenRow({ id: "f", name: null, by: "owner", at, fact: "x" }).label).toBe(
      "Someone: x",
    );
  });

  it("deletes for good only on a second tap of the same row", () => {
    expect(purgeTap(null, "p")).toEqual({ confirm: "p" });
    expect(purgeTap("all", "p")).toEqual({ confirm: "p" });
    expect(purgeTap("p", "p")).toEqual({
      send: { op: "peopleManage", action: "purge", id: "p" },
    });
    expect(purgeTap("p")).toEqual({ confirm: "all" });
    expect(purgeTap("all")).toEqual({ send: { op: "peopleManage", action: "purge" } });
  });
});
