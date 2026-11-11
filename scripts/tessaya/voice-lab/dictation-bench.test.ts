import { describe, expect, it } from "vite-plus/test";

import { normalise, scoreOne, stageStats, summary } from "./dictation-bench.ts";

describe("the dictation bench", () => {
  it("takes p50, p90 and p99 of each stage, skipping a stage a line did not reach", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      releaseToPasteMs: i + 1,
      asrMs: i < 50 ? null : 10,
    }));
    const stats = stageStats(lines);
    expect(stats.releaseToPasteMs).toEqual({ n: 100, p50: 50, p90: 90, p99: 99 });
    expect(stats.asrMs).toMatchObject({ n: 50, p99: 10 });
    expect(stats.pasteMs.p50).toBeNull();
  });
  it("normalises both sides alike: formatting, fillers and small numbers are not hearing errors", () => {
    expect(normalise("Um, it's well-known: Three APIs!")).toEqual([
      "it's",
      "well",
      "known",
      "3",
      "apis",
    ]);
    expect(scoreOne("um so it's three", "So it's 3.", "").errors).toBe(0);
  });
  it("scores punctuation and capitals apart from the words", () => {
    const wispr = "Can you check? Thanks.";
    const ours = scoreOne("can you check. thanks.", wispr, "");
    expect(ours.errors).toBe(0);
    // "check" ends with a mark on both sides, but not the same one; "thanks." matches.
    expect([ours.punctHit, ours.punctOurs, ours.punctTheirs]).toEqual([1, 2, 2]);
    expect(ours.capsSame).toBe(2);
    expect(summary([ours])).toMatchObject({ wer: 0, punctF1: 50, capitals: 50 });
  });
  it("counts a term pasted that neither he nor Wispr said as a false insertion", () => {
    const terms = ["Tessaya", "Baton"];
    expect(
      scoreOne(
        "Ask Tessaya to pass the baton",
        "Ask Tessa to pass the baton.",
        "ask tessa to pass the baton",
        terms,
      ).falseInsertions,
    ).toBe(1);
    expect(scoreOne("Ask Tessaya", "Ask Tessaya.", "ask tisia", terms).falseInsertions).toBe(0);
  });
});
