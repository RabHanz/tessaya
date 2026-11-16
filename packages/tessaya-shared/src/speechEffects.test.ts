import { describe, expect, it } from "vite-plus/test";

import { speechPieces } from "./interjections.ts";
import {
  charShare,
  fireAtMs,
  saidText,
  soundAnchors,
  type EffectWhen,
  type SpeechTimeline,
} from "./speechEffects.ts";

describe("sound anchors", () => {
  it.each([
    ["That's brilliant *laughs* you did it.", [{ word: 2, nonverbal: "laugh" }]],
    ["*gasps* Really?", [{ word: 0, nonverbal: "gasp" }]],
    // At the line's end: past its last word.
    ["Good night. *smiles*", [{ word: 2, nonverbal: "smile" }]],
    [
      "Oh *sighs* fine [laughs] okay.",
      [
        { word: 1, nonverbal: "sigh" },
        { word: 2, nonverbal: "laugh" },
      ],
    ],
    ["No directions here.", []],
  ])("%s", (line, anchors) => {
    expect(soundAnchors(speechPieces(line, ""))).toEqual(anchors);
  });

  it("counts a sound said as words, as the aligner and the word cues do", () => {
    const pieces = speechPieces("*laughs* Then *gasps* go.", "");
    // A laugh with no clip is said as "Ha ha.": "Then" is the third word the audio says.
    expect(saidText(pieces)).toBe("Ha ha. Then go.");
    expect(soundAnchors(pieces)).toEqual([
      { word: 0, nonverbal: "laugh" },
      { word: 3, nonverbal: "gasp" },
    ]);
  });
});

describe("fireAtMs", () => {
  const timeline = (over: Partial<SpeechTimeline> = {}): SpeechTimeline => ({
    nowMs: 1_000,
    sentences: [
      { startMs: 2_000, durationMs: 1_000, text: "aa bb cccccc", wordMs: [0, 180] },
      { startMs: 3_500, durationMs: null, text: "dd ee" },
      { startMs: null, durationMs: 800, text: "ff" },
    ],
    endMs: null,
    ...over,
  });
  const speech = (sentence: number, word: number): EffectWhen => ({
    at: "speech",
    sentence,
    word,
  });
  it.each<[string, EffectWhen, Partial<SpeechTimeline>, number | null]>([
    ["now is the vessel's now", { at: "now" }, {}, 1_000],
    ["after waits for the end of speech", { at: "after" }, {}, null],
    ["after is the end once known", { at: "after" }, { endMs: 4_200 }, 4_200],
    ["the aligner's word time wins", speech(0, 1), {}, 2_180],
    // "cccccc" starts after 4 of 10 letters: 400 ms into a 1 s sentence.
    ["by letters where the aligner has no time", speech(0, 2), {}, 2_400],
    ["past the last word is the sentence's end", speech(0, 3), {}, 3_000],
    ["no length yet: not timed", speech(1, 1), {}, null],
    ["not started yet: not timed", speech(2, 0), {}, null],
    ["a sentence not yet heard of: not timed", speech(5, 0), {}, null],
  ])("%s", (_, when, over, at) => {
    expect(fireAtMs(when, timeline(over))).toBe(at);
  });

  it("shares by letters, not words", () => {
    expect(charShare("a bbbb c", 1)).toBeCloseTo(1 / 6);
    expect(charShare("", 1)).toBe(0);
  });
});
