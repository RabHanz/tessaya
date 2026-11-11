import { describe, expect, it } from "vite-plus/test";

import {
  holdMainAtLaunch,
  launchWindows,
  mainHeldAtLaunch,
  takeMainHold,
} from "./launchWindows.ts";

describe("launchWindows", () => {
  it.each([
    // A normal start and a login start read the same switches.
    { openTessaya: true, openSessions: true, firstRun: false, tessaya: true, sessions: true },
    { openTessaya: false, openSessions: true, firstRun: false, tessaya: false, sessions: true },
    { openTessaya: true, openSessions: false, firstRun: false, tessaya: true, sessions: false },
    { openTessaya: false, openSessions: false, firstRun: false, tessaya: false, sessions: false },
    // The first run opens both whatever the switches say.
    { openTessaya: false, openSessions: false, firstRun: true, tessaya: true, sessions: true },
  ])("$openTessaya/$openSessions, first run $firstRun", ({ tessaya, sessions, ...input }) => {
    expect(launchWindows(input)).toEqual({ tessaya, sessions });
  });

  it("the hold is read once, so later backend restarts and activations open the window", () => {
    holdMainAtLaunch(true);
    expect(mainHeldAtLaunch()).toBe(true);
    expect(takeMainHold()).toBe(true);
    expect(takeMainHold()).toBe(false);
  });
});
