import { describe, expect, it } from "vite-plus/test";

import { advanceMorph, MORPH_STEP_MS } from "./formMorph.ts";

describe("advanceMorph", () => {
  it("holds the change through a stalled frame instead of skipping to its end (0.1.201: a cold shader compile)", () => {
    const run = { t: 0, last: null as number | null };
    advanceMorph(run, 1_000);
    expect(run.t).toBe(0);
    // her first frame of the change took 1.2 s to draw: the change moves one step, not 1.2 s
    advanceMorph(run, 2_200);
    expect(run.t).toBeCloseTo(MORPH_STEP_MS / 1000);
    // a slow frame is not a stall: it plays in real time
    advanceMorph(run, 2_400);
    expect(run.t).toBeCloseTo((MORPH_STEP_MS + 200) / 1000);
  });
});
