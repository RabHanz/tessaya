import { describe, expect, it } from "vite-plus/test";

import { bridgePrompt, keptBridge } from "./holdLine.ts";

describe("her bridge while a slow answer comes (B-056)", () => {
  it("keeps a short line about his words, and never a stock filler, a promise or one said lately", () => {
    expect(keptBridge("Ooh, the thermostat, let me see what it's up to.", [])).toBe(
      "Ooh, the thermostat, let me see what it's up to.",
    );
    expect(keptBridge('"Right, the checkout bug from last night."', [])).toBe(
      "Right, the checkout bug from last night.",
    );
    // 18 Nov: "One moment." on every slow turn.
    expect(keptBridge("One moment.", [])).toBeNull();
    expect(keptBridge("Let me check.", [])).toBeNull();
    expect(keptBridge("Ah, checking your second screen on the laptop, one moment.", [])).toBeNull();
    // Said before an answer not yet known: a promise it may break.
    expect(keptBridge("Almost there with the fan for you.", [])).toBeNull();
    expect(keptBridge("Okay.", [])).toBeNull();
    expect(
      keptBridge("The fan in the study, one sec.", ["the fan in the study, one sec"]),
    ).toBeNull();
    expect(keptBridge("word ".repeat(15), [])).toBeNull();
    // The eval's headphone turn: the switch may yet fail, and Alfred never names himself.
    expect(keptBridge("Right, routing the audio over to your headphones now.", [])).toBeNull();
    expect(
      keptBridge("Checking acme app now, Alfred, for what's running.", [], "Alfred"),
    ).toBeNull();
    expect(keptBridge("Ah, his laptop's second screen, the extra display.", [])).toBeNull();
    // The replay: parroting a garbled turn, and small talk, where silence is better.
    expect(keptBridge('Ah, "can you," so you\'re asking whether I can.', [])).toBeNull();
    expect(keptBridge("Ah, getting out of present, so you want to leave.", [])).toBeNull();
    expect(keptBridge("NONE", [])).toBeNull();
    expect(keptBridge("Ooh, the study lamp in yellow.", ["Ooh, the office fan again."])).toBeNull();
    expect(keptBridge("The study lamp in yellow, nice.", ["Ooh, the office fan again."])).toBe(
      "The study lamp in yellow, nice.",
    );
  });

  it("gives the writer his words, the talk before and the lines to avoid", () => {
    const prompt = bridgePrompt({
      persona: "Alfred",
      words: "is the office fan still on?",
      before: [
        { role: "user", content: "turn on the office fan" },
        { role: "assistant", content: "It's on." },
      ],
      recent: ["The office fan again, coming right up."],
    });
    expect(prompt).toContain("You are Alfred.");
    expect(prompt).toContain("He: turn on the office fan / She: It's on.");
    expect(prompt).toContain("write a different one: The office fan again");
    expect(prompt.endsWith("He just said: is the office fan still on?")).toBe(true);
  });
});
