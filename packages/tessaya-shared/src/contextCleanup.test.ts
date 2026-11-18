import { describe, expect, it } from "vite-plus/test";

import { cleanupFires, keptCleanup } from "./contextCleanup.ts";

const NAMES = ["Tessaya", "Alfred", "Freya", "Onyx", "Sebastian", "Tessel", "Tumble", "BillingHub"];

describe("the room's clean-up fires only on words that look misheard (19 Nov replay)", () => {
  it("fires on a near-miss of his names and a recipient-less send, never on a clear turn", () => {
    for (const heard of [
      "What about bill in hub?",
      "I was talking to Anfrey.",
      "One's for The Tesla why not use those?",
      "Okay good, send me something fun.",
    ])
      expect(cleanupFires(heard, NAMES), heard).toBe(true);
    for (const heard of [
      "What time is it?",
      "Turn the study lamp yellow.",
      "Send something fun to Sara.",
      "Let me talk to Alfred, please.",
      "Can you set it to about forty percent?",
    ])
      expect(cleanupFires(heard, NAMES), heard).toBe(false);
  });

  it("keeps only a plausible fix of his words", () => {
    expect(keptCleanup("What about bill in hub?", "What about BillingHub?")).toBe(
      "What about BillingHub?",
    );
    expect(keptCleanup("send me something fun", '"tell me something fun"')).toBe(
      "tell me something fun",
    );
    expect(keptCleanup("send me something fun", "")).toBeNull();
    expect(keptCleanup("Anfrey.", "Sure! Here is what I think he meant:\nAlfred.")).toBeNull();
    expect(
      keptCleanup("Anfrey.", "I think you were talking to Alfred about the eyes on the Tumble"),
    ).toBeNull();
  });
});
