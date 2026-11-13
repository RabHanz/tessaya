import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as BatonDatabase from "./BatonDatabase.ts";
import * as BrainUsage from "./BrainUsage.ts";

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
  }).pipe(
    Effect.provide(
      Layer.effect(
        BrainUsage.BrainUsage,
        BrainUsage.make(() => null),
      ).pipe(Layer.provide(BatonDatabase.layerMemory)),
    ),
  ),
);
