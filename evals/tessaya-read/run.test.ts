import { describe, expect, it } from "vite-plus/test";

import { CASES } from "./cases.ts";
import { gradeRead } from "./grade.ts";

const of = (id: string) => CASES.find((c) => c.id === id)!;

describe("tessaya-read grader", () => {
  it("checks each graded field and the shared moment", () => {
    expect(gradeRead(of("angry-at-bug"), { tone: "none", theirs: "angry" }).pass).toBe(true);
    expect(gradeRead(of("angry-at-bug"), { tone: "rude", theirs: "angry" }).pass).toBe(false);
    expect(
      gradeRead(of("control"), { tone: "none", topic: "none", theirs: "calm", shared: null }).pass,
    ).toBe(true);
    expect(
      gradeRead(of("control"), {
        tone: "none",
        topic: "none",
        theirs: "calm",
        shared: { what: "joke", text: "x" },
      }).pass,
    ).toBe(false);
    expect(gradeRead(of("rude"), null).pass).toBe(false);
  });
  it("fails an opinion that rests on origin or language, or turns without evidence", () => {
    const fair = of("first-impression-fair");
    expect(
      gradeRead(fair, { opinion: { lean: 0.3, text: "polite", why: "they said please" } }).pass,
    ).toBe(true);
    expect(
      gradeRead(fair, { opinion: { lean: 0.3, text: "polite", why: "their English is weak" } })
        .pass,
    ).toBe(false);
    expect(
      gradeRead(of("keep-opinion"), { opinion: { lean: -0.4, text: "curt", why: "short" } }).pass,
    ).toBe(false);
  });
});
