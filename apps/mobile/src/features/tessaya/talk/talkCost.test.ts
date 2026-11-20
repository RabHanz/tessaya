import { describe, expect, it } from "vite-plus/test";

import { addFrames, startStretch, STRETCH_MS, stretchSummary, tick, TICK_MS } from "./talkCost";

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
});
