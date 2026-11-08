import { describe, expect, it } from "vite-plus/test";

import { startDictationTiming } from "./dictationTiming.ts";

const clock = (start: number) => {
  let t = start;
  return { now: () => t, at: (next: number) => (t = next) };
};

describe("startDictationTiming", () => {
  it("measures a hold-key dictation from release to the pill leaving", () => {
    const c = clock(10_000);
    const timer = startDictationTiming(
      {
        ev: "text",
        id: null,
        text: "hello there",
        dictated: true,
        pasted: false,
        releaseMs: 400,
        inferMs: 900,
        pieces: 3,
        audioMs: 6_000,
        timing: { via: "hold", micMs: 80, firstAudioMs: 120, releasedMs: 6_100 },
      },
      null,
      c.now,
    );
    timer.cleaned("model", c.at(10_650));
    timer.fitted(c.at(10_700));
    timer.pasted(c.at(10_800));
    expect(timer.line()).toBeNull();
    timer.pillGone(c.at(10_900));
    expect(timer.line()).toMatchObject({
      via: "hold",
      micMs: 80,
      firstAudioMs: 120,
      heldMs: 6_100,
      asrMs: 400,
      cleanupMs: 650,
      cleanup: "model",
      fitMs: 50,
      pasteMs: 100,
      pillGoneMs: 100,
      releaseToPasteMs: 1_200,
      releaseToPillGoneMs: 1_300,
      chars: 11,
    });
    expect(timer.line(true)).toBeNull();
  });

  it("takes the sidecar's own paste when cleanup is off, and gives a line on force", () => {
    const c = clock(5_000);
    const timer = startDictationTiming(
      {
        ev: "text",
        id: null,
        text: "hi",
        dictated: true,
        pasted: true,
        pasteMs: 60,
        releaseMs: 300,
      },
      "voice",
      c.now,
    );
    expect(timer.line(true)).toMatchObject({
      via: "voice",
      micMs: null,
      pasteMs: 60,
      releaseToPasteMs: 300,
      pillGoneMs: null,
    });
  });
});
