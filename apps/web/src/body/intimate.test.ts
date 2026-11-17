import { describe, expect, it } from "vite-plus/test";

import { perfectSyncWeights } from "./intimate";

describe("perfectSyncWeights", () => {
  it("sculpts each state from ARKit units on both sides, opens the panting jaw on the exhale and caps at 1", () => {
    const brows = perfectSyncWeights({ browsUp: 1 }, 0);
    expect(brows["browInnerUp"]).toBeCloseTo(0.9);
    expect([brows["browDownLeft"], brows["browDownRight"]]).toEqual([0.25, 0.25]);
    const inhale = perfectSyncWeights({ mouthPant: 1 }, 0);
    const exhale = perfectSyncWeights({ mouthPant: 1 }, 1);
    expect(exhale["jawOpen"]!).toBeGreaterThan(inhale["jawOpen"]!);
    // nostrils flare on the breath in
    expect(inhale["noseSneerLeft"]!).toBeGreaterThan(exhale["noseSneerLeft"] ?? 0);
    const peak = perfectSyncWeights(
      { eyesShut: 1, eyesHalf: 1, eyesRoll: 1, tongue: 1, mouthO: 1 },
      1,
    );
    expect(peak["eyeBlinkLeft"]).toBe(1);
    expect(peak["tongueOut"]).toBe(1);
    expect(perfectSyncWeights({}, 0.5)).toEqual({});
  });
});
