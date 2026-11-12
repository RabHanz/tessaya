/* oxlint-disable t3code/no-wall-clock-in-tests -- Baton file predating the rule (D82) */
import { describe, expect, it } from "vite-plus/test";

import { APP_SCRIPT } from "./appScript.ts";
import { APP_CSS } from "./appStyle.ts";
import { openWindowPage } from "./fakeDom.ts";
import { HOME_DOCUMENT } from "./homeDocument.ts";
import { STATES } from "./pageStates.ts";
import { TABS, tabOf } from "./tabs.ts";

/**
 * Budgets for the window (numbers and history in docs/baton/SPEED.md). They are ceilings a little above
 * today's figures: a change that grows the page or makes a tab switch do much more work fails here.
 */
describe("the window's speed budget", () => {
  it("keeps the page small: script, stylesheet apart from fonts, and the whole document", () => {
    const cssWithoutFonts = APP_CSS.replace(/url\(data:[^)]*\)/g, "url()");
    // Each raise and what it paid for is in docs/baton/SPEED.md; 158,000 until Voice ID's guided read card.
    expect(APP_SCRIPT.length).toBeLessThan(164_000);
    expect(cssWithoutFonts.length).toBeLessThan(48_000); // 46,000 until the voice card, 45,000 until the tip card; 43,000 until History's redesign
    expect(HOME_DOCUMENT.length).toBeLessThan(438_000); // 432,000 until the voice card, 420,000 until the tips
  });

  it("draws the first page and any tab with little work", async () => {
    const state = {
      status: { label: "Listening", tone: "good", device: "", mark: "" },
      controls: STATES["empty"]!.controls.map((c) => ({ ...c, tab: tabOf(c.id) })),
    };
    const page = await openWindowPage(APP_SCRIPT, state);
    // Elements made by the first draw: the sidebar, the top bar and Home.
    expect(page.made()).toBeLessThan(300);
    const worst = { id: "", made: 0 };
    for (const { id } of TABS) {
      page.show("home");
      const before = page.made();
      page.show(id);
      const made = page.made() - before;
      if (made > worst.made) Object.assign(worst, { id, made });
    }
    // A tab switch redraws the sidebar, the top bar and one page; none may build more than this.
    expect(worst.made, `the heaviest tab was ${worst.id}`).toBeLessThan(200);
  });

  it("switches tabs quickly even in the stand-in browser", async () => {
    const page = await openWindowPage(APP_SCRIPT, {
      status: { label: "x", tone: "good", device: "", mark: "" },
      controls: STATES["empty"]!.controls.map((c) => ({ ...c, tab: tabOf(c.id) })),
    });
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) for (const { id } of TABS) page.show(id);
    const each = (performance.now() - started) / (10 * TABS.length);
    // Measured at about 1.5 ms; the ceiling is for a slow runner, not a target.
    expect(each).toBeLessThan(40);
  });
});
