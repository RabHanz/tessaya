import { describe, expect, it } from "vite-plus/test";

import { computeVoiceProfile, describeProfile, swaps, type ProfileTurn } from "./voiceProfile.ts";

const turn = (over: Partial<ProfileTurn> = {}): ProfileTurn => ({
  at: "2026-11-02T10:00:00",
  kind: "dictation",
  raw: "um so the meeting is on friday",
  cleaned: "So the meeting is on Friday.",
  seconds: 4,
  corrected: false,
  fixed: null,
  ...over,
});

describe("swaps", () => {
  it("finds one-for-one word replacements and nothing else", () => {
    expect(swaps("send it to Jon today", "send it to John today")).toEqual([["jon", "john"]]);
    expect(swaps("send it to Jon", "send it to John and Mary")).toEqual([]);
    expect(swaps("a b c d e", "v w x y z")).toEqual([]);
  });
});

describe("the voice profile", () => {
  it("is null until there is a dictation, and ignores spoken turns", () => {
    expect(computeVoiceProfile([])).toBeNull();
    expect(computeVoiceProfile([turn({ kind: "spoken" })])).toBeNull();
  });

  it("counts fillers, changes, corrections and the busiest hour", () => {
    const p = computeVoiceProfile([
      turn(),
      turn({ raw: "uh um send it", cleaned: "Send it." }),
      turn({ raw: "ok then", cleaned: "ok then", corrected: true }),
      turn({ at: "2026-11-02T10:30:00" }),
      turn({ at: "2026-11-02T16:00:00" }),
    ])!;
    expect(p.dictations).toBe(5);
    expect(p.fillers.top[0]).toBe("um");
    expect(p.fillers.per100).toBeGreaterThan(0);
    expect(p.changedShare).toBeCloseTo(4 / 5);
    expect(p.correctedShare).toBeCloseTo(1 / 5);
    expect(p.busiestHour).toBe(10);
  });

  it("lists a word he corrects twice, not once", () => {
    const fix = (fixed: string) =>
      turn({ cleaned: "Send it to Jon today", fixed, corrected: true });
    const twice = computeVoiceProfile([
      fix("Send it to John today"),
      fix("Send it to John today"),
      fix("Send it to Jan today"),
    ])!;
    expect(twice.recurringFixes).toEqual([{ wrote: "jon", meant: "john", times: 2 }]);
    expect(describeProfile(twice).at(-1)!.detail).toContain('"jon" to "john" (2 times)');
  });
});
