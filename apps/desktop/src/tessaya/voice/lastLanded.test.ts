import { describe, expect, it } from "vite-plus/test";

import { createLastLanded } from "./lastLanded.ts";

describe("createLastLanded", () => {
  it("keeps the last real dictation through a discard, and never a secret", () => {
    const words = createLastLanded();
    words.landed("send the deck to Julia");
    // A discarded dictation and a spoken command never call landed.
    expect(words.last()).toBe("send the deck to Julia");
    expect(words.landed("the cvv is 123")).toBe(false);
    expect(words.last()).toBe("send the deck to Julia");
    words.clear();
    expect(words.last()).toBeNull();
  });
});
