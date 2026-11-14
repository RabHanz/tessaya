import { describe, expect, it } from "vite-plus/test";

import { confirmed, ERASE_WORD, RESET_LABEL, RESET_SCOPES } from "./dataReset.ts";

describe("erasing his data", () => {
  it("needs the word typed, in any case, and nothing else", () => {
    expect(confirmed("erase")).toBe(true);
    expect(confirmed("  ERASE ")).toBe(true);
    expect(confirmed("yes")).toBe(false);
    expect(confirmed("")).toBe(false);
    expect(confirmed("erase everything")).toBe(false);
    expect(ERASE_WORD).toBe("erase");
  });
  it("says what each scope removes and that it cannot be undone", () => {
    expect(RESET_SCOPES.map((s) => RESET_LABEL[s].label)).toEqual([
      "Erase History",
      "Erase voice recordings",
      "Erase memory",
    ]);
    expect(RESET_LABEL.history.hint).toContain("cannot be undone");
  });
});
