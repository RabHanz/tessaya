import { describe, expect, it, vi } from "vite-plus/test";

import {
  accessibilityLooksOff,
  chooseBrowserRoute,
  relaunchChromeWithAccessibility,
  withCallRetry,
  type RouteInput,
} from "./browserRoute.ts";

const base: RouteInput = {
  task: "act",
  needsLogin: true,
  ownChromeOn: true,
  chrome: { state: "ready", message: "Chrome is connected." },
  chromeVisible: true,
  accessibility: "unknown",
  relaunchApproved: false,
};

describe("chooseBrowserRoute", () => {
  it("reads a public page with a plain fetch", () => {
    expect(
      chooseBrowserRoute({ ...base, task: "read", needsLogin: false, url: "https://example.test" })
        .route,
    ).toBe("fetch");
    expect(
      chooseBrowserRoute({ ...base, task: "read", needsLogin: true, url: "https://example.test" })
        .route,
    ).toBe("chrome");
  });

  it("uses his Chrome when it is on and connected, bringing a hidden tab forward first", () => {
    expect(chooseBrowserRoute(base).steps).toEqual(["call with a 10 second limit and one retry"]);
    const hidden = chooseBrowserRoute({ ...base, chromeVisible: null });
    expect(hidden.route).toBe("chrome");
    expect(hidden.steps[0]).toContain("bring");
  });

  it("falls back with a reason when his Chrome is off, missing or not connected", () => {
    const off = chooseBrowserRoute({ ...base, ownChromeOn: false, accessibility: "on" });
    expect(off).toMatchObject({ route: "uia" });
    expect(off.why).toContain("own Chrome is off");
    const gone = chooseBrowserRoute({
      ...base,
      chrome: {
        state: "not-connected",
        message: "The Chrome extension is installed but not connected.",
      },
      accessibility: "on",
    });
    expect(gone.why).toContain("not connected");
  });

  it("asks before restarting Chrome for accessibility, reads pixels meanwhile, and uses the controls once restarted", () => {
    const off = { ...base, ownChromeOn: false, accessibility: "off" as const };
    expect(chooseBrowserRoute(off)).toMatchObject({
      route: "pixels",
      needsApproval: "relaunch-accessibility",
    });
    expect(chooseBrowserRoute({ ...off, relaunchApproved: true }).route).toBe("uia");
  });

  it("says plainly when there is no window to work in, and reads pixels when nothing is known", () => {
    expect(chooseBrowserRoute({ ...base, ownChromeOn: false, chromeVisible: false })).toMatchObject(
      { route: "none" },
    );
    expect(chooseBrowserRoute({ ...base, ownChromeOn: false }).route).toBe("pixels");
  });
});

describe("accessibilityLooksOff", () => {
  it("tells a bare frame from a real page", () => {
    expect(accessibilityLooksOff("window Google Chrome\npane\n")).toBe(true);
    const page = Array.from({ length: 12 }, (_, i) => `link Item ${i}`).join("\n");
    expect(accessibilityLooksOff(page)).toBe(false);
  });
});

describe("withCallRetry", () => {
  it("retries once after a timeout, then gives a reason", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const ok = withCallRetry(
      () => (++calls === 1 ? new Promise<string>(() => undefined) : Promise.resolve("done")),
      { label: "Chrome" },
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await ok).toEqual({ ok: true, value: "done" });
    const bad = withCallRetry(() => new Promise<string>(() => undefined), { label: "Chrome" });
    await vi.advanceTimersByTimeAsync(20_100);
    expect(await bad).toEqual({
      ok: false,
      why: "Chrome did not answer in 10 seconds, even after trying again.",
    });
    vi.useRealTimers();
  });
});

describe("relaunchChromeWithAccessibility", () => {
  it("closes politely and starts with the flag", async () => {
    const ran: string[] = [];
    const out = await relaunchChromeWithAccessibility({
      platform: "win32",
      run: async (c, a) => void ran.push(`${c} ${a.join(" ")}`),
      wait: async () => undefined,
    });
    expect(ran[0]).toBe("taskkill /IM chrome.exe");
    expect(ran[1]).toContain("--force-renderer-accessibility");
    expect(out).toContain("tabs come back");
    expect(
      await relaunchChromeWithAccessibility({
        platform: "linux",
        run: async () => undefined,
        wait: async () => undefined,
      }),
    ).toContain("not supported");
    expect(
      await relaunchChromeWithAccessibility({
        platform: "win32",
        run: async () => Promise.reject(new Error("x")),
        wait: async () => undefined,
      }),
    ).toContain("could not be restarted");
  });
});
