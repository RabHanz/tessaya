import { describe, expect, it } from "vite-plus/test";

import { isNarration, withoutSelfIntro } from "./narration.ts";

const spoken = (reply: string) =>
  reply
    .split(/(?<=[.!?…])\s+/)
    .filter((s) => !isNarration(s))
    .join(" ");

describe("isNarration", () => {
  it("drops her reasoning from the 13 Nov R1 replies and keeps what she said to him", () => {
    expect(
      spoken(
        "Nothing in the conversation says what he means. I should ask rather than guess or touch the house. Different what?",
      ),
    ).toBe("Different what?");
    expect(
      spoken(
        "'To say, yeah' is unclear, and nothing in the conversation asks for an action. I'll ask him what he meant. Hm, I'm not sure what you mean.",
      ),
    ).toBe("Hm, I'm not sure what you mean.");
    expect(
      spoken(
        "Looks like a stray fragment; the office fan was already turned off earlier and nothing is pending. I'll keep it short. Got it, nothing else is waiting on you.",
      ),
    ).toBe("Got it, nothing else is waiting on you.");
    // 10:36:28 and 10:37:21: third-person reasoning that got past the first filter.
    expect(
      spoken(
        "He just said 'J', which sounds like a fragment rather than a request. Sorry, I didn't catch that.",
      ),
    ).toBe("Sorry, I didn't catch that.");
    expect(
      spoken(
        "He just called my name and nothing else, so I'll wait for what he needs checked or shipped. Yes?",
      ),
    ).toBe("Yes?");
    expect(spoken("Pages because doesn't make sense as a request. Could you say that again?")).toBe(
      "Could you say that again?",
    );
  });

  it("keeps ordinary replies, plans said to him and other people in the third person", () => {
    for (const line of [
      "Shall I turn it off by hand?",
      "I'll turn the office fan off.",
      "I'll check the fan.",
      "I'll ask on your phone first.",
      "Your brother said he would call at six.",
      "Seven eighteen.",
      "I should be able to do that.",
      "The office fan is off now.",
    ])
      expect(isNarration(line), line).toBe(false);
  });
});

describe("withoutSelfIntro", () => {
  const names = ["Tessaya", "Freya", "Alfred", "Sebastian"];
  it("drops the persona's own name and role pitch from her spoken reply (10:36:57 and 10:37:21, 13 Nov)", () => {
    expect(withoutSelfIntro("Alfred here, ready when you are.", names)).toBe("ready when you are.");
    expect(withoutSelfIntro("Alfred here.", names)).toBe("");
    expect(withoutSelfIntro("Alfred here: do you mean a build or a session?", names)).toBe(
      "do you mean a build or a session?",
    );
    expect(withoutSelfIntro("Freya here, glad to.", names)).toBe("glad to.");
    expect(withoutSelfIntro("The office fan is off.", names)).toBe("The office fan is off.");
    expect(withoutSelfIntro("Alfred hereby confirms.", names)).toBe("Alfred hereby confirms.");
    expect(
      isNarration(
        "Sessions, builds and releases are mine, so tell me what you need checked or shipped.",
      ),
    ).toBe(true);
    expect(isNarration("I'm the research and analysis voice.")).toBe(true);
    expect(isNarration("He's asking for the time again.")).toBe(true);
    expect(isNarration("He said 'J', which sounds like a fragment.")).toBe(true);
  });
});
