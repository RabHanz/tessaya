import { canInjectAnywhere } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  desktopInjectionReport,
  detectDisplayServer,
  type DesktopHostEnvironment,
} from "./DesktopInjectionCapability.ts";

const host = (overrides?: Partial<DesktopHostEnvironment>): DesktopHostEnvironment => ({
  platform: "linux",
  env: { XDG_SESSION_TYPE: "wayland" },
  accessibilityPermissionGranted: false,
  applicationIntegrationConnected: false,
  keystrokeSimulationAllowed: false,
  ...overrides,
});

describe("detectDisplayServer", () => {
  it("believes the session type when the session manager sets it", () => {
    expect(detectDisplayServer({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(detectDisplayServer({ XDG_SESSION_TYPE: "x11" })).toBe("x11");
  });

  it("falls back to the sockets, because a session started by hand often has no session type", () => {
    expect(detectDisplayServer({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(detectDisplayServer({ DISPLAY: ":0" })).toBe("x11");
  });

  it("says unknown rather than guessing", () => {
    // A compositor nobody can identify is not one to send synthetic keys to.
    expect(detectDisplayServer({})).toBe("unknown");
    expect(detectDisplayServer({ XDG_SESSION_TYPE: "tty" })).toBe("unknown");
  });
});

describe("what this desktop can type into", () => {
  it("refuses global injection on Wayland, by name", () => {
    const report = desktopInjectionReport(host());
    expect(report.platform).toBe("linux");
    expect(report.displayServer).toBe("wayland");
    expect(canInjectAnywhere(report)).toBe(true); // the clipboard is still there
    const accessibility = report.capabilities.find((entry) => entry.method === "accessibility");
    expect(accessibility?.available).toBe(false);
    expect(accessibility?.reason).toContain("Wayland");
  });

  it("does not offer an integration that is not connected", () => {
    const report = desktopInjectionReport(host());
    const application = report.capabilities.find((entry) => entry.method === "application");
    expect(application?.available).toBe(false);
    expect(application?.reason).toContain("no application integration is connected");
  });

  it("offers the application path as soon as something is connected", () => {
    const report = desktopInjectionReport(host({ applicationIntegrationConnected: true }));
    expect(report.capabilities.find((entry) => entry.method === "application")?.available).toBe(
      true,
    );
  });

  it("asks the OS about accessibility rather than assuming it", () => {
    const denied = desktopInjectionReport(host({ platform: "darwin", env: {} }));
    expect(denied.capabilities.find((entry) => entry.method === "accessibility")?.available).toBe(
      false,
    );
    const granted = desktopInjectionReport(
      host({ platform: "darwin", env: {}, accessibilityPermissionGranted: true }),
    );
    expect(granted.capabilities.find((entry) => entry.method === "accessibility")?.available).toBe(
      true,
    );
    // Only Linux has a display server; saying so elsewhere would be noise.
    expect(granted.displayServer).toBeNull();
  });
});
