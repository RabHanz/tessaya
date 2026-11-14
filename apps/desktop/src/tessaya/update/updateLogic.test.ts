import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canInstallNow,
  compareVersions,
  isNewer,
  isReady,
  offeredVersion,
  shouldDownload,
  updateControls,
} from "./updateLogic.ts";

const state = (over: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  enabled: true,
  status: "up-to-date",
  channel: "latest",
  currentVersion: "0.1.4",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...over,
});

describe("versions", () => {
  it("orders releases, prereleases and the -baton.N and -tessaya.N builds the way semver does", () => {
    expect(isNewer("0.1.5", "0.1.4")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.2", "0.1.2-baton.41")).toBe(true);
    expect(isNewer("0.1.2-baton.41", "0.1.2-baton.9")).toBe(true);
    expect(isNewer("0.1.2-tessaya.1", "0.1.2-baton.49")).toBe(true);
    expect(isNewer("0.1.4", "0.1.4")).toBe(false);
    expect(isNewer("0.1.3", "0.1.4")).toBe(false);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
  it("offers only what is newer than the running version", () => {
    expect(offeredVersion(state({ availableVersion: "0.1.4" }))).toBeNull();
    expect(offeredVersion(state({ availableVersion: "0.1.3" }))).toBeNull();
    expect(offeredVersion(state({ availableVersion: "0.1.5" }))).toBe("0.1.5");
  });
});

describe("when to fetch and when to install", () => {
  it("fetches in the background once, when one is offered and updating is on", () => {
    const offered = state({ status: "available", availableVersion: "0.1.5" });
    expect(shouldDownload(offered)).toBe(true);
    expect(shouldDownload({ ...offered, enabled: false })).toBe(false);
    expect(shouldDownload({ ...offered, status: "downloading" })).toBe(false);
    expect(shouldDownload({ ...offered, downloadedVersion: "0.1.5", status: "downloaded" })).toBe(
      false,
    );
    expect(shouldDownload(state({ status: "available", availableVersion: "0.1.4" }))).toBe(false);
  });
  it("never installs in the middle of a turn", () => {
    const quiet = { voiceBusy: false, assistantBusy: false, inFlight: null };
    expect(canInstallNow(quiet)).toBe(true);
    expect(canInstallNow({ ...quiet, voiceBusy: true })).toBe(false);
    expect(canInstallNow({ ...quiet, assistantBusy: true })).toBe(false);
    // SESS-SURVIVE: a session turn running on this machine would be cut off by the restart.
    expect(canInstallNow({ ...quiet, inFlight: "A session is mid-turn: “Fix the build”." })).toBe(
      false,
    );
  });
});

describe("the window's rows", () => {
  it("puts a downloaded update up front with Install and restart, and waits when pending", () => {
    const ready = state({ status: "downloaded", downloadedVersion: "0.1.5" });
    expect(isReady(ready)).toBe(true);
    expect(updateControls(ready, false)[0]).toMatchObject({
      button: "Install and restart",
      lead: true,
    });
    expect(updateControls(ready, true)[0]).toMatchObject({ button: "Waiting…", disabled: true });
  });
  it("tells him before it restarts, with Restart now and Later, and says when it is waiting", () => {
    const ready = state({ status: "downloaded", downloadedVersion: "0.1.5" });
    const [counting] = updateControls(ready, false, {
      restartAt: 1_800_000_030_000,
      waiting: false,
    });
    expect(counting).toMatchObject({ button: "Restart now", secondary: "Later", lead: true });
    expect((counting as { hint: string }).hint).toContain("restarts at");
    const [waiting] = updateControls(ready, false, { restartAt: 0, waiting: true });
    expect((waiting as { hint: string }).hint).toContain("as soon as the current turns finish");
    // What it waits for, by name, when a session is mid-turn.
    const [sessions] = updateControls(ready, false, {
      restartAt: 0,
      waiting: true,
      inFlight: "A session is mid-turn: “Fix the build”.",
    });
    expect((sessions as { hint: string }).hint).toContain("“Fix the build”");
    expect(
      (updateControls(state(), false, null, "Updated to 0.1.4.")[0] as { hint: string }).hint,
    ).toContain("Updated to 0.1.4.");
  });
  it("keeps the rest behind More options, and disables itself outside the installed app", () => {
    expect(updateControls(state(), false)[0]).toMatchObject({ button: "Check now", more: true });
    expect(updateControls(state({ enabled: false }), false)[0]).toMatchObject({ disabled: true });
    expect(
      updateControls(
        state({ status: "downloading", availableVersion: "0.1.5", downloadPercent: 40 }),
        false,
      )[0],
    ).toMatchObject({
      hint: "Version 0.1.5 is downloading, 40%.",
      disabled: true,
    });
  });
});
