import { describe, expect, it } from "vite-plus/test";

import {
  addFrames,
  batteryDrain,
  startStretch,
  STRETCH_MS,
  stretchSummary,
  tick,
  TICK_MS,
} from "./talkCost";

describe("the Talk tab's cost", () => {
  it("counts a late tick as busy time and reports a stretch only once it has run ten minutes", () => {
    let s = startStretch(0);
    s = tick(s, TICK_MS);
    s = tick(s, 2 * TICK_MS + 50);
    s = addFrames(s, 600);
    expect(s.lateMs).toBe(50);
    expect(stretchSummary(s, STRETCH_MS - 1, "visible")).toBeNull();
    expect(stretchSummary(s, STRETCH_MS, "visible")).toBe(
      "visible: 60 frames/min, JS busy 0.0% over 10 min",
    );
  });

  it("says how fast the battery fell only on battery, at both ends, over a full stretch", () => {
    const at = (level: number, minute: number, charging = false) => ({
      level,
      charging,
      at: minute * 60_000,
    });
    expect(batteryDrain(at(0.8, 0), at(0.78, 10))).toBe("battery 12.0%/h");
    expect(batteryDrain(at(0.8, 0), at(0.79, 5))).toBeNull();
    expect(batteryDrain(at(0.8, 0, true), at(0.82, 10))).toBeNull();
    expect(batteryDrain(at(-1, 0), at(0.7, 10))).toBeNull();
    expect(batteryDrain(null, at(0.7, 10))).toBeNull();
  });
});
