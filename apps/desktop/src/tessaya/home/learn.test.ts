import { describe, expect, it } from "vite-plus/test";

import { openState } from "./pageStates.ts";

describe("tips and Learn Tessaya in the window", () => {
  it("shows a tip once on the page it is about, and stops all tips when he asks", async () => {
    const page = await openState("empty");
    page.exec("learn.mode = 'all'; learn.used = []; learn.lastTipAt = null;");
    expect(page.show("snippets")).toContain("Make one");
    page.exec("render();");
    expect(page.textOf("page")).toContain("Make one");
    page.show("home");
    expect(page.show("snippets")).not.toContain("Make one");
    page.exec("learn.used = []; learn.seen = {};");
    page.show("home");
    page.show("snippets");
    const off = page
      .elements()
      .find((e) => (e as unknown as { className: string }).className === "off");
    (off as unknown as { onclick: () => void }).onclick();
    page.show("home");
    expect(page.show("transforms")).not.toContain("No more tips");
    expect(page.errors).toEqual([]);
  });
  it("lists every tip by area, ticks what he has opened, and shows what's new until he leaves the page", async () => {
    const page = await openState("empty");
    page.exec("learn.whatsNewSeen = null; learn.used = ['snippets'];");
    const text = page.show("learn");
    expect(text).toContain("What’s new");
    expect(text).toContain("✓ Say “my address”");
    page.show("home");
    expect(page.show("learn")).not.toContain("What’s new");
    expect(page.errors).toEqual([]);
  });
});
