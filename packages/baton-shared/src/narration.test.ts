import { describe, expect, it } from "vite-plus/test";

import { isNarration } from "./narration.ts";

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
