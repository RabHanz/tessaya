import { describe, expect, it } from "vite-plus/test";

import { summarise } from "./first-token.ts";

describe("the first-token measure", () => {
  it("splits turns by a change of persona and counts the cold starts", () => {
    const at = "2026-11-08T05:00:00Z";
    const result = summarise([
      { at, persona: "Freya", firstTokenMs: 1_000, session: "warm" },
      { at, persona: "Freya", firstTokenMs: 1_200, session: "warm" },
      { at, persona: "Alfred", firstTokenMs: 4_000, session: "cold" },
      { at, persona: "Alfred", firstTokenMs: 1_100 },
    ]);
    expect(result.switched).toEqual({ turns: 1, medianMs: 4_000, p90Ms: 4_000, cold: 1 });
    expect(result.same).toMatchObject({ turns: 3, medianMs: 1_100, cold: 0 });
  });
});
