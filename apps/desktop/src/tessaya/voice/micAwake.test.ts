import { describe, expect, it } from "vite-plus/test";

import { micAwakeMs, micAwakeOf } from "./micAwake.ts";

describe("the microphone kept awake after a dictation", () => {
  it("is held 15 minutes by default, never in quiet hours, and as he chose otherwise", () => {
    expect(micAwakeMs(micAwakeOf(undefined), false)).toBe(15 * 60_000);
    expect(micAwakeMs("15m", true)).toBe(0);
    expect(micAwakeMs("always", true)).toBe(0);
    expect(micAwakeMs("off", false)).toBe(0);
    expect(micAwakeMs("always", false)).toBeGreaterThan(24 * 3_600_000);
    expect(micAwakeOf("always")).toBe("always");
    expect(micAwakeOf("nonsense")).toBe("15m");
  });
});
