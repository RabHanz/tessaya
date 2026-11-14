import { describe, expect, it } from "vite-plus/test";

import { cleanupFailedLine, settleOneShot } from "./dictationOneShot.ts";

describe("settleOneShot", () => {
  it("keeps the tidy text, the locally tidied text when the model's is refused, and what was heard when there is none", () => {
    expect(settleOneShot("um hello", { text: "Hello.", stage: "model" })).toEqual({
      text: "Hello.",
      failed: false,
    });
    expect(settleOneShot("um hello", { text: "Hello.", stage: "local" }).failed).toBe(false);
    expect(
      settleOneShot("um hello", { text: "Hello.", stage: "fallback", why: "lost name Tessel" }),
    ).toEqual({ text: "Hello.", failed: true, why: "lost name Tessel" });
    for (const cleaned of [null, { text: "  ", stage: "model" }]) {
      expect(settleOneShot("um hello", cleaned)).toEqual({ text: "um hello", failed: true });
    }
  });

  it.each([
    ["timed out after key api 529", "Clean-up took too long"],
    ["key api 429", "Clean-up could not reach your API key (key api 429)"],
    ["new number 200", "Clean-up changed your words (new number 200)"],
    [undefined, "Clean-up failed"],
  ])("says why the model's clean-up was not used: %s", (why, start) => {
    expect(cleanupFailedLine(why).startsWith(start)).toBe(true);
  });
});
