import { describe, expect, it } from "vite-plus/test";

import { startedAtHome, useBatonPanesStore } from "./batonPanesStore";

describe("pane restore", () => {
  it("is decided by the page the window opened on", () => {
    expect(startedAtHome("")).toBe(true);
    expect(startedAtHome("#/")).toBe(true);
    expect(startedAtHome("#/box/thread")).toBe(false);
    expect(startedAtHome("#/pair")).toBe(false);
  });

  it("is dropped once any page but home shows, so a later visit home starts fresh", () => {
    // Off the desktop app nothing resumes: web tabs share one layout.
    expect(useBatonPanesStore.getState().restorePending).toBe(false);
    useBatonPanesStore.setState({ restorePending: true });
    useBatonPanesStore.getState().noteLocation("/");
    expect(useBatonPanesStore.getState().restorePending).toBe(true);
    for (const pathname of ["/box/thread", "/pair", "/connect", "/welcome"]) {
      useBatonPanesStore.setState({ restorePending: true });
      useBatonPanesStore.getState().noteLocation(pathname);
      expect(useBatonPanesStore.getState().restorePending).toBe(false);
    }
  });
});
