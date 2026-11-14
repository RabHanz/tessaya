import { describe, expect, it } from "vite-plus/test";

import { distilPrompt, DISTIL_DOCUMENT_MAX, parseDistilled } from "./osImport.ts";

const EXEC = "1. Start from the outcome he wants and say it plainly before choosing any work.";

describe("importing a personal operating-system document", () => {
  it("accepts the JSON the model returns, in a fence or not, and drops bad role names and long briefs", () => {
    const reply =
      "Here:\n```json\n" +
      JSON.stringify({
        executive: EXEC,
        roles: {
          research: "A researcher.",
          "../x": "bad",
          Big: "no",
          long: "x".repeat(2000),
          ok2: "Fine.",
        },
      }) +
      "\n```";
    const parsed = parseDistilled(reply);
    expect(parsed).toEqual({
      ok: true,
      pack: { executive: EXEC, roles: { research: "A researcher.", ok2: "Fine." } },
    });
  });
  it("refuses a reply that is not usable, so nothing is written", () => {
    expect(parseDistilled("no json").ok).toBe(false);
    expect(parseDistilled("{not json}").ok).toBe(false);
    expect(parseDistilled(JSON.stringify({ executive: "short", roles: {} })).ok).toBe(false);
  });
  it("puts the document in the prompt, capped", () => {
    expect(distilPrompt("MY DOC")).toContain("MY DOC");
    expect(distilPrompt("x".repeat(DISTIL_DOCUMENT_MAX + 500)).length).toBeLessThan(
      DISTIL_DOCUMENT_MAX + 1_500,
    );
  });
});
