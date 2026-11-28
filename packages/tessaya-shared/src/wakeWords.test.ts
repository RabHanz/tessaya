import { describe, expect, it } from "vite-plus/test";

import { chosenWakeWords, WAKE_WORDS, withWakeChoices } from "./wakeWords.ts";

describe("chosenWakeWords", () => {
  it("is the table's defaults until he chooses", () => {
    expect(
      chosenWakeWords({})
        .filter((w) => w.enabled)
        .map((w) => w.word),
    ).toEqual(WAKE_WORDS.filter((w) => w.onByDefault).map((w) => w.word));
  });

  it("lays his choice over the table, by word in any case, keeping the table's threshold unless he moved it", () => {
    const words = chosenWakeWords({
      freya: { on: false },
      Sebastian: { on: true, threshold: 0.9 },
    });
    expect(words.find((w) => w.word === "Freya")).toEqual({
      word: "Freya",
      enabled: false,
      threshold: 0.95,
    });
    expect(words.find((w) => w.word === "Sebastian")).toEqual({
      word: "Sebastian",
      enabled: true,
      threshold: 0.9,
    });
  });

  it("keeps a word's other fields, and leaves a word he never chose as it was", () => {
    const words = withWakeChoices(
      [
        { word: "Nova", enabled: true, threshold: 0.8, persona: "x" },
        { word: "Alfred", enabled: true, threshold: 0.9, persona: "butler" },
      ],
      { nova: { on: false } },
    );
    expect(words).toEqual([
      { word: "Nova", enabled: false, threshold: 0.8, persona: "x" },
      { word: "Alfred", enabled: true, threshold: 0.9, persona: "butler" },
    ]);
  });
});
