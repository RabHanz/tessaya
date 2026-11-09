import { describe, expect, it } from "vite-plus/test";

import { cardDocument, learnedText } from "./vocabToast.ts";

describe("the card beside the pill", () => {
  it("says what was learned in one line, however many words", () => {
    expect(learnedText(["Kowalczyk"])).toBe("Learned “Kowalczyk”");
    expect(learnedText(["A", "B"])).toBe("Learned “A”, “B”");
    expect(learnedText(["A", "B", "C", "D"])).toBe("Learned 4 words");
  });
  it("puts his words in the page as text, never as markup", () => {
    const bad = "<img src=x onerror=1>";
    expect(cardDocument({ kind: "learned", words: [bad] })).not.toContain("<img");
    expect(cardDocument({ kind: "copy", why: bad, text: bad })).not.toContain("<img");
    expect(cardDocument({ kind: "error", message: bad, text: bad })).not.toContain("<img");
  });
  it("offers Copy only where there are words to copy, and Discard only for a learned word", () => {
    expect(cardDocument({ kind: "error", message: "Clean-up failed" })).not.toContain('id="copy"');
    expect(cardDocument({ kind: "error", message: "Not pasted", text: "hi" })).toContain(
      'id="copy"',
    );
    expect(cardDocument({ kind: "learned", words: ["A"] })).toContain('id="discard"');
    expect(cardDocument({ kind: "copy", why: "w", text: "t" })).not.toContain('id="discard"');
  });
});
