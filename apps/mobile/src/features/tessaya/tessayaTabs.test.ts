import { describe, expect, it } from "vite-plus/test";

import {
  firstTab,
  primaryTabCapacity,
  talkGesture,
  TESSAYA_PRIMARY_TABS,
  TESSAYA_TAB_ORDER,
} from "./tessayaTabs";

describe("Tessaya's phone tabs", () => {
  it("opens on Today with Today, Sessions and Devices in the bar, and the rest under You", () => {
    expect(firstTab(true)).toBe("today");
    expect(firstTab(false)).toBe("threads");
    expect(TESSAYA_TAB_ORDER.slice(0, primaryTabCapacity(true, 4))).toEqual([
      "today",
      "threads",
      "devices",
    ]);
    expect(TESSAYA_TAB_ORDER.slice(TESSAYA_PRIMARY_TABS)).toEqual(["pullRequests", "usage"]);
    expect(primaryTabCapacity(false, 4)).toBe(4);
  });

  it("tells a hold from a tap", () => {
    expect(talkGesture(120)).toBe("tap");
    expect(talkGesture(280)).toBe("hold");
    expect(talkGesture(2000)).toBe("hold");
  });
});
