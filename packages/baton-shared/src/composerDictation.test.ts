import { describe, expect, it } from "vite-plus/test";

import {
  IDLE_DICTATION,
  insertWords,
  liveWords,
  mixColour,
  parseColour,
  placeholderWhile,
  settleWords,
  showsActions,
  stepDictation,
  struckWords,
  type ComposerDictation,
  type ComposerDictationEvent,
} from "./composerDictation.ts";

const base = { text: "Let's ship it. Also add a test.", selection: { start: 15, end: 15 } };
const run = (...events: ComposerDictationEvent[]) =>
  events.reduce<ComposerDictation>(stepDictation, IDLE_DICTATION);

describe("dictation in the chat box", () => {
  it("runs held: listen, words, release, settle, done", () => {
    const listening = run({ type: "start", mode: "held", base });
    expect(listening.phase).toBe("listening");
    expect(showsActions(listening)).toBe(false);
    const heard = stepDictation(listening, { type: "heard", text: "um can you check the path" });
    const working = stepDictation(heard, { type: "finish" });
    expect(working.phase).toBe("working");
    const settling = stepDictation(working, { type: "final", text: "Can you check the path?" });
    expect(settling).toMatchObject({
      phase: "settling",
      committed: {
        text: "Let's ship it. Can you check the path? Also add a test.",
        selection: { start: 38, end: 38 },
      },
    });
    expect(stepDictation(settling, { type: "done" })).toBe(IDLE_DICTATION);
    // The placeholder never shows under his words, and comes back only once the dictation is over.
    for (const state of [listening, heard, working, settling])
      expect(placeholderWhile(state, "Ask anything")).toBe("");
    expect(placeholderWhile(IDLE_DICTATION, "Ask anything")).toBe("Ask anything");
  });

  it("hands-free shows ✕ and ✓, and a latched hold turns into it", () => {
    expect(showsActions(run({ type: "start", mode: "free", base }))).toBe(true);
    expect(
      showsActions(run({ type: "start", mode: "held", base }, { type: "mode", mode: "free" })),
    ).toBe(true);
  });

  it("cancel gives back the draft untouched and fades what was heard", () => {
    const cancelled = run(
      { type: "start", mode: "free", base },
      { type: "heard", text: "never mind this" },
      { type: "cancel" },
    );
    expect(cancelled).toMatchObject({ phase: "cancelling", base });
    if (cancelled.phase !== "cancelling") throw new Error("not cancelling");
    expect(cancelled.words.map((w) => w.text)).toEqual(["never", "mind", "this"]);
    // A cancel after the commit is not a restore: the words are his now.
    const settled = run(
      { type: "start", mode: "free", base },
      { type: "final", text: "Hi" },
      { type: "cancel" },
    );
    expect(settled.phase).toBe("settling");
  });

  it("nothing heard ends with the draft as it was", () => {
    expect(run({ type: "start", mode: "held", base }, { type: "final", text: "  " })).toEqual({
      phase: "cancelling",
      base,
      words: [],
    });
  });

  it("a commit the caller already placed is used as it is", () => {
    const committed = { text: "x", selection: { start: 1, end: 1 } };
    expect(
      run({ type: "start", mode: "free", base }, { type: "final", text: "x", committed }),
    ).toMatchObject({ committed });
  });

  it("mutes the unsettled tail: the recogniser's own, else the last two words", () => {
    const tones = (s: ComposerDictation) =>
      s.phase === "listening" ? liveWords(s).map((w) => w.tone) : [];
    const started = run({ type: "start", mode: "free", base });
    expect(tones(stepDictation(started, { type: "heard", text: "can you also check" }))).toEqual([
      "firm",
      "firm",
      "tentative",
      "tentative",
    ]);
    expect(
      tones(stepDictation(started, { type: "heard", text: "can you", tentative: "also" })),
    ).toEqual(["firm", "firm", "tentative"]);
  });

  it("strikes a spoken correction only at the pause", () => {
    const said = run(
      { type: "start", mode: "free", base },
      { type: "heard", text: "ship it on friday no wait thursday" },
    );
    if (said.phase !== "listening") throw new Error("not listening");
    expect(liveWords(said).some((w) => w.tone === "struck")).toBe(false);
    const paused = stepDictation(said, { type: "pause" });
    if (paused.phase !== "listening") throw new Error("not listening");
    expect(liveWords(paused).map((w) => (w.tone === "struck" ? `~${w.text}` : w.text))).toEqual([
      "ship",
      "it",
      "on",
      "~friday",
      "~no",
      "~wait",
      "thursday",
    ]);
  });

  it("strikes no more than he replaced, and nothing for a marker with nothing after it", () => {
    expect([...struckWords("the blue folder scratch that the green folder".split(" "))]).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(struckWords("send it sorry".split(" ")).size).toBe(0);
    expect(struckWords("sorry about that".split(" ")).size).toBe(0);
  });

  it("settles: fillers blur out, case and punctuation take the cleaned spelling", () => {
    expect(settleWords("um can you check the path", "Can you check the path?")).toEqual([
      { text: "um", kind: "gone" },
      { text: "Can", kind: "keep" },
      { text: "you", kind: "keep" },
      { text: "check", kind: "keep" },
      { text: "the", kind: "keep" },
      { text: "path?", kind: "keep" },
    ]);
    expect(settleWords("on friday no wait thursday", "On Thursday.")).toEqual([
      { text: "On", kind: "keep" },
      { text: "friday", kind: "gone" },
      { text: "no", kind: "gone" },
      { text: "wait", kind: "gone" },
      { text: "Thursday.", kind: "keep" },
    ]);
    expect(settleWords("", "Hello")).toEqual([{ text: "Hello", kind: "new" }]);
  });

  it("puts words at the caret with one space where they would touch", () => {
    const at = (text: string, caret: number) => ({ text, selection: { start: caret, end: caret } });
    expect(insertWords(at("", 0), "Hi").text).toBe("Hi");
    expect(insertWords(at("Fix bug", 3), "the").text).toBe("Fix the bug");
    expect(insertWords(at("Done", 4), ".").text).toBe("Done .");
    expect(insertWords(at("Hi .", 2), "there")).toEqual({
      text: "Hi there .",
      selection: { start: 8, end: 8 },
    });
    expect(insertWords({ text: "a old b", selection: { start: 2, end: 5 } }, "new").text).toBe(
      "a new b",
    );
  });
});

describe("pill colours from the theme", () => {
  it("reads the colours themes use", () => {
    expect(parseColour("#14505A")).toEqual([20, 80, 90, 1]);
    expect(parseColour("#fff8")).toEqual([255, 255, 255, 136 / 255]);
    expect(parseColour("rgba(26, 27, 27, 0.9)")).toEqual([26, 27, 27, 0.9]);
    expect(parseColour("color(srgb 1 0.5 0 / 0.5)")).toEqual([255, 127.5, 0, 0.5]);
    expect(parseColour("oklch(0.5 0.1 200)")).toEqual([0, 0, 0, 0]);
  });

  it("mixes as CSS color-mix does", () => {
    expect(mixColour("#ffffff", 50, "#000000")).toBe("rgba(128,128,128,1)");
    expect(mixColour("#0F1B1E", 6, "transparent")).toBe("rgba(15,27,30,0.06)");
  });
});
