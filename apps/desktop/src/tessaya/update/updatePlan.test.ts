import { describe, expect, it } from "vite-plus/test";

import { COUNTDOWN_MS, nextStep, SNOOZE_MS, type Phase } from "./updatePlan.ts";

const idle: Phase = { kind: "idle" };
const base = { ready: true, quiet: true, now: 1_000, phase: idle, restartNow: false };

describe("when Tessaya restarts itself", () => {
  it("does nothing until an update is downloaded", () => {
    expect(nextStep({ ...base, ready: false })).toBe("none");
  });
  it("starts a countdown, and only at a quiet moment", () => {
    expect(nextStep(base)).toBe("start-countdown");
    expect(nextStep({ ...base, quiet: false })).toBe("none");
  });
  it("restarts when the countdown ends, but waits if a turn is going", () => {
    const phase: Phase = { kind: "countdown", restartAt: 1_000 + COUNTDOWN_MS };
    expect(nextStep({ ...base, phase, now: 1_000 + COUNTDOWN_MS - 1 })).toBe("none");
    expect(nextStep({ ...base, phase, now: 1_000 + COUNTDOWN_MS })).toBe("install");
    expect(nextStep({ ...base, phase, now: 1_000 + COUNTDOWN_MS, quiet: false })).toBe(
      "wait-for-quiet",
    );
  });
  it("Later puts it off, then asks again", () => {
    const phase: Phase = { kind: "snoozed", until: 1_000 + SNOOZE_MS };
    expect(nextStep({ ...base, phase, now: 2_000 })).toBe("none");
    expect(nextStep({ ...base, phase, now: 1_000 + SNOOZE_MS })).toBe("start-countdown");
  });
  it("Restart now skips the countdown but never interrupts a turn", () => {
    expect(nextStep({ ...base, restartNow: true })).toBe("install");
    expect(nextStep({ ...base, restartNow: true, quiet: false })).toBe("wait-for-quiet");
  });
});
