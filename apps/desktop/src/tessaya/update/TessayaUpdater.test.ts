import type { DesktopUpdateState } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createTessayaUpdater } from "./TessayaUpdater.ts";
import { COUNTDOWN_MS } from "./updatePlan.ts";

const state = (downloadedVersion: string | null): DesktopUpdateState => ({
  enabled: true,
  status: downloadedVersion === null ? "up-to-date" : "downloaded",
  channel: "latest",
  currentVersion: "0.1.4",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: downloadedVersion,
  downloadedVersion,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
});

const make = (initial: DesktopUpdateState, inFlight: () => string | null = () => null) => {
  const headsUp = vi.fn();
  const install = vi.fn(async () => undefined);
  const updater = createTessayaUpdater({
    initial,
    check: async () => undefined,
    download: async () => undefined,
    install,
    busy: () => ({ voiceBusy: false, assistantBusy: false, inFlight: inFlight() }),
    headsUp,
    backAfter: null,
    onChange: () => undefined,
  });
  return { updater, headsUp, install };
};

describe("the update restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not remember Restart now when nothing is downloaded, so a later download still warns first", () => {
    const { updater, headsUp, install } = make(state(null));
    updater.install();
    updater.onState(state("0.1.5"));
    expect(install).not.toHaveBeenCalled();
    expect(headsUp).toHaveBeenCalledTimes(1);
  });

  it("waits as for Later after an install that leaves it running, instead of counting down again", async () => {
    const { updater, headsUp, install } = make(state(null));
    updater.onState(state("0.1.5"));
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 1_000);
    expect(install).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * COUNTDOWN_MS);
    expect(headsUp).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    // A remote update lifts the wait and goes through the countdown again.
    updater.soon();
    expect(headsUp).toHaveBeenCalledTimes(2);
  });

  it("waits while a session's turn runs on this machine, even on Restart now, then restarts (SESS-SURVIVE)", async () => {
    let running: string | null = "A session is mid-turn: “Fix the build”.";
    const { updater, install } = make(state(null), () => running);
    updater.onState(state("0.1.5"));
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 5_000);
    updater.install();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(install).not.toHaveBeenCalled();
    expect((updater.controls()[0] as { hint: string }).hint).toContain("“Fix the build”");
    running = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(install).toHaveBeenCalledTimes(1);
  });
});
