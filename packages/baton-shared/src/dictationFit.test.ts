import { describe, expect, it } from "vite-plus/test";

import { contextFromLastInsert, fitInsertion, fitWithoutContext } from "./dictationFit.ts";

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
  it("ends a finished sentence with a space when the words around the caret are unknown (0.1.75 H2)", () => {
    // Pasted before "Hello World", unseen: "…name here.Hello World".
    expect(fitWithoutContext("Should type her own name here.")).toBe(
      "Should type her own name here. ",
    );
    expect(fitWithoutContext("Done?")).toBe("Done? ");
    // Mid-sentence words are left as they are: no guess at what follows.
    expect(fitWithoutContext("and then")).toBe("and then");
    expect(fitWithoutContext("Done. ")).toBe("Done. ");
  });

  it("uses the last insertion only for the same window and while it is fresh", () => {
    const last = { text: "Done.", at: 1_000, sameWindow: true };
    expect(contextFromLastInsert(last, 2_000)).toEqual({ before: "Done.", after: "" });
    expect(contextFromLastInsert(last, 500_000)).toBeNull();
    expect(contextFromLastInsert({ ...last, sameWindow: false }, 2_000)).toBeNull();
    expect(contextFromLastInsert(null, 2_000)).toBeNull();
  });
});
