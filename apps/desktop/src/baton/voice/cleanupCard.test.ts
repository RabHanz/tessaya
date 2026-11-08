import { describe, expect, it } from "vite-plus/test";

import { cleanupMarks } from "./cleanupCard.ts";

describe("what the cleanup kept", () => {
  it("marks the fillers and the retracted words, the rest kept, case and marks aside", () => {
    // The Googlebook ad's sentence (GB-2): "um" and "a rocket launcher. No terrible idea." go.
    const raw =
      "Turn these into a character with um medieval armor and a rocket launcher. No terrible idea. A mustache comb";
    const clean = "Turn these into a character with medieval armor and a mustache comb.";
    expect(
      cleanupMarks(raw, clean)
        .filter((m) => !m.kept)
        .map((m) => m.word),
    ).toEqual(["um", "a", "rocket", "launcher.", "No", "terrible", "idea."]);
    expect(cleanupMarks("hello there", "Hello there.").every((m) => m.kept)).toBe(true);
  });
});
