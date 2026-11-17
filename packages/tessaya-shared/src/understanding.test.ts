import { describe, expect, it } from "vite-plus/test";

import { earlierLine, findFact, nextUnderstanding } from "./understanding.ts";

describe("earlierLine", () => {
  const older = ["- Has two kids", "- Hates football", "- Lives in Leeds"];
  it.each([
    ["kept verbatim, moved by an insert before it", ["- New", ...older], 2, 1],
    ["replaced in the same gap", ["- Has two kids", "- Loves football", "- Lives in Leeds"], 1, 1],
    ["new at the end", [...older, "- Learning the guitar"], 3, null],
    ["a gap wider than the old one", ["- Has two kids", "- A", "- B", "- Lives in Leeds"], 2, null],
  ] as const)("%s", (_, newer, at, want) => {
    expect(earlierLine(newer, older, at)).toBe(want);
  });
});

describe("findFact", () => {
  const text = "- Has two kids\n- Hates football\n- Plays football on Sundays";
  it.each([
    ["the same words, case and dash aside", "hates football.", 1],
    ["a unique part of one", "two kids", 0],
    ["two lines it could be", "football", null],
    ["none", "lives in Leeds", null],
  ] as const)("%s", (_, said, want) => {
    expect(findFact(text, said)).toBe(want);
  });
});

it("a forgotten fact a rewrite proposes again is dropped, with its change", () => {
  const next = nextUnderstanding(
    "- Has two kids",
    {
      unchanged: false,
      text: "- Has two kids\n- hates Football!\n- Learning the guitar",
      changes: [
        { old: null, new: "- hates Football!", cause: "c", evidence: "e" },
        { old: null, new: "- Learning the guitar", cause: "c", evidence: "e" },
      ],
    },
    ["- Hates football"],
  );
  expect(next?.text).toBe("- Has two kids\n- Learning the guitar");
  expect(next?.changes.map((c) => c.new)).toEqual(["- Learning the guitar"]);
});
