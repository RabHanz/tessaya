// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { BodyTools } from "../../apps/server/src/mcp/toolkits/body/tools.ts";
import { AGENT_PROMPT } from "../../packages/tessaya-shared/src/agentPrompt.ts";
import { grade, samplePasses, scoreOf, type Direction } from "./grade.ts";

const library = JSON.parse(
  NodeFS.readFileSync(new URL("./library.json", import.meta.url), "utf8"),
) as { directions: Direction[] };

describe("the direction library", () => {
  it("has 50 or more unique directions, most of them held out", () => {
    const ids = library.directions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(50);
    const unseen = library.directions.filter((d) => d.split === "unseen").length;
    expect(unseen * 2).toBeGreaterThan(ids.length);
    for (const d of library.directions) expect(d.rubric.length).toBeGreaterThan(10);
  });

  it("never shows an unseen direction to the model", () => {
    const text = [AGENT_PROMPT, ...BodyTools.map((t) => JSON.stringify(t))]
      .join("\n")
      .toLowerCase();
    for (const d of library.directions.filter((x) => x.split === "unseen"))
      expect(text).not.toContain(d.said.toLowerCase().replace(/[.!?]$/, ""));
  });
});

describe("the direction grader", () => {
  it("grades what the body would play: a performance covers body, face, gaze and timing", () => {
    const g = grade({
      calls: ["mcp__tessaya__tessaya_body_move"],
      inputs: [{ perform: { feel: { valence: 0.9, arousal: 0.85, dominance: 0.4 } } }],
    });
    expect(g).toMatchObject({
      moved: true,
      channels: ["body", "face", "gaze", "timing"],
      overSpeed: [],
    });
    expect(samplePasses(g, 4)).toBe(true);
    expect(samplePasses(g, 3)).toBe(false);
  });

  it("counts words only, and a move that does not decode, as no move", () => {
    expect(grade({ calls: [], inputs: [] }).moved).toBe(false);
    const bad = grade({ calls: ["tessaya_body_move"], inputs: [{ mood: { name: "pained" } }] });
    expect(bad.moved).toBe(false);
    expect(bad.errors).toHaveLength(1);
    expect(grade({ calls: ["tessaya_body_move"], inputs: [{ gesture: "wave" }] }).channels).toEqual(
      ["body"],
    );
  });

  it("reads the judge's score, and anything unreadable as 0", () => {
    expect(scoreOf('{"score": 4, "why": "clear"}')).toBe(4);
    expect(scoreOf("judge failed")).toBe(0);
  });
});
