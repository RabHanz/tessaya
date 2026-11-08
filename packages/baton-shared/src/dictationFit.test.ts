import { describe, expect, it } from "vite-plus/test";

import {
  closeLastSentence,
  contextFromLastInsert,
  fitInsertion,
  fitWithoutContext,
} from "./dictationFit.ts";

describe("fitInsertion", () => {
  const rows: ReadonlyArray<readonly [string, string, string, string]> = [
    // before-caret, after-caret, inserted, expected
    ["", "", "hello there", "Hello there"],
    ["Dear Sam,\n", "", "thanks for this", "Thanks for this"],
    ["I sent it.", "", "Then I waited", " Then I waited"],
    ["I sent it. ", "", "then I waited", "Then I waited"],
    ["Is it ready?", "", "yes it is", " Yes it is"],
    ["He said “stop.”", "", "we stopped", " We stopped"],
    ["Hello,", "", "Thanks for coming", " thanks for coming"],
    ["Hello, ", "", "Thanks for coming", "thanks for coming"],
    ["Hello,", "", "Sam is here", " Sam is here"],
    ["Hello,", "", "I think so", " I think so"],
    ["We use the", "", "Colour system", " Colour system"],
    ["We use the", "", "And more", " and more"],
    ["We use the ", "", "and more", "and more"],
    ["Meet Dr.", "", "Smith there", " Smith there"],
    ["See you", "", ".", "."],
    ["See you", "", ", then", ", then"],
    ["(", "", "note this", "note this"],
    ["a  ", "", "b", "b"],
    ["First part ", "second part", "and middle", "and middle "],
    ["First part", " second", "and middle", " and middle"],
    ["Ends with.", "tail", "Next", " Next "],
  ];
  it.each(rows)("%j | %j + %j -> %j", (before, after, inserted, expected) => {
    expect(fitInsertion({ before, after }, inserted)).toBe(expected);
  });
});

describe("contextFromLastInsert", () => {
  it("ends with a space when the words around the caret are unknown, so text after it never runs in (0.1.75 H2, 0.1.77 H2b)", () => {
    // Pasted before "Hello World", unseen: "…name here.Hello World", then "…name hereHello World".
    expect(fitWithoutContext("Should type her own name here.")).toBe(
      "Should type her own name here. ",
    );
    expect(fitWithoutContext("Done?")).toBe("Done? ");
    expect(fitWithoutContext("her own name here")).toBe("her own name here ");
    expect(fitWithoutContext("Done. ")).toBe("Done. ");
  });

  it("closes the last sentence of a dictation that has sentences, when the recogniser left it open (0.1.77 H2b)", () => {
    expect(closeLastSentence("This is a test. Tessaya should type her own name here")).toBe(
      "This is a test. Tessaya should type her own name here.",
    );
    // One phrase is not prose to close, and a sentence already closed stays as it is.
    expect(closeLastSentence("see you then")).toBe("see you then");
    expect(closeLastSentence("This is a test. Done?")).toBe("This is a test. Done?");
    expect(closeLastSentence("First line. and then,")).toBe("First line. and then,");
  });

  it("uses the last insertion only for the same window and while it is fresh", () => {
    const last = { text: "Done.", at: 1_000, sameWindow: true };
    expect(contextFromLastInsert(last, 2_000)).toEqual({ before: "Done.", after: "" });
    expect(contextFromLastInsert(last, 500_000)).toBeNull();
    expect(contextFromLastInsert({ ...last, sameWindow: false }, 2_000)).toBeNull();
    expect(contextFromLastInsert(null, 2_000)).toBeNull();
  });
});
