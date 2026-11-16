import { describe, expect, it } from "vite-plus/test";

import { repairLine, repairVerdict, UNCALIBRATED, type HeardWord } from "./transcriptRepair.ts";

const BOUNDS = { accept: 0.6, reject: 0.2 };
const heard = (...pairs: Array<[string, number | null]>): HeardWord[] =>
  pairs.map(([text, p]) => ({ text, p }));

describe("repairVerdict", () => {
  it.each([
    ["all heard well", heard(["Call", 0.9], ["Sara", 0.9], ["now.", 0.95]), { kind: "accept" }],
    [
      "a doubtful name is checked",
      heard(["Call", 0.9], ["Sara", 0.4], ["now.", 0.95]),
      { kind: "clarify", word: "Sara", index: 1 },
    ],
    [
      "a doubtful number is checked",
      heard(["Set", 0.9], ["it", 0.9], ["to", 0.9], ["21.", 0.3]),
      { kind: "clarify", word: "21", index: 3 },
    ],
    [
      "a doubtful function word changes nothing",
      heard(["Turn", 0.9], ["the", 0.3], ["lights", 0.9], ["off.", 0.9]),
      { kind: "accept" },
    ],
    [
      "two doubtful content words ask again",
      heard(["Tell", 0.9], ["Sara", 0.4], ["at", 0.9], ["seven.", 0.5]),
      { kind: "repeat", doubtful: ["Sara", "seven"] },
    ],
    [
      "one content word below the floor asks again",
      heard(["Call", 0.9], ["Sara", 0.1], ["now.", 0.9]),
      { kind: "repeat", doubtful: ["Sara"] },
    ],
    [
      "an unscored name is unknown, never certain",
      heard(["Call", 0.9], ["Sara", null], ["now.", 0.9]),
      { kind: "clarify", word: "Sara", index: 1 },
    ],
    [
      "every word under the floor was never heard",
      heard(["Yeah", 0.05], ["the", 0.1]),
      { kind: "drop", reason: "unheard" },
    ],
  ])("%s", (_, words, verdict) => {
    expect(repairVerdict(words, BOUNDS)).toEqual(verdict);
  });

  it("a sentence's first word is no name, unless his names say so", () => {
    const words = heard(["Sara", 0.4], ["called.", 0.9]);
    expect(repairVerdict(words, BOUNDS)).toEqual({ kind: "accept" });
    expect(repairVerdict(words, BOUNDS, new Set(["sara"]))).toEqual({
      kind: "clarify",
      word: "Sara",
      index: 0,
    });
  });

  it("pure noise is dropped whatever the setting; anything else waits for calibration", () => {
    expect(repairVerdict(heard(["[noise]", null], ["Uhh.", null]), UNCALIBRATED)).toEqual({
      kind: "drop",
      reason: "noise",
    });
    expect(repairVerdict([], UNCALIBRATED)).toEqual({ kind: "drop", reason: "noise" });
    expect(repairVerdict(heard(["Call", 0.1], ["Sara", 0.1]), UNCALIBRATED)).toEqual({
      kind: "accept",
    });
    expect(repairVerdict(heard(["Call", null], ["Sara", null]), BOUNDS)).toEqual({
      kind: "accept",
    });
  });
});

describe("repairLine", () => {
  it("names the word to check, and is empty for a turn taken as heard", () => {
    expect(repairLine({ kind: "clarify", word: "Sara", index: 1 }, "Call Sara now.")).toContain(
      '"Sara"',
    );
    expect(repairLine({ kind: "accept" }, "hi")).toBe("");
  });
});
