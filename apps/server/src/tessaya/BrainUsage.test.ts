// @effect-diagnostics nodeBuiltinImport:off - one test loads the module in a real Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import { parseRateTable, type RateTable } from "../usage/usagePricing.ts";
import * as TessayaDatabase from "./TessayaDatabase.ts";
import * as TessayaRecordService from "./TessayaRecordService.ts";
import * as BrainUsage from "./BrainUsage.ts";

const usageLayer = (rates: RateTable | null) =>
  Layer.effect(
    BrainUsage.BrainUsage,
    BrainUsage.make(() => rates),
  ).pipe(
    Layer.provideMerge(TessayaRecordService.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provide(TessayaDatabase.layerMemory),
  );

/** Claude Code 2.1's `result` event, trimmed (a real `claude -p --model haiku` run, 13 Nov). */
const RESULT = {
  type: "result",
  total_cost_usd: 0.00062,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 3058,
    cache_read_input_tokens: 649,
    output_tokens: 4,
  },
  modelUsage: {
    "claude-haiku-5-5": {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 649,
      cacheCreationInputTokens: 3058,
      costUSD: 0.00062,
    },
  },
};

it("reads a CLI result per model it used, and its plain usage when it names none", () => {
  expect(BrainUsage.cliTokens(RESULT, "haiku")).toEqual([
    { model: "claude-haiku-5-5", input: 2, cacheRead: 649, cacheWrite: 3058, output: 4 },
  ]);
  const { modelUsage: _, ...plain } = RESULT;
  expect(BrainUsage.cliTokens(plain, "sonnet")).toEqual([
    { model: "sonnet", input: 2, cacheRead: 649, cacheWrite: 3058, output: 4 },
  ]);
  expect(BrainUsage.cliTokens(null, "sonnet")).toEqual([]);
});

it.effect("totals by day in his zone; the plan's rows carry no dollars", () =>
  Effect.gen(function* () {
    const usage = yield* BrainUsage.BrainUsage;
    const tokens = { model: "claude-sonnet-5-5", input: 1, cacheRead: 2, cacheWrite: 3, output: 4 };
    // 18:30 UTC on 12 Nov is 23:30 in Karachi; 19:30 UTC is 00:30 on the 13th there.
    yield* TestClock.setTime(Date.UTC(2026, 10, 12, 18, 30));
    yield* usage.record({ ...tokens, role: "voice", credential: "subscription" });
    yield* TestClock.setTime(Date.UTC(2026, 10, 12, 19, 30));
    yield* usage.record({ ...tokens, role: "voice", credential: "subscription" });
    yield* usage.record({ ...tokens, role: "voice", credential: "subscription" });
    // No price list yet: an API row is kept, its dollars unknown.
    yield* usage.record({ ...tokens, role: "cleanup", credential: "apiKey:anthropic" });

    const karachi = yield* usage.totals({ since: 0, timeZone: "Asia/Karachi" });
    expect(karachi.map((t) => [t.day, t.role, t.calls, t.output, t.dollars])).toEqual([
      ["2026-11-12", "voice", 1, 4, null],
      ["2026-11-13", "cleanup", 1, 4, null],
      ["2026-11-13", "voice", 2, 8, null],
    ]);
    const london = yield* usage.totals({ since: 0, timeZone: "Europe/London" });
    expect(london.map((t) => [t.day, t.role, t.calls])).toEqual([
      ["2026-11-12", "cleanup", 1],
      ["2026-11-12", "voice", 3],
    ]);
    expect(
      yield* usage.totals({ since: Date.UTC(2026, 10, 12, 19), timeZone: "Asia/Karachi" }),
    ).toHaveLength(2);
  }).pipe(Effect.provide(usageLayer(null))),
);

it.effect(
  "tells him once when the API keys' spend reaches a limit he set, and the plan never counts",
  () =>
    Effect.gen(function* () {
      const usage = yield* BrainUsage.BrainUsage;
      const settings = yield* ServerSettingsService;
      const record = yield* TessayaRecordService.TessayaRecordService;
      yield* settings.updateSettings({
        brainSpendAlert: { all: { day: 0.15 }, cleanup: { month: 1 } },
      });
      // $0.10 a call at list: 100k uncached input tokens at $1/M.
      const call = {
        model: "claude-haiku-5-5",
        input: 100_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      };
      yield* TestClock.setTime(Date.UTC(2026, 10, 13, 6));
      yield* usage.record({ ...call, role: "cleanup", credential: "apiKey:anthropic" });
      yield* usage.record({ ...call, role: "voice", credential: "subscription" });
      expect(yield* record.query({ kind: "brain_spend" })).toEqual([]);
      yield* usage.record({ ...call, role: "cleanup", credential: "apiKey:anthropic" });
      yield* usage.record({ ...call, role: "cleanup", credential: "apiKey:anthropic" });
      const alerts = yield* record.query({ kind: "brain_spend" });
      expect(alerts.map((a) => a.detail)).toEqual([
        "Today's API spend on all her work reached your $0.15 alert: $0.20 so far.",
      ]);
      expect(yield* usage.limits("Asia/Karachi")).toEqual([
        { scope: "all", period: "day", limit: 0.15, spent: expect.closeTo(0.3, 6), reached: true },
        {
          scope: "cleanup",
          period: "month",
          limit: 1,
          spent: expect.closeTo(0.3, 6),
          reached: false,
        },
      ]);
    }).pipe(
      Effect.provide(
        usageLayer(
          parseRateTable({
            "claude-haiku-5-5": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
          }),
        ),
      ),
    ),
);

it("reads his day and month in his zone, and a zone it doesn't know as not one", () => {
  // 20:00 UTC on 31 Oct is 01:00 on 1 Nov in Karachi: his month has begun.
  const at = Date.UTC(2026, 9, 31, 20);
  expect(BrainUsage.periodStarts("Asia/Karachi", at)).toEqual({
    day: Date.UTC(2026, 9, 31, 19),
    month: Date.UTC(2026, 9, 31, 19),
  });
  expect(BrainUsage.knownZone("Asia/Karachi")).toBe(true);
  expect(BrainUsage.knownZone("Mars/Olympus")).toBe(false);
});

it("loads first in plain Node, as the evals import it", () => {
  // Vitest evaluates cycles in a different order, so only a real Node load shows a TDZ cycle.
  const run = NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'await import("./src/tessaya/BrainUsage.ts")'],
    { cwd: NodePath.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
  );
  expect(run.stderr).not.toContain("before initialization");
  expect(run.status).toBe(0);
});
