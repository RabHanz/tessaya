import { describe, expect, it } from "vite-plus/test";

import { gradeMoment, summarize } from "./grade.ts";

const w = (text: string) => ({ text, mood: "happy", gesture: "nodSmall" });

describe("tessaya-lines grader", () => {
  it("counts a lost fact slot and a lost safety word apart from length", () => {
    const g = gradeMoment("alarm.clear", 3, [
      w("False alarm: {label} is over. All clear."),
      w("False alarm, all clear."),
      w("{label} is over. You're safe."),
    ]);
    expect(g.kept.length).toBe(1);
    expect(g.slotFailures).toBe(1);
    expect(g.requiredFailures).toBe(1);
    expect(g.plainEchoes).toBe(1);
  });
  it("scores variety: repeats and same openings", () => {
    const g = gradeMoment("ok.done", 4, [
      w("All done."),
      w("all done!"),
      w("All done, then."),
      w("Finished."),
    ]);
    expect(g.distinct).toBe(0.75);
    expect(g.sameOpening).toBeCloseTo(2 / 3);
  });
  it("passes only when every bar is met", () => {
    const good = gradeMoment("ok.done", 4, [
      w("Done."),
      w("Sorted."),
      w("There you go."),
      w("All set."),
    ]);
    expect(summarize([good]).pass).toBe(true);
    const flat = gradeMoment("ok.done", 4, [w("Done."), w("Done."), w("Done."), w("Done.")]);
    expect(summarize([flat]).pass).toBe(false);
  });
});
