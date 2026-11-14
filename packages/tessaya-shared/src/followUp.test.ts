import { describe, expect, it } from "vite-plus/test";

import { isAddressedFollowUp } from "./followUp.ts";

describe("a follow-up after an answer", () => {
  it.each([
    "What about Rome?",
    "and in Paris?",
    "Tell me more about that",
    "show me the last one",
    "Can you read it again",
    "I want the one from Tuesday",
    // 0.1.61: said 2 s after her reply, and dropped.
    "I wanted to test the dictation feature.",
    "I wanted to ask you about the launch",
    "I needed you to check the build",
    "yes please",
    "Tessaya, stop",
    "how long does it take",
  ])("is taken: %j", (said) => expect(isAddressedFollowUp(said)).toBe(true));

  it.each([
    // Past tense only as a request: "I wanted to…", not a story about what he needed.
    "I wanted a coffee earlier",
    "I needed that yesterday",
    "I meant what I said",
    // 0.1.64: a near-miss narration clip that became a turn in an open window.
    "I wanted to say a few words about the launch.",
    "Alfonso thinks the festival starts at eight",
    "The government announced new measures today",
    "That sounds like a statement rather than a question",
    "Sabrina is coming over later",
    "it was raining all weekend",
    "Sebastopol fell after eleven months",
    "",
    "   ",
  ])("is let go in silence: %j", (said) => expect(isAddressedFollowUp(said)).toBe(false));
});
