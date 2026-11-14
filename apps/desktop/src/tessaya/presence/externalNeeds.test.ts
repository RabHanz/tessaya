import { describe, expect, it, vi } from "vite-plus/test";

import { createExternalNeeds } from "./needsSources.ts";

const config = { repos: ["o/r"], deadlinesFile: null };
const issues = JSON.stringify([
  { number: 1, title: "t", labels: [{ name: "ledger:money-blocker" }], updatedAt: "x" },
]);

describe("the cached external reader", () => {
  it("reads once while the cache is fresh", async () => {
    const run = vi.fn(async () => issues);
    const read = createExternalNeeds({ run });
    await read(config, 0);
    await read(config, 60_000);
    expect(run).toHaveBeenCalledTimes(2); // two labels, one read
  });
  it("does not make a spoken answer wait for a slow gh", async () => {
    vi.useFakeTimers();
    try {
      const read = createExternalNeeds({ run: () => new Promise(() => undefined), timeoutMs: 100 });
      const pending = read(config, 0);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toEqual({
        items: [],
        unreadable: ["the ledger and deadlines (still loading)"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
