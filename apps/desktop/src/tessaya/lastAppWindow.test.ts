import { describe, expect, it } from "vite-plus/test";

import {
  isCompanionWindow,
  pickRevealable,
  keepRunningForTray,
  markCompanionWindow,
  setOverlaySafely,
  syncsWithT3Appearance,
  shouldQuitOnAllClosed,
} from "./lastAppWindow.ts";

describe("what ends the app", () => {
  // In this order: the tray cannot be taken away again, in a test or in the app.
  it("quits on the last window while nothing is in the tray", () => {
    expect(shouldQuitOnAllClosed()).toBe(true);
  });

  it("keeps running with no windows at all once the tray is up", () => {
    keepRunningForTray();
    expect(shouldQuitOnAllClosed()).toBe(false);
  });
});

describe("companion windows", () => {
  it("are told apart from windows he opened", () => {
    const pill = {};
    markCompanionWindow(pill);
    expect(isCompanionWindow(pill)).toBe(true);
    expect(isCompanionWindow({})).toBe(false);
  });
});

describe("which window opening the sessions reveals", () => {
  it("is T3's, never Tessaya's own, so with only Tessaya's window up a new one is made", () => {
    const baton = {};
    const t3 = {};
    const aux = {};
    markCompanionWindow(baton);
    const isAux = (w: object) => w === aux;
    expect(pickRevealable([baton], isAux)).toBeUndefined();
    expect(pickRevealable([baton, aux], isAux)).toBeUndefined();
    expect(pickRevealable([baton, aux, t3], isAux)).toBe(t3);
  });
});

describe("the title-bar overlay on theme changes", () => {
  it("skips Tessaya's own windows and never throws for a window made without an overlay", () => {
    const calls: unknown[] = [];
    const plain = { setTitleBarOverlay: (o: never) => void calls.push(o) };
    const noOverlay = {
      setTitleBarOverlay: () => {
        throw new TypeError("Titlebar overlay is not enabled");
      },
    };
    const own = { setTitleBarOverlay: (o: never) => void calls.push(o) };
    markCompanionWindow(own);
    expect(setOverlaySafely(plain, { height: 50 })).toBe(true);
    expect(setOverlaySafely(noOverlay, { height: 50 })).toBe(false);
    expect(setOverlaySafely(own, { height: 50 })).toBe(false);
    expect(syncsWithT3Appearance(own)).toBe(false);
    expect(syncsWithT3Appearance(plain)).toBe(true);
    expect(calls).toEqual([{ height: 50 }]);
  });
});
