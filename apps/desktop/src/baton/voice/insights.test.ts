// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { computeInsights } from "./insights.ts";

const turn = (
  at: string,
  app: string,
  text: string,
  seconds: number | null,
  kind: "dictation" | "spoken" = "dictation",
) => ({
  at: new Date(at).toISOString(),
  kind,
  app,
  raw: text,
  cleaned: null,
  seconds,
});

describe("insights", () => {
  it("counts today's words, speed, the streak and top apps from the history alone", () => {
    const now = new Date(2026, 10, 1, 15, 0, 0);
    const at = (daysAgo: number, hour = 10) => new Date(2026, 10, 1 - daysAgo, hour).toISOString();
    const turns = [
      { ...turn(at(0), "slack.exe", "one two three four five six", 6), at: at(0) },
      { ...turn(at(0, 11), "slack.exe", "seven eight", 2), at: at(0, 11) },
      { ...turn(at(1), "notepad.exe", "yesterday words", null), at: at(1) },
      { ...turn(at(2), "slack.exe", "two days back", null), at: at(2) },
      { ...turn(at(4), "slack.exe", "after a gap", null), at: at(4) },
      { ...turn(at(0), "", "what time is it", null, "spoken"), at: at(0) },
    ];
    expect(computeInsights(turns, now)).toEqual({
      wordsToday: 8,
      dictationsToday: 2,
      minutesSaved: 0,
      wpm: 60,
      streak: 3,
      topApps: [
        { app: "slack.exe", count: 4 },
        { app: "notepad.exe", count: 1 },
      ],
    });
    expect(computeInsights([], now)).toMatchObject({ wordsToday: 0, wpm: null, streak: 0 });
  });

  it("saves the typing time at 40 wpm less the time spent speaking", () => {
    const now = new Date(2026, 10, 1, 15, 0, 0);
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const at = new Date(2026, 10, 1, 10).toISOString();
    // 400 words typed is 10 minutes; spoken in 2.
    expect(computeInsights([turn(at, "slack.exe", words(400), 120)], now).minutesSaved).toBe(8);
    // No measured length: his own pace from the timed ones (400 words in 2 minutes) prices it.
    const both = [turn(at, "slack.exe", words(400), 120), turn(at, "slack.exe", words(400), null)];
    expect(computeInsights(both, now).minutesSaved).toBe(16);
  });
});
