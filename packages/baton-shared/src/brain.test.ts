// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import { guardDecision, makeSentenceStream } from "./brain.ts";

describe("guardDecision", () => {
  it("refuses a high-risk order whichever side says it", () => {
    const refused = { route: "refused" };
    expect(
      guardDecision(
        { route: "act", text: "check status", source: "model" },
        "deploy to production",
      ),
    ).toMatchObject(refused);
    expect(
      guardDecision(
        { route: "drive", text: "deploy to production", source: "model" },
        "tidy up git",
      ),
    ).toMatchObject(refused);
  });

  it("does not ask which project to deploy: it refuses", () => {
    expect(
      guardDecision(
        { route: "clarify", text: "Which one?", source: "model" },
        "deploy to production",
      ),
    ).toMatchObject({ route: "refused" });
  });

  it("lets a question about a dangerous thing be answered", () => {
    const answer = { route: "answer", text: "what does force push do", source: "model" } as const;
    expect(guardDecision(answer, "what does force push do")).toEqual(answer);
  });
});

describe("makeSentenceStream", () => {
  it("gives sentences as they finish and never reads a tag", () => {
    const stream = makeSentenceStream();
    expect(stream.feed("It's on the ")).toEqual([]);
    expect(stream.feed("left. Then cl")).toEqual(["It's on the left."]);
    expect(stream.feed("ick save [POINT:1,2:save]")).toEqual([]);
    expect(stream.flush()).toBe("Then click save");
  });

  it("reads on after a tag, and keeps brackets that are not one", () => {
    const stream = makeSentenceStream();
    expect(stream.feed("Click save [POI")).toEqual([]);
    expect(stream.feed("NT:1,2:save] and then OK. Your [baton] tab is open. ")).toEqual([
      "Click save and then OK.",
      "Your [baton] tab is open.",
    ]);
    expect(stream.feed("Last of all, the editor")).toEqual([]);
    expect(stream.flush()).toBe("Last of all, the editor");
  });
});

describe("live facts", () => {
  it("gives plain answers the clock in the machine's zone, and keeps clock and web questions off the screen", async () => {
    const { clockLine, ASSISTANT_PROMPT_INTRO } = await import("./brain.ts");
    expect(clockLine(new Date("2026-11-01T10:07:00Z"), "Asia/Karachi")).toBe(
      "(his clock, for your reference: Sunday, 1 November 2026 at 15:07 GMT+5; that is seven minutes past three, or fifty-three minutes to four)",
    );
    // 0.1.78: at 11:32 the fast model said "twenty-eight minutes past eleven"; the words leave nothing to work out.
    expect(clockLine(new Date("2026-11-08T06:32:00Z"), "Asia/Karachi")).toContain(
      "that is thirty-two minutes past eleven, or twenty-eight minutes to twelve",
    );
    expect(clockLine(new Date("2026-11-08T07:00:00Z"), "Asia/Karachi")).toContain(
      "that is twelve o'clock",
    );
    expect(clockLine(new Date("2026-11-08T19:15:00Z"), "Asia/Karachi")).toContain(
      "that is fifteen minutes past twelve, or forty-five minutes to one",
    );
    expect(ASSISTANT_PROMPT_INTRO).toMatch(/never read a clock off the screen/);
  });
});
