import { describe, expect, it } from "vite-plus/test";

import { parseCaretContext } from "./caretContext.ts";

describe("parseCaretContext", () => {
  it("takes both strings, and anything less means the field did not say", () => {
    expect(parseCaretContext('{"before":"Hi.","after":""}\r\n')).toEqual({
      before: "Hi.",
      after: "",
    });
    expect(parseCaretContext("{}")).toBeNull();
    expect(parseCaretContext('{"before":"x"}')).toBeNull();
    expect(parseCaretContext("not json")).toBeNull();
  });
});
