import { describe, expect, it } from "vite-plus/test";

import { pillEngine } from "./pillTimeline.ts";

const E = pillEngine();
const words = (s: string) => s.split(" ");

describe("pillEngine", () => {
  it("aligns his words to the clean ones: kept, cut, inserted, changed, case and marks aside", () => {
    const ops = E.align(words("so um the pill is done"), words("The pill is finished."));
    expect(ops).toEqual([
      { op: "drop", i: 0 },
      { op: "drop", i: 1 },
      { op: "keep", i: 2, j: 0 },
      { op: "keep", i: 3, j: 1 },
      { op: "keep", i: 4, j: 2 },
      // One drop beside one insert is a changed word.
      { op: "sub", i: 5, j: 3 },
    ]);
    expect(E.align(words("ship it wednesday"), words("Ship it Wednesday, then")).at(-1)).toEqual({
      op: "ins",
      j: 3,
    });
  });

  it("opens in 0.75 s with no overshoot, still at both ends", () => {
    expect(E.EXPAND_MS).toBe(750);
    let was = 0;
    for (let ms = 0; ms <= E.EXPAND_MS; ms += 5) {
      const x = E.SMOOTH(ms / E.EXPAND_MS);
      expect(x).toBeGreaterThanOrEqual(was);
      expect(x).toBeLessThanOrEqual(1);
      was = x;
    }
    expect(E.SMOOTH(0.01)).toBeLessThan(0.001);
    expect(1 - E.SMOOTH(0.99)).toBeLessThan(0.001);
  });

  it("moves the cleanup on one curve that has settled by 1.4 s", () => {
    const flow = (ms: number) =>
      E.springAt(
        [
          { at: 0, to: 0 },
          { at: 0, to: 1 },
        ],
        ms,
        false,
        E.FLOW,
      );
    expect(flow(0)).toBe(0);
    expect(Math.abs(1 - flow(1400))).toBeLessThan(0.01);
    for (let ms = 0; ms <= 1400; ms += 10) expect(flow(ms)).toBeLessThan(1.02);
  });

  it("keeps a spring's velocity through a retarget, and snaps when motion is off", () => {
    const events = [
      { at: 0, to: 0 },
      { at: 0, to: 100 },
      { at: 100, to: 200 },
    ];
    const mid = E.springAt(events, 100, false);
    expect(E.springAt(events, 110, false)).toBeGreaterThan(mid);
    expect(E.springAt(events, 5000, false)).toBeCloseTo(200, 3);
    expect(E.springAt(events, 50, true)).toBe(100);
  });

  it("orders the cleanup: grey, then the strike, the hold, the cut just before the one motion, then the paste", () => {
    const C = E.cleanupTimes(0);
    expect(C.X + C.GREY).toBeLessThan(C.CUT);
    expect(C.CUT).toBeLessThan(C.MOVE_T);
    expect(C.MOVE_T - C.CUT).toBe(240);
    expect(C.MOVE_D).toBe(1400);
    expect(C.P02).toBeGreaterThan(0);
    expect(C.P02).toBeLessThan(C.MOVE_D / 2);
    expect(C.PASTE).toBe(C.MOVE_T + C.MOVE_D + 120);
  });

  it("waits for the opening or the clean text, and shifts every mark by it", () => {
    const now = E.cleanupTimes(0);
    const late = E.cleanupTimes(900);
    for (const key of ["LIT", "SWAP", "HOLD_END", "CUT", "MOVE_T", "SETTLED", "PASTE"] as const)
      expect(late[key] - now[key]).toBe(900);
    expect(E.cleanupTimes(-50).X).toBe(0);
  });

  it("widens the text in 56 px steps and never narrows it while he talks", () => {
    expect(E.stepWidth(0, 10, 388)).toBe(56);
    expect(E.stepWidth(112, 60, 388)).toBe(112);
    expect(E.stepWidth(112, 200, 388)).toBe(224);
    expect(E.stepWidth(0, 900, 388)).toBe(388);
  });
});
