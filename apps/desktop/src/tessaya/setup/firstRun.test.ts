import { describe, expect, it } from "vite-plus/test";

import { meterWidth, resumeStep, SETUP_STEPS, setupHoldControl, setupMode } from "./firstRun.ts";

describe("first-run guide", () => {
  it("gets a newcomer to a first success and leaves the rest to tips", () => {
    expect(SETUP_STEPS.map((s) => s.id)).toEqual(["welcome", "mic", "key", "try", "assistant"]);
    // Every fact has words: a missing string would show its key.
    for (const step of SETUP_STEPS)
      for (const f of step.facts ?? []) {
        expect(f.label).not.toMatch(/^setup\./);
        expect(f.hint).not.toMatch(/^setup\./);
      }
  });
  it("opens on a fresh install, is offered once to an existing one, and never comes back by itself", () => {
    expect(setupMode({ freshInstall: true })).toBe("open");
    expect(setupMode({ freshInstall: true, done: true })).toBe("none");
    // An install from before the tour: one card on Home.
    expect(setupMode({ freshInstall: false })).toBe("offer");
    expect(setupMode({ freshInstall: false, offered: true })).toBe("none");
    expect(setupMode({ freshInstall: false, done: true })).toBe("none");
  });
  it("reopens on the step it was left on, kept inside the tour", () => {
    const n = SETUP_STEPS.length;
    expect(resumeStep({ freshInstall: true }, n)).toBe(0);
    expect(resumeStep({ freshInstall: true, step: 4 }, n)).toBe(4);
    expect(resumeStep({ freshInstall: false, step: 99 }, n)).toBe(n - 1);
    expect(resumeStep({ freshInstall: false, step: -2 }, n)).toBe(0);
    expect(resumeStep({ freshInstall: false, step: 4, done: true }, n)).toBe(0);
  });
  it("keeps a key he set himself in the list instead of hiding it", () => {
    const c = setupHoldControl("Ctrl+F12");
    expect(c.kind === "choice" && c.options[0]).toEqual({
      value: "",
      label: "Ctrl+F12 (your own)",
    });
    const d = setupHoldControl("F9");
    expect(d.kind === "choice" && d.value).toBe("F9");
  });
  it("moves the meter for quiet speech and stops at full", () => {
    expect(meterWidth(0)).toBe(0);
    expect(meterWidth(0.01)).toBeGreaterThan(10);
    expect(meterWidth(5)).toBe(100);
  });
});
