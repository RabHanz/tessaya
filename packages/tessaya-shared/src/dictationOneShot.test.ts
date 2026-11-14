import { describe, expect, it } from "vite-plus/test";

import { settleOneShot } from "./dictationOneShot.ts";

describe("settleOneShot", () => {
  it("keeps the tidy text, and falls back to what was heard on any failure", () => {
    expect(settleOneShot("um hello", { text: "Hello.", stage: "model" })).toEqual({
      text: "Hello.",
      failed: false,
    });
    expect(settleOneShot("um hello", { text: "Hello.", stage: "local" }).failed).toBe(false);
    for (const cleaned of [
      null,
      { text: "Hello.", stage: "fallback" },
      { text: "  ", stage: "model" },
    ]) {
      expect(settleOneShot("um hello", cleaned)).toEqual({ text: "um hello", failed: true });
    }
  });
});
