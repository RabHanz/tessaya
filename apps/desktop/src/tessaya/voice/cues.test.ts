import { describe, expect, it } from "vite-plus/test";

import {
  CUE_GAIN,
  CUE_WAIT_MS,
  PILL_SOUNDS,
  THINKING_AFTER_MS,
  THINKING_EVERY_MS,
  parseCueLevel,
  renderSound,
  soundMs,
} from "./pillSounds.ts";

describe("the cues", () => {
  it("are short (80 to 400 ms with their tail), quiet, and thinking is one soft note", () => {
    for (const [name, notes] of Object.entries(PILL_SOUNDS)) {
      const ms = soundMs(name as keyof typeof PILL_SOUNDS);
      expect(ms, name).toBeGreaterThanOrEqual(80);
      expect(ms, name).toBeLessThanOrEqual(400);
      const peak = Math.max(...renderSound(notes, 16_000).map(Math.abs));
      expect(peak, name).toBeLessThan(0.12);
    }
    expect(PILL_SOUNDS.thinking).toHaveLength(1);
    // Rising on start, falling on end.
    expect(PILL_SOUNDS.wake[1]!.hz).toBeGreaterThan(PILL_SOUNDS.wake[0]!.hz);
    expect(PILL_SOUNDS.end[1]!.hz).toBeLessThan(PILL_SOUNDS.end[0]!.hz);
    expect(THINKING_EVERY_MS).toBeGreaterThanOrEqual(8_000);
    expect(THINKING_AFTER_MS).toBe(4_000);
    expect(CUE_WAIT_MS).toBe(300);
  });

  it("have three levels, and an old 'sounds off' file stays off", () => {
    expect(CUE_GAIN).toEqual({ off: 0, quiet: 0.5, normal: 1 });
    expect(parseCueLevel("quiet")).toBe("quiet");
    expect(parseCueLevel(undefined, false)).toBe("off");
    expect(parseCueLevel(undefined, true)).toBe("normal");
    expect(parseCueLevel("loud")).toBe("normal");
  });
});
