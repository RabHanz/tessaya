import { describe, expect, it } from "vite-plus/test";

import { FACE_LIBRARY } from "./expressionMap.ts";
import { TOUCH_KINDS } from "./bodyMotion.ts";
import { TOUCH_WORDS_GAP_MS, touchOpKind, touchReaction } from "./touchReaction.ts";

const stroke = (label: string, over: Partial<Parameters<typeof touchReaction>[0]> = {}) =>
  touchReaction({
    tone: "pleasant",
    reflexes: ["leanIn"],
    mood: { label, intensity: 0.6 },
    pressure: 0.15,
    sinceWordsMs: Infinity,
    ...over,
  });

describe("touchOpKind", () => {
  it("takes every full-body touch onto the one touch path, and none the page's own choice makes", () => {
    expect(TOUCH_KINDS.map((k) => [k, touchOpKind(k)])).toEqual([
      ["tap", "poke"],
      ["poke", "poke"],
      ["pat", "pat"],
      ["stroke", "stroke"],
      ["caress", "stroke"],
      ["rub", "stroke"],
      ["tickle", "stroke"],
      ["hold", "hold"],
      ["squeeze", "squeeze"],
      ["grab", "hold"],
      ["pinch", "poke"],
      ["kiss", null],
      ["hug", "hold"],
      ["trace", "stroke"],
    ]);
  });
});

describe("touchReaction", () => {
  it("answers the same stroke differently as she feels, always with faces her rig can draw", () => {
    const moods = ["happy", "shy", "sleepy", "lonely", "annoyed", "neutral"];
    const seen = moods.map((m) => stroke(m));
    expect(new Set(seen.map((r) => `${r.face}/${r.gesture}`)).size).toBe(moods.length);
    for (const tone of ["pleasant", "firm", "hurt", null] as const)
      for (const m of [...moods, "angry", "worried", "excited", "calm"])
        expect(FACE_LIBRARY).toContain(stroke(m, { tone }).face);
  });

  it("speaks only when it matters to her, and not again within the gap", () => {
    expect(stroke("happy").speak).toBe(false);
    expect(stroke("lonely").speak).toBe(true);
    expect(stroke("happy", { tone: "hurt", reflexes: ["withdraw"] })).toMatchObject({
      speak: true,
      gesture: "startle",
    });
    expect(stroke("lonely", { sinceWordsMs: TOUCH_WORDS_GAP_MS - 1 }).speak).toBe(false);
    // a firm hand when she is cross is worth a word only when it pressed hard
    expect(stroke("annoyed", { tone: "firm", pressure: 0.4 }).speak).toBe(false);
    expect(stroke("annoyed", { tone: "firm", pressure: 0.9 }).speak).toBe(true);
  });

  it("turns her eyes to the hand only when her reflex did", () => {
    expect(stroke("happy").look).toBe(false);
    expect(stroke("happy", { reflexes: ["turnToward"] }).look).toBe(true);
  });
});
