import { describe, expect, it } from "vite-plus/test";

import { leadMoveLine, trackLine } from "./teamView.ts";

const team = [
  { id: "lead", name: "Onyx" },
  { id: "butler", name: "Alfred" },
];

describe("teamView", () => {
  it("names a move, a declined suggestion and a persona no longer in the pack", () => {
    expect(leadMoveLine({ from: "lead", to: "butler", title: "Release notes" }, team)).toBe(
      "Onyx handed Release notes to Alfred",
    );
    expect(leadMoveLine({ from: "lead", to: "lead", declined: "butler" }, team)).toBe(
      "Alfred was suggested for it; you kept Onyx",
    );
    expect(leadMoveLine({ from: "gone", to: "lead" }, team)).toBe("gone handed it to Onyx");
  });

  it("says nothing of a record it has not got", () => {
    expect(trackLine(undefined)).toBe("");
    expect(trackLine({ led: 0, done: 0, failed: 0 })).toBe("");
    expect(trackLine({ led: 5, done: 3, failed: 1 })).toBe("Led 5: 3 done, 1 failed");
    expect(trackLine({ led: 2, done: 2, failed: 0 })).toBe("Led 2: 2 done");
  });
});
