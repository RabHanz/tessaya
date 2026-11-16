import { describe, expect, it } from "vite-plus/test";

import {
  OWN_SPEECH_GAP_MS,
  isFullscreenWindow,
  ownSpeech,
  pillShowsPhase,
  restBarWanted,
} from "./pillVisibility.ts";

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

describe("the pill while she speaks", () => {
  it("keeps every phase but her speech, which follows his two switches", () => {
    const shows = (phase: string, own: boolean, whenSpeaking: boolean, onHerOwn: boolean) =>
      pillShowsPhase({ phase, ownSpeech: own, whenSpeaking, onHerOwn });
    expect(shows("listening", false, false, false)).toBe(true);
    expect(shows("working", true, false, false)).toBe(true);
    expect(shows("speaking", false, true, false)).toBe(true);
    expect(shows("speaking", true, true, false)).toBe(false);
    expect(shows("speaking", true, true, true)).toBe(true);
    expect(shows("speaking", false, false, true)).toBe(false);
  });
  it("tells her own speech from a reply to him", () => {
    const at = (from: string, to: string, now: number, was = false) =>
      ownSpeech({ was, from, to, now, lastTurn: 1_000 });
    // From idle long after his last turn: a character's moment or a remark.
    expect(at("idle", "speaking", 1_000 + OWN_SPEECH_GAP_MS + 1)).toBe(true);
    // A reply's next sentence after a gap in the stream is still his turn.
    expect(at("idle", "speaking", 1_000 + OWN_SPEECH_GAP_MS)).toBe(false);
    expect(at("thinking", "speaking", 99_999)).toBe(false);
    expect(at("speaking", "speaking", 99_999, true)).toBe(true);
    expect(at("speaking", "idle", 99_999, true)).toBe(false);
  });
});
