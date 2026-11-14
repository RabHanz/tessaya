import { describe, expect, it } from "vite-plus/test";

import { isFullscreenWindow, restBarWanted } from "./pillVisibility.ts";

const display = { x: 0, y: 0, width: 2560, height: 1440 };

describe("when the resting bar stays out of the way", () => {
  it("knows a full-screen game, not the desktop and not a maximised window under the taskbar", () => {
    expect(isFullscreenWindow({ exe: "game.exe", rect: display }, [display])).toBe(true);
    expect(isFullscreenWindow({ exe: "explorer.exe", rect: display }, [display])).toBe(false);
    expect(
      isFullscreenWindow({ exe: "code.exe", rect: { ...display, height: 1400 } }, [display]),
    ).toBe(false);
    expect(isFullscreenWindow({ exe: "game.exe", rect: null }, [display])).toBe(false);
    expect(
      isFullscreenWindow({ exe: "game.exe", rect: { x: 2560, y: 0, width: 1920, height: 1080 } }, [
        display,
        { x: 2560, y: 0, width: 1920, height: 1080 },
      ]),
    ).toBe(true);
  });
  it("shows the bar only when it is wanted, not hidden for a while, and not over a full-screen app", () => {
    const base = {
      atRest: true,
      hiddenUntil: 0,
      hideInFullscreen: true,
      fullscreen: false,
      now: 10,
    };
    expect(restBarWanted(base)).toBe(true);
    expect(restBarWanted({ ...base, atRest: false })).toBe(false);
    expect(restBarWanted({ ...base, hiddenUntil: 100 })).toBe(false);
    expect(restBarWanted({ ...base, fullscreen: true })).toBe(false);
    expect(restBarWanted({ ...base, fullscreen: true, hideInFullscreen: false })).toBe(true);
  });
});
