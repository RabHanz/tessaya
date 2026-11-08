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
    expect(fitWithoutContext("Is it done?")).toBe("Is it done? ");
    expect(fitWithoutContext("her own name here")).toBe("her own name here ");
    expect(fitWithoutContext("Done. ")).toBe("Done. ");
    // One token (a word, a number, a path) is not followed by a space it was not given.
    expect(fitWithoutContext("hello")).toBe("hello");
    expect(fitWithoutContext("src/app.ts")).toBe("src/app.ts");
  });

  it("closes the last sentence of a dictation that has sentences, when the recogniser left it open (0.1.77 H2b)", () => {
    const said = "This is a test. Tessaya should type her own name here";
    // The text after the caret unknown, empty, a new line or a new sentence: the dictation ends here.
    for (const after of [null, "", "\nNext line", "Hello World"])
      expect([after, closeLastSentence(said, after)]).toEqual([after, `${said}.`]);
    // It carries on, or already has its own mark: "good. and more", "here.. Then back".
    for (const after of [" and more", "and more", ". Then back", ", then"])
      expect([after, closeLastSentence(said, after)]).toEqual([after, said]);
    // One phrase is not prose to close, and a sentence already closed stays as it is.
    expect(closeLastSentence("see you then", null)).toBe("see you then");
    expect(closeLastSentence("This is a test. Done?", null)).toBe("This is a test. Done?");
    expect(closeLastSentence("First line. and then,", null)).toBe("First line. and then,");
    // A link, a path, an address or code at the end gets no stop that would become part of it.
    for (const end of ["example.com/docs", "src/app.ts", "sam@example.com", "user_id", "run()"])
      expect(closeLastSentence(`It is set. See ${end}`, null)).toBe(`It is set. See ${end}`);
  });

  it("uses the last insertion only for the same window and while it is fresh", () => {
    const last = { text: "Done.", at: 1_000, sameWindow: true };
    expect(contextFromLastInsert(last, 2_000)).toEqual({ before: "Done.", after: "" });
    expect(contextFromLastInsert(last, 500_000)).toBeNull();
    expect(contextFromLastInsert({ ...last, sameWindow: false }, 2_000)).toBeNull();
    expect(contextFromLastInsert(null, 2_000)).toBeNull();
  });
});
