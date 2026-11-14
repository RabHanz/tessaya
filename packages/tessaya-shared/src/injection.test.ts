import {
  canInjectAnywhere,
  describeInjection,
  type BatonFocusTarget,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseInjectionAdapter,
  describeInjectionCapabilities,
  describeInjectionRefusal,
  type InjectionHostFacts,
  type TextInjectionAdapter,
} from "./injection.ts";

const target: BatonFocusTarget = {
  producer: "browser",
  kind: "editable",
  label: "Gmail compose",
  injectable: true,
  origin: "https://mail.google.com",
};

const adapter = (method: TextInjectionAdapter["method"], can = true): TextInjectionAdapter => ({
  method,
  canInject: () => can,
  insertText: () => Promise.resolve(),
});

const facts = (overrides?: Partial<InjectionHostFacts>): InjectionHostFacts => ({
  platform: "linux",
  displayServer: "wayland",
  applicationIntegrationConnected: false,
  accessibilityPermissionGranted: false,
  clipboardAvailable: false,
  keystrokeSimulationAllowed: false,
  ...overrides,
});

describe("choosing an adapter", () => {
  it("follows §18's order, not the order the adapters were registered in", () => {
    const chosen = chooseInjectionAdapter(
      [adapter("keystrokes"), adapter("clipboard"), adapter("application")],
      target,
    );
    expect(chosen?.method).toBe("application");
  });

  it("skips a preferred adapter that cannot take this target", () => {
    const chosen = chooseInjectionAdapter(
      [adapter("application", false), adapter("accessibility")],
      target,
    );
    expect(chosen?.method).toBe("accessibility");
  });

  it("returns nothing rather than the least-bad option when none can", () => {
    expect(chooseInjectionAdapter([adapter("application", false)], target)).toBeNull();
  });
});

describe("reporting what this machine can actually do", () => {
  it("refuses Wayland by name, and says what to use instead", () => {
    // The specification's own instruction: never pretend arbitrary global
    // injection is universally available. This box runs Wayland.
    const report = describeInjectionCapabilities(facts());
    expect(canInjectAnywhere(report)).toBe(false);
    const accessibility = report.capabilities.find((entry) => entry.method === "accessibility");
    expect(accessibility?.available).toBe(false);
    expect(accessibility?.reason).toContain(
      "Wayland does not let one application type into another",
    );
    const keystrokes = report.capabilities.find((entry) => entry.method === "keystrokes");
    expect(keystrokes?.available).toBe(false);
    expect(keystrokes?.reason).toContain("Wayland");
    expect(describeInjectionRefusal(report)).toContain("I cannot type that in:");
  });

  it("allows an application integration even where the OS forbids global injection", () => {
    // The browser extension types into its own page; the compositor has no
    // opinion about that. This is why §18 puts application integration first.
    const report = describeInjectionCapabilities(facts({ applicationIntegrationConnected: true }));
    expect(canInjectAnywhere(report)).toBe(true);
    expect(describeInjection(report)).toContain("application");
  });

  it("allows accessibility on X11 once permission is granted, and not before", () => {
    expect(
      describeInjectionCapabilities(facts({ displayServer: "x11" })).capabilities.find(
        (entry) => entry.method === "accessibility",
      )?.available,
    ).toBe(false);
    expect(
      describeInjectionCapabilities(
        facts({ displayServer: "x11", accessibilityPermissionGranted: true }),
      ).capabilities.find((entry) => entry.method === "accessibility")?.available,
    ).toBe(true);
  });

  it("names the missing macOS permission rather than failing quietly", () => {
    const report = describeInjectionCapabilities(
      facts({ platform: "darwin", displayServer: null }),
    );
    const accessibility = report.capabilities.find((entry) => entry.method === "accessibility");
    expect(accessibility?.reason).toContain("Accessibility permission");
  });

  it("keeps simulated keystrokes off until they are explicitly allowed", () => {
    // §18 puts them last: synthetic keys land wherever focus is when they
    // arrive, which on a busy machine is not where it was.
    const off = describeInjectionCapabilities(facts({ platform: "win32", displayServer: null }));
    expect(off.capabilities.find((entry) => entry.method === "keystrokes")?.available).toBe(false);
    const on = describeInjectionCapabilities(
      facts({ platform: "win32", displayServer: null, keystrokeSimulationAllowed: true }),
    );
    expect(on.capabilities.find((entry) => entry.method === "keystrokes")?.available).toBe(true);
  });

  it("gives every unavailable method a reason, on every platform", () => {
    // "Surface capability must be reported honestly" is only met if the
    // refusal says something a person can act on.
    for (const platform of ["darwin", "win32", "linux", "unknown"] as const) {
      const report = describeInjectionCapabilities(
        facts({ platform, displayServer: platform === "linux" ? "wayland" : null }),
      );
      for (const capability of report.capabilities) {
        if (!capability.available) expect(capability.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
