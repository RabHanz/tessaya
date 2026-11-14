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
    const { clockLine, clockStyleOf, ASSISTANT_PROMPT_INTRO } = await import("./brain.ts");
    expect(clockLine(new Date("2026-11-01T10:07:00Z"), "Asia/Karachi")).toBe(
      "(his clock, for your reference: Sunday, 1 November 2026 at 03:07 pm GMT+5; said as seven minutes past three in the afternoon)",
    );
    // 0.1.78: at 11:32 the fast model said "twenty-eight minutes past eleven"; the words leave nothing to work out.
    // Given both forms it read both aloud ("five past one, or fifty-five to two"), so there is one.
    const said = (iso: string) => clockLine(new Date(iso), "Asia/Karachi").split("said as ")[1];
    expect(said("2026-11-08T06:32:00Z")).toBe("twenty-eight minutes to twelve in the morning)");
    expect(said("2026-11-08T07:00:00Z")).toBe("noon)");
    expect(said("2026-11-08T19:00:00Z")).toBe("midnight)");
    expect(said("2026-11-08T19:15:00Z")).toBe("quarter past twelve in the morning)");
    expect(said("2026-11-08T06:30:00Z")).toBe("half past eleven in the morning)");
    expect(said("2026-11-08T06:45:00Z")).toBe("quarter to twelve in the morning)");
    expect(said("2026-11-08T06:59:00Z")).toBe("one minute to twelve in the morning)");
    // 14 Nov: his clock is his preference; 24-hour reads the clock as it is.
    const said24 = (iso: string) =>
      clockLine(new Date(iso), "Asia/Karachi", "24h").split("said as ")[1];
    expect(said24("2026-11-14T15:20:00Z")).toBe("twenty twenty)");
    expect(said24("2026-11-14T03:05:00Z")).toBe("oh eight oh five)");
    expect(said24("2026-11-14T13:00:00Z")).toBe("eighteen hundred)");
    expect(clockStyleOf("24-hour")).toBe("24h");
    expect(clockStyleOf("12-hour with AM/PM")).toBe("12h");
    expect(clockStyleOf(undefined)).toBe("12h");
    expect(ASSISTANT_PROMPT_INTRO).toMatch(/never read a clock off the screen/);
  });
});
