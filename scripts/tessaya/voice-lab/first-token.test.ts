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
  it("splits by how the session was found, so a launch warm still starting shows apart from none (0.1.79)", () => {
    const at = "2026-11-08T07:00:00Z";
    const result = summarise([
      { at, persona: "Freya", firstTokenMs: 3_200, session: "starting" },
      { at, persona: "Alfred", firstTokenMs: 6_400, session: "cold" },
      { at, persona: "Tessaya", firstTokenMs: 3_900, session: "recycled" },
      { at, persona: "Tessaya", firstTokenMs: 1_200, session: "warm" },
      { at, persona: "Tessaya", firstTokenMs: 1_400, session: "warm" },
    ]);
    expect(result.bySession).toEqual({
      warm: { turns: 2, medianMs: 1_400 },
      starting: { turns: 1, medianMs: 3_200 },
      recycled: { turns: 1, medianMs: 3_900 },
      cold: { turns: 1, medianMs: 6_400 },
    });
  });
});
