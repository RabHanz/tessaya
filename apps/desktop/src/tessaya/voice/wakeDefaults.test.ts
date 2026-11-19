import { describe, expect, it } from "vite-plus/test";

import { FRESH_WAKE_WORDS, WAKE_DEFAULTS, wakeWordsFor } from "./wakeDefaults.ts";

const enabled = (words: ReadonlyArray<{ word: string; enabled: boolean }>) =>
  words.filter((w) => w.enabled).map((w) => w.word);

describe("wake words at start", () => {
  it("gives a fresh install Tessaya, Alfred and Freya, all on", () => {
    expect(enabled(wakeWordsFor(null))).toEqual(["Tessaya", "Alfred", "Freya"]);
    expect(wakeWordsFor(null)).toBe(FRESH_WAKE_WORDS);
    // The shared table must hand the desktop exactly what it shipped before the room loop read it too.
    expect(FRESH_WAKE_WORDS).toEqual([
      { word: "Tessaya", enabled: true, threshold: 0.99 },
      { word: "Sebastian", enabled: false, threshold: 0.97 },
      { word: "Alfred", enabled: true, threshold: 0.9 },
      { word: "Freya", enabled: true, threshold: 0.95 },
      { word: "Onyx", enabled: false, threshold: 0.95 },
    ]);
  });

  it("gives an existing install the three once, keeping his thresholds and other words", () => {
    const saved = [
      { word: "Tessaya", enabled: false, threshold: 0.98 },
      { word: "Sebastian", enabled: true, threshold: 0.9 },
      { word: "Alfred", enabled: true, threshold: 0.95 },
    ];
    const words = wakeWordsFor({ wakeWords: saved });
    expect(enabled(words)).toEqual(["Tessaya", "Sebastian", "Alfred", "Freya"]);
    expect(words.find((w) => w.word === "Tessaya")?.threshold).toBe(0.98);
    // Alfred's old shipped 0.95 follows the table to 0.90; a threshold he chose himself stays.
    expect(words.find((w) => w.word === "Alfred")?.threshold).toBe(0.9);
    expect(
      wakeWordsFor({
        wakeDefaults: 1,
        wakeWords: [{ word: "Alfred", enabled: true, threshold: 0.93 }],
      }),
    ).toEqual([{ word: "Alfred", enabled: true, threshold: 0.93 }]);
    expect(
      wakeWordsFor({
        wakeDefaults: 1,
        wakeWords: [{ word: "Alfred", enabled: true, threshold: 0.95 }],
      }),
    ).toEqual([{ word: "Alfred", enabled: true, threshold: 0.9 }]);
    // A settings file from before the list was saved gets them too.
    expect(enabled(wakeWordsFor({ enabled: true }))).toEqual([
      "Sebastian",
      "Alfred",
      "Freya",
      "Tessaya",
    ]);
  });

  it("keeps exactly his list once the defaults were given, so a word he turned off stays off", () => {
    const saved = [{ word: "Tessaya", enabled: false, threshold: 0.99 }];
    expect(wakeWordsFor({ wakeWords: saved, wakeDefaults: WAKE_DEFAULTS })).toBe(saved);
  });
});
