import { describe, expect, it } from "vite-plus/test";

import {
  hiddenForCapture,
  overlaysVisibleToCapture,
  protectFromCapture,
  setHideFromCapture,
  setPrivateShield,
} from "./captureProtection.ts";

const fakeWindow = (log: string[]) => ({
  setContentProtection: (on: boolean) => void log.push(`protect ${on}`),
  isDestroyed: () => false,
  isVisible: () => true,
  hide: () => void log.push("hide"),
  showInactive: () => void log.push("show"),
});

describe("overlay windows and screen capture", () => {
  it("are visible to a test run's recording only when it says where it records", () => {
    expect(overlaysVisibleToCapture({})).toBe(false);
    expect(overlaysVisibleToCapture({ BATON_TEST_DIR: "" })).toBe(false);
    expect(overlaysVisibleToCapture({ BATON_TEST_DIR: "C:\\out" })).toBe(true);
  });

  it("are not hidden from screenshots by default, follow the setting live, and are hidden only for Tessaya's own grab when it is off", async () => {
    const original = process.env["BATON_TEST_DIR"];
    delete process.env["BATON_TEST_DIR"];
    const log: string[] = [];
    protectFromCapture(fakeWindow(log));
    expect(log).toEqual(["protect false"]);
    await hiddenForCapture(async () => void log.push("grab"), "linux");
    expect(log.slice(1)).toEqual(["hide", "grab", "show"]);
    // Windows and macOS keep the window up and only exclude it from the grab.
    log.length = 0;
    await hiddenForCapture(async () => void log.push("grab"), "win32");
    expect(log).toEqual(["protect true", "grab", "protect false"]);
    log.length = 0;
    setHideFromCapture(true);
    await hiddenForCapture(async () => void log.push("grab"), "win32");
    expect(log).toEqual(["protect true", "grab"]);
    setHideFromCapture(false);
    if (original !== undefined) process.env["BATON_TEST_DIR"] = original;
  });

  it("a private session keeps every window out of capture, the app's own too, and gives each back its setting after", () => {
    const original = process.env["BATON_TEST_DIR"];
    delete process.env["BATON_TEST_DIR"];
    const overlay: string[] = [];
    const main: string[] = [];
    const overlayWin = fakeWindow(overlay);
    protectFromCapture(overlayWin);
    overlay.length = 0;
    setPrivateShield(true, [overlayWin, fakeWindow(main)]);
    expect(overlay).toEqual(["protect true"]);
    expect(main).toEqual(["protect true"]);
    setPrivateShield(false, [overlayWin, fakeWindow(main)]);
    expect(overlay.at(-1)).toBe("protect false");
    expect(main.at(-1)).toBe("protect false");
    if (original !== undefined) process.env["BATON_TEST_DIR"] = original;
  });
});
