import { describe, expect, it } from "vite-plus/test";

import {
  createInputPause,
  createMouseConsent,
  PAUSE_MAX_MS,
  pointerMoved,
} from "./pointerGuard.ts";

describe("the mouse stays his", () => {
  it("allows the first action of a turn, and one where the pointer was left", () => {
    expect(pointerMoved(null, { x: 500, y: 400 })).toBe(false);
    expect(pointerMoved({ x: 500, y: 400 }, { x: 503, y: 398 })).toBe(false);
  });
  it("stops when he has moved it", () => {
    expect(pointerMoved({ x: 500, y: 400 }, { x: 700, y: 400 })).toBe(true);
    expect(pointerMoved({ x: 500, y: 400 }, { x: 500, y: 450 })).toBe(true);
  });
});

describe("his mouse as a last resort", () => {
  it("asks before the first use in a turn, and a no stops the click", async () => {
    const answers = [false, true];
    let asked = 0;
    const mouse = createMouseConsent(async () => ((asked += 1), answers.shift() ?? false));
    await expect(mouse.need()).rejects.toThrow("said no");
    await mouse.need();
    await mouse.need();
    expect(asked).toBe(2);
    mouse.reset();
    await expect(mouse.need()).rejects.toThrow("said no");
    expect(asked).toBe(3);
  });
});

describe("his keyboard stays his", () => {
  // A fake clock: the system's last-input time moves when he (or she) types; sleeping advances the clock.
  const rig = () => {
    let now = 1_000_000;
    let lastInput = now;
    const slept: number[] = [];
    const pause = createInputPause({
      idleMs: async () => now - lastInput,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    return {
      pause,
      slept,
      at: (ms: number) => void (now += ms),
      input: () => void (lastInput = now),
    };
  };

  it("carries on at once when nothing but her own input came since her last act", async () => {
    const r = rig();
    r.pause.reset();
    r.at(100);
    r.input(); // her key lands
    r.pause.acted();
    r.at(2_000);
    await r.pause.before();
    expect(r.slept).toEqual([]);
  });

  it("pauses the moment he types, and resumes once he has been quiet for a few seconds", async () => {
    const r = rig();
    r.pause.reset();
    r.at(1_500);
    r.input(); // he types
    r.at(200);
    await r.pause.before();
    expect(r.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2_800);
  });

  it("stops and says so when he keeps typing", async () => {
    let now = 0;
    const pause = createInputPause({
      idleMs: async () => 50,
      now: () => now,
      sleep: async (ms) => void (now += ms),
    });
    pause.reset();
    now += 1_000;
    await expect(pause.before()).rejects.toThrow("paused and stopped");
    expect(now).toBeGreaterThanOrEqual(1_000 + PAUSE_MAX_MS);
  });

  it("never blocks her when the last input cannot be read, or before a turn began", async () => {
    const quiet = createInputPause({
      idleMs: async () => null,
      now: () => 5,
      sleep: async () => {},
    });
    quiet.reset();
    await quiet.before();
    const fresh = createInputPause({ idleMs: async () => 0, now: () => 5, sleep: async () => {} });
    await fresh.before();
  });
});
