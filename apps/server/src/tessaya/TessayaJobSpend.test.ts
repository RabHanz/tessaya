import { describe, expect, it } from "vite-plus/test";

import { spendOfTurns } from "./TessayaJobSpend.ts";
import { parseRateTable } from "../usage/usagePricing.ts";

const rates = parseRateTable({
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
});

const turn = (output: number, model = "claude-sonnet-4-5") =>
  ({
    status: "completed",
    model,
    turnTokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      // Input counts the 1,000 cached tokens.
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      outputTokens: output,
    },
  }) as const;

describe("a job's spend from its provider turns", () => {
  it("prices each finished turn at its model's list price", () => {
    const s = spendOfTurns(
      [turn(1_000), turn(2_000), { ...turn(9_999), status: "running" }],
      rates,
    );
    expect(s.tokens).toBe(2 * 2_000 + 3_000);
    // 2 × (1,000 uncached × $3 + 1,000 cached × $0.30) per M, and 3,000 output × $15 per M.
    expect(s.dollars).toBeCloseTo(2 * (0.003 + 0.0003) + 0.045, 9);
    expect(s.partial).toBe(false);
  });

  it("is a floor, never zero, when a turn has no counts or no price", () => {
    const unpriced = spendOfTurns([turn(1_000), turn(1_000, "unknown-model")], rates);
    expect(unpriced.partial).toBe(true);
    expect(unpriced.dollars).toBeCloseTo(0.003 + 0.0003 + 0.015, 9);
    const uncounted = spendOfTurns([{ status: "completed" }], rates);
    expect(uncounted).toEqual({ tokens: 0, dollars: null, partial: true });
    expect(spendOfTurns([turn(1_000)], null)).toEqual({
      tokens: 3_000,
      dollars: null,
      partial: true,
    });
  });
});
