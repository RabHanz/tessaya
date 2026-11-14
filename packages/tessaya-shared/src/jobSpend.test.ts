import { describe, expect, it } from "vite-plus/test";

import { claudeUsage, codexUsage, sumUsage, tokenCount } from "./jobSpend.ts";

const claude = (id: string, output: number, model = "claude-sonnet-4-5") =>
  JSON.stringify({
    type: "assistant",
    requestId: `r-${id}`,
    message: {
      id,
      model,
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
    },
  });

describe("reading a worker's usage from its transcript", () => {
  it("counts each Claude message once even when its usage is repeated, and skips what is not a message", () => {
    const out = claudeUsage([
      claude("m1", 20),
      claude("m1", 50),
      claude("m2", 30),
      JSON.stringify({ type: "user", message: { usage: { input_tokens: 999 } } }),
      "not json usage",
      claude("m3", 7, "<synthetic>"),
    ]);
    expect(out).toEqual([
      {
        model: "claude-sonnet-4-5",
        totals: { input: 20, cacheRead: 200, cacheWrite: 10, output: 80 },
      },
    ]);
  });

  it("takes Codex's last running total and splits the cached input out of it", () => {
    const tc = (input: number, cached: number, output: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
            },
          },
        },
      });
    const out = codexUsage([
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1" } }),
      tc(100, 40, 10),
      tc(500, 300, 60),
    ]);
    expect(out).toEqual([
      { model: "gpt-5.1", totals: { input: 200, cacheRead: 300, cacheWrite: 0, output: 60 } },
    ]);
    expect(codexUsage([tc(1, 0, 1)])).toEqual([]);
  });

  it("sums per model across threads and counts tokens", () => {
    const a = claudeUsage([claude("m1", 20)]);
    const b = claudeUsage([claude("m2", 30), claude("m4", 5, "claude-haiku-4-5")]);
    const all = sumUsage([a, b]);
    expect(all.map((i) => i.model).toSorted()).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
    expect(tokenCount(all)).toBe(135 + 145 + 120);
    expect(all.find((i) => i.model === "claude-sonnet-4-5")?.totals.output).toBe(50);
  });
});
