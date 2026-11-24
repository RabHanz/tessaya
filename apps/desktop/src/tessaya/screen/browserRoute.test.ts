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
  bridgeOn: true,
  bridge: { state: "ready", message: "The shared browser bridge answers." },
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
    ).toBe("bridge");
  });

  it("uses the shared Playwright bridge when it is on and answering, never the Claude in Chrome extension", () => {
    const choice = chooseBrowserRoute(base);
    expect(choice.route).toBe("bridge");
    expect(choice.steps.join(" ")).toContain("web_snapshot");
    expect(JSON.stringify(choice)).not.toMatch(/claude in chrome|extension/i);
    // The bridge drives its own window, so whether a Chrome window is on screen does not matter.
    expect(chooseBrowserRoute({ ...base, chromeVisible: false }).route).toBe("bridge");
  });

  it("falls back with a reason when the bridge is off or not answering", () => {
    const off = chooseBrowserRoute({ ...base, bridgeOn: false, accessibility: "on" });
    expect(off).toMatchObject({ route: "uia" });
    expect(off.why).toContain("browser bridge is off");
    const gone = chooseBrowserRoute({
      ...base,
      bridge: { state: "not-connected", message: "The browser bridge is not answering." },
      accessibility: "on",
    });
    expect(gone.route).toBe("uia");
    expect(gone.why).toContain("not answering");
  });

  it("asks before restarting Chrome for accessibility, reads pixels meanwhile, and uses the controls once restarted", () => {
    const off = { ...base, bridgeOn: false, accessibility: "off" as const };
    expect(chooseBrowserRoute(off)).toMatchObject({
      route: "pixels",
      needsApproval: "relaunch-accessibility",
    });
    expect(chooseBrowserRoute({ ...off, relaunchApproved: true }).route).toBe("uia");
  });

  it("says plainly when there is no window to work in, and reads pixels when nothing is known", () => {
    expect(chooseBrowserRoute({ ...base, bridgeOn: false, chromeVisible: false })).toMatchObject({
      route: "none",
    });
    expect(chooseBrowserRoute({ ...base, bridgeOn: false }).route).toBe("pixels");
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
