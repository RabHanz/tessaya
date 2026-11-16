import { describe, expect, it } from "vite-plus/test";

import { ProviderTurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { mergeUnits, spendOfTurns, turnUnits } from "./TessayaJobSpend.ts";
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

describe("each job's and schedule's cost on the Usage page", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const ran = (id: string, runId: string, task: string | null, completed: string) => ({
    turn: { ...turn(1_000), id: ProviderTurnId.make(id), completedAt: at(completed) },
    runId,
    scheduledTaskId: task,
  });
  const since = Date.parse("2026-11-10T00:00:00Z");

  it("counts a job's turns in the range, and a schedule's per run it started", () => {
    const units = turnUnits(
      [
        {
          id: "job-1",
          label: "Weekly report",
          turns: [
            ran("t1", "r1", null, "2026-11-11T10:00:00Z"),
            ran("t2", "r2", "task-1", "2026-11-12T10:00:00Z"),
            // A retry in the same run is one run.
            ran("t3", "r2", "task-1", "2026-11-12T10:05:00Z"),
            ran("t4", "r3", "task-1", "2026-11-13T10:00:00Z"),
            ran("old", "r0", "task-1", "2026-11-01T10:00:00Z"),
          ],
        },
      ],
      since,
      rates,
    );
    expect(units.map((u) => [u.kind, u.id, u.label, u.runs, u.calls, u.tokens])).toEqual([
      ["job", "job-1", "Weekly report", 3, 4, 4 * 3_000],
      ["schedule", "task-1", "Weekly report (scheduled)", 2, 3, 3 * 3_000],
    ]);
    // The plan's turns carry their list price only.
    expect(units[1]?.dollars).toBeNull();
    expect(units[1]?.listDollars).toBeCloseTo(3 * (0.003 + 0.0003 + 0.015), 9);
  });

  it("adds the ledger's calls to the same job, and keeps the ledger's own units", () => {
    const fromTurns = turnUnits(
      [{ id: "job-1", label: "Report", turns: [ran("t1", "r1", null, "2026-11-11T10:00:00Z")] }],
      since,
      rates,
    );
    const unit = { runs: 1, calls: 2, tokens: 100, dollars: 0.01, listDollars: 0.01 };
    const merged = mergeUnits(
      [
        { kind: "job", id: "job-1", ...unit },
        { kind: "schedule", id: "standing", ...unit },
      ],
      fromTurns,
    );
    expect(merged.map((u) => [u.kind, u.id, u.label, u.calls, u.tokens, u.dollars])).toEqual([
      ["job", "job-1", "Report", 3, 3_100, 0.01],
      ["schedule", "standing", undefined, 2, 100, 0.01],
    ]);
    expect(merged[0]?.listDollars).toBeCloseTo(0.01 + 0.003 + 0.0003 + 0.015, 9);
  });
});
