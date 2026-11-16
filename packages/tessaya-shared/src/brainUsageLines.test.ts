import type { BrainUsageCall, BrainUsageTotal } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { lineCalls, lineDetail, usageLines } from "./brainUsageLines.ts";

const total = (over: Partial<BrainUsageTotal>): BrainUsageTotal => ({
  day: "2026-11-15",
  role: "chat",
  credential: "subscription",
  model: "opus",
  feature: "chat",
  persona: null,
  surface: "desktop",
  billing: "subscription",
  calls: 1,
  input: 10,
  cacheRead: 0,
  cacheWrite: 0,
  output: 5,
  dollars: null,
  listDollars: null,
  ...over,
});

describe("brain usage lines", () => {
  const totals = [
    total({ feature: "chat", calls: 3 }),
    total({ feature: "job", day: "2026-11-16", dollars: 0.5, billing: "apiKey" }),
    total({ feature: "chat", day: "2026-11-16", dollars: 0.25, persona: "freya" }),
  ];

  it("groups by the chosen view, costliest first, plan-only lines without dollars", () => {
    const lines = usageLines(totals, "feature");
    expect(lines.map((l) => [l.key, l.calls, l.tokens, l.dollars])).toEqual([
      ["job", 1, 15, 0.5],
      ["chat", 4, 30, 0.25],
    ]);
    expect(usageLines([total({})], "model")[0]?.dollars).toBeNull();
  });

  it("puts days newest first and keys the login view on role, login and model", () => {
    expect(usageLines(totals, "day").map((l) => l.key)).toEqual(["2026-11-16", "2026-11-15"]);
    expect(usageLines(totals, "login").map((l) => l.key)).toEqual(["chat|subscription|opus"]);
  });

  it("asks the server for what it can filter and narrows the rest on the client", () => {
    const lines = usageLines(totals, "persona");
    const none = lines.find((l) => l.key === "")!;
    expect(lineDetail("persona", none)).toEqual({});
    expect(
      lineDetail(
        "persona",
        lines.find((l) => l.key === "freya")!,
      ),
    ).toEqual({ persona: "freya" });
    const call = (persona: string | null) =>
      ({ ...total({ persona }), at: 0 }) as unknown as BrainUsageCall;
    expect(lineCalls([call(null), call("freya")], "persona", none).map((c) => c.persona)).toEqual([
      null,
    ]);
  });
});
