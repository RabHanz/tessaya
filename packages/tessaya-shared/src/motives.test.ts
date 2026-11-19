import { describe, expect, it } from "vite-plus/test";

import { decodeBodyMove } from "./bodyControl.ts";
import { chooseWant, wantMove, type MotiveInput, type Want } from "./motives.ts";

const NOW = 10 * 60 * 60_000;
const base: MotiveInput = {
  now: NOW,
  liveliness: "lively",
  mood: { label: "neutral", intensity: 0.2, energy: 0.6 },
  him: "working",
  himAt: NOW - 60_000,
  worldAt: NOW - 30_000,
  newThingAt: null,
  last: null,
};
const want = (over: Partial<MotiveInput>) => chooseWant({ ...base, ...over })?.want ?? null;

describe("motives", () => {
  it("chooses from her mood, his presence and her world, strongest need first", () => {
    expect(want({})).toBeNull();
    expect(want({ mood: { label: "sleepy", intensity: 0.5, energy: 0.2 } })).toBe("rest");
    expect(want({ mood: { label: "hurt", intensity: 0.7, energy: 0.6 } })).toBe("sulk");
    expect(want({ newThingAt: NOW - 2_000 })).toBe("curious");
    expect(want({ himAt: NOW - 3 * 60 * 60_000 })).toBe("seekHim");
    expect(want({ mood: { label: "happy", intensity: 0.5, energy: 0.8 } })).toBe("play");
    expect(want({ worldAt: NOW - 6 * 60_000 })).toBe("bored");
  });

  it("the dial: still never wishes, calm wishes less often and never plays", () => {
    expect(want({ liveliness: "still", worldAt: 0 })).toBeNull();
    expect(
      want({ liveliness: "calm", mood: { label: "happy", intensity: 0.5, energy: 0.8 } }),
    ).toBeNull();
    expect(
      want({ liveliness: "calm", worldAt: 0, last: { want: "curious", at: NOW - 60_000 } }),
    ).toBeNull();
    expect(
      want({ liveliness: "calm", worldAt: 0, last: { want: "curious", at: NOW - 4 * 60_000 } }),
    ).toBe("bored");
  });

  it("never in his way: a full-screen app or a call sends her to rest, and one wish doesn't loop", () => {
    expect(want({ him: "fullscreen", mood: { label: "happy", intensity: 0.5, energy: 0.9 } })).toBe(
      "rest",
    );
    expect(want({ him: "call", last: { want: "rest", at: NOW - 1_000 } })).toBe("rest");
    expect(want({ worldAt: 0, last: { want: "bored", at: NOW - 2 * 60_000 } })).toBeNull();
  });

  it("every wish is a move her body accepts", () => {
    for (const w of ["rest", "sulk", "curious", "seekHim", "play", "bored"] as ReadonlyArray<Want>)
      expect(decodeBodyMove(wantMove(w)).ok, w).toBe(true); // a sulk is her real turn away and back, a missed him her real walk over: no act turns her a second time
    expect(wantMove("sulk")).toMatchObject({ turn: { to: { kind: "away" } } });
    expect(wantMove("sulk").then?.at(-1)).toMatchObject({ turn: { to: { kind: "him" } } });
    expect(wantMove("seekHim")).toMatchObject({ walk: { to: { kind: "him" } } });
    expect([wantMove("sulk").act, wantMove("seekHim").act]).toEqual([undefined, undefined]);
  });
});
