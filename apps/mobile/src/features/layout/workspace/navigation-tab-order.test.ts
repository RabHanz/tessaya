import { describe, expect, it } from "vite-plus/test";
import { setTessayaApp, TESSAYA_TAB_ORDER } from "../../tessaya/tessayaTabs";
import { initialWorkspaceTabsState } from "./workspace-tabs-state";
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
    expect(navigationCustomizationAvailable()).toBe(false);
    expect(navigationCustomizationAvailable(3)).toBe(false);
    expect(navigationCustomizationAvailable(4)).toBe(false);
    expect(navigationCustomizationAvailable(5)).toBe(true);
    expect(navigationCustomizationAvailable(6)).toBe(true);
  });

  it("fills missing sections and drops removed placeholders, duplicates, and Settings", () => {
    expect(
      resolveNavigationTabOrder(["usage", "home", "issues", "settings", "usage", null]),
    ).toEqual(["usage", "threads", "pullRequests"]);
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
    expect(visibleNavigationTabs()).toEqual(NAVIGATION_TAB_ORDER);
    expect(overflowNavigationTabs()).toEqual([]);
    expect(selectedNavigationTab(undefined, "threads", true)).toBe("settings");
    expect(selectedNavigationTab(undefined, "usage", false)).toBe("usage");
    expect(selectedNavigationTab(undefined, "usage", false, [], 2)).toBe("settings");
  });

  it("removes hidden sections from navigation and restores their saved positions", () => {
    const order = moveNavigationTab(undefined, "usage", 0);
    const hidden = toggleNavigationTabVisibility([], "usage");
    expect(enabledNavigationTabs(order, hidden)).toEqual(["threads", "pullRequests"]);
    expect(toggleNavigationTabVisibility(hidden, "usage")).toEqual([]);
    expect(visibleNavigationTabs(order, [], 5)).toEqual(order);
    expect(enabledNavigationTabs(undefined, ["home", "issues", "settings"])).toEqual(
      NAVIGATION_TAB_ORDER,
    );
  });

  it("falls back when the selected section is hidden, including when all are hidden", () => {
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "threads")).toBe("pullRequests");
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "usage")).toBe("usage");
    expect(
      resolveSelectedNavigationTab(undefined, NAVIGATION_TAB_ORDER, "threads"),
    ).toBeUndefined();
  });
});

describe("Tessaya's phone app", () => {
  it("puts Today, Sessions and Devices in the bar, Pulls and Usage under You, whatever was saved", () => {
    setTessayaApp(true);
    try {
      expect(resolveNavigationTabOrder(["usage", "threads"])).toEqual(TESSAYA_TAB_ORDER);
      expect(visibleNavigationTabs(["usage"], [], 4)).toEqual(["today", "threads", "devices"]);
      expect(overflowNavigationTabs(undefined, [])).toEqual(["pullRequests", "usage"]);
      expect(selectedNavigationTab(undefined, "pullRequests", false, [], 4)).toBe("settings");
      expect(initialWorkspaceTabsState().selectedTab).toBe("today");
    } finally {
      setTessayaApp(false);
    }
    expect(initialWorkspaceTabsState().selectedTab).toBe("threads");
  });
});
