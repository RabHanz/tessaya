import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TAB_ORDER,
  navigationCustomizationAvailable,
  moveNavigationTab,
  overflowNavigationTabs,
  enabledNavigationTabs,
  toggleNavigationTabVisibility,
  resolveSelectedNavigationTab,
  resolveNavigationTabOrder,
  selectedNavigationTab,
  visibleNavigationTabs,
} from "./navigation-tab-order";

describe("navigation tab order", () => {
  it("enables customization only above four registered sections, excluding Settings", () => {
    // Tessaya registers six sections (D-038), so its bar is customizable and the last two sit under More
    expect(navigationCustomizationAvailable()).toBe(true);
    expect(navigationCustomizationAvailable(3)).toBe(false);
    expect(navigationCustomizationAvailable(4)).toBe(false);
    expect(navigationCustomizationAvailable(5)).toBe(true);
    expect(navigationCustomizationAvailable(6)).toBe(true);
  });

  it("fills missing sections and drops removed placeholders, duplicates, and Settings", () => {
    expect(
      resolveNavigationTabOrder(["usage", "home", "issues", "settings", "usage", null]),
    ).toEqual(["usage", "talk", "threads", "personas", "devices", "pullRequests"]);
    expect(resolveNavigationTabOrder()).toEqual(NAVIGATION_TAB_ORDER);
  });

  it("moves a section without changing the relative order of the others", () => {
    for (const tab of NAVIGATION_TAB_ORDER) {
      for (let position = 0; position < NAVIGATION_TAB_ORDER.length; position++) {
        const order = moveNavigationTab(NAVIGATION_TAB_ORDER, tab, position);
        expect(order[position]).toBe(tab);
        expect(order.filter((other) => other !== tab)).toEqual(
          NAVIGATION_TAB_ORDER.filter((other) => other !== tab),
        );
      }
    }
  });

  it("shows every real section without overflow and keeps Settings selected during editing", () => {
    expect(visibleNavigationTabs()).toEqual(["talk", "threads", "personas", "devices"]);
    expect(overflowNavigationTabs()).toEqual(["pullRequests", "usage"]);
    expect(selectedNavigationTab(undefined, "threads", true)).toBe("settings");
    expect(selectedNavigationTab(undefined, "threads", false)).toBe("threads");
    expect(selectedNavigationTab(undefined, "usage", false)).toBe("settings");
    expect(selectedNavigationTab(undefined, "usage", false, [], 2)).toBe("settings");
  });

  it("removes hidden sections from navigation and restores their saved positions", () => {
    const order = moveNavigationTab(undefined, "usage", 0);
    const hidden = toggleNavigationTabVisibility([], "usage");
    expect(enabledNavigationTabs(order, hidden)).toEqual([
      "talk",
      "threads",
      "personas",
      "devices",
      "pullRequests",
    ]);
    expect(toggleNavigationTabVisibility(hidden, "usage")).toEqual([]);
    expect(visibleNavigationTabs(order, [], 6)).toEqual(order);
    expect(enabledNavigationTabs(undefined, ["home", "issues", "settings"])).toEqual(
      NAVIGATION_TAB_ORDER,
    );
  });

  it("falls back when the selected section is hidden, including when all are hidden", () => {
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "threads")).toBe("talk");
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "usage")).toBe("usage");
    expect(
      resolveSelectedNavigationTab(undefined, NAVIGATION_TAB_ORDER, "threads"),
    ).toBeUndefined();
  });
});
