import { describe, expect, it } from "vite-plus/test";

import { commitMs, heardUntil, isUnfinished, JOIN_WITHIN_MS, thinkAheadMs } from "./endOfTurn.ts";

/** Splits in his log of 2026-11-01: pauses are speech_end gaps minus the later part's estimated length. */
const FIRST_PAUSE_MS = 560;
const split = [
  { first: "There's still many", pauseMs: 1_500 },
  { first: "Textbox on screen.", pauseMs: 1_100 },
  { first: "Can you tell me what's the", pauseMs: 1_700 },
];

describe("end of turn", () => {
  // Each row: what he said, and whether the turn waits longer, the usual time, or less than his setting.
  const table: ReadonlyArray<readonly [string, "longer" | "usual" | "sooner"]> = [
    ["There's still many", "longer"],
    ["Can you tell me what's the", "longer"],
    ["and", "longer"],
    ["so,", "longer"],
    ["I think that", "longer"],
    ["Look. What?", "longer"],
    ["Well.", "longer"],
    ["So, what", "longer"],
    // The recogniser closes a breath with a full stop or an ellipsis; the words are still open.
    ["Open the…", "longer"],
    ["Open the.", "longer"],
    ["Open the door and then", "longer"],
    ["Open the door and then.", "longer"],
    ["I wanted to check the build so.", "longer"],
    ["Send it to Sam but.", "longer"],
    ["Move it to.", "longer"],
    ["Okay, um.", "longer"],
    // A question mark does not close a question that trails off.
    ["What's the weather like in?", "usual"],
    ["Can you tell me about?", "longer"],
    ["Is it bigger than?", "longer"],
    ["Do you know how?", "usual"],
    ["Can you check if?", "longer"],
    ["Who did you send it to?", "sooner"],
    ["What's it about?", "sooner"],
    ["What's it like?", "sooner"],
    ["Who is that?", "sooner"],
    ["So what?", "sooner"],
    // Everyday questions that end on a word that often goes on: the usual wait, never the long one.
    ["What's going on?", "usual"],
    ["What are you working on?", "usual"],
    ["Which file is it in?", "usual"],
    ["Do you know what time it is?", "usual"],
    ["Where am I?", "usual"],
    ["Can I?", "usual"],
    // 0.1.73: cut at 576 ms, and she started dictation on the half request. The last sentence is what is open.
    ["I want to test the dictation feature. Can you", "longer"],
    ["I want to test the dictation feature. Can you.", "longer"],
    // With its question mark it may be the whole ask: the usual wait, not the short one.
    ["I want to test the dictation feature. Can you?", "usual"],
    ["Notepad is open. Could you please", "longer"],
    ["That worked. Can you?", "usual"],
    // A finished first sentence and a short command with no mark: the recogniser closes what it hears end, so a
    // missing mark is a cut more often than not; it waits longer, as a short unmarked turn always has.
    ["I checked the logs from this morning. Merge it", "longer"],
    ["Is that so?", "usual"],
    // Finished sentences that end on a word that often trails off.
    ["Use plan A.", "sooner"],
    ["Pick option A.", "sooner"],
    ["Use plan a.", "sooner"],
    ["Open a.", "longer"],
    ["Vitamin A.", "usual"],
    ["I need to.", "usual"],
    ["I have to go to.", "longer"],
    ["Even so.", "usual"],
    ["Okay so.", "usual"],
    ["What time is it?", "sooner"],
    ["Where is Peru?", "sooner"],
    ["What time?", "sooner"],
    ["Who is he with?", "sooner"],
    ["Look at the screen.", "sooner"],
    ["Open my notes please.", "sooner"],
    ["So what needs me today?", "sooner"],
    ["I think so.", "usual"],
    ["Textbox on screen.", "sooner"],
    ["Okay.", "usual"],
    ["Right.", "usual"],
    ["Okay, yes.", "usual"],
    ["Right, send.", "usual"],
    ["Okay thanks.", "usual"],
    ["Open Notepad.", "usual"],
    ["Tell me the time now please ok", "usual"],
  ];

  it.each(table)("%s waits %s", (text, wait) => {
    expect(isUnfinished(text)).toBe(wait === "longer");
    const ms = commitMs(1_500, text);
    expect(ms > 1_500 ? "longer" : ms < 1_500 ? "sooner" : "usual").toBe(wait);
    // The reply is thought out at once, or after his usual pause when the words trail off.
    expect(thinkAheadMs(1_500, text)).toBe(wait === "longer" ? 1_500 : 0);
  });

  it("splits none of his logged turns, where the old fixed 0.8 s split them", () => {
    let before = 0;
    let after = 0;
    for (const s of split) {
      if (s.pauseMs + FIRST_PAUSE_MS > 800) before += 1;
      // Held until the commit point, or joined if the rest starts within the join window.
      const held = commitMs(1_500, s.first) - FIRST_PAUSE_MS;
      if (s.pauseMs > held && s.pauseMs + FIRST_PAUSE_MS > JOIN_WITHIN_MS) after += 1;
    }
    expect(before).toBe(3);
    expect(after).toBe(0);
  });

  it.each([
    // [audio heard of the playing sentence (from 0 to 4 s), what he hears she had said]
    [0, "It's raining."],
    [2_000, "It's raining. I'll open the…"],
    [3_100, "It's raining. I'll open the March invoice…"],
    [4_000, "It's raining. I'll open the March invoice now."],
    [9_000, "It's raining. I'll open the March invoice now."],
  ] as const)("cut in %i ms into a sentence: %s", (at, said) => {
    const playing = { text: "I'll open the March invoice now.", from: 0, until: 4_000 };
    expect(heardUntil(["It's raining."], playing, at)).toBe(said);
  });

  it("cuts by the words' pace while the audio is still arriving in pieces", () => {
    // Only the first half second of a six-word sentence has arrived; a second in, about half has been said.
    const playing = { text: "I'll open the March invoice now.", from: 0, until: 500 };
    expect(heardUntil([], playing, 1_000)).toBe("I'll open the…");
  });

  it("keeps the whole sentence when the voice gives no audio times", () => {
    const playing = { text: "Opening it.", from: null, until: 0 };
    expect(heardUntil([], playing, 5)).toBe("Opening it.");
  });
});
