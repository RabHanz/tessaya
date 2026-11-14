import { describe, expect, it, vi } from "vite-plus/test";

import { runOnceItsTurn } from "./standingRun.ts";

describe("a standing job's run once it has the turn", () => {
  it("does not start when the pass ran out of time while it waited", async () => {
    const pass = new AbortController();
    pass.abort();
    const work = vi.fn(async () => ({ status: "ok" as const, text: "" }));
    expect(await runOnceItsTurn(pass.signal, 1_000, work)).toEqual({
      status: "cancelled",
      text: "Waited too long for its turn.",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("starts its own time limit when it begins, and the work sees it run out", async () => {
    using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const running = runOnceItsTurn(new AbortController().signal, 10_000, (timeout) => {
      seen = timeout;
      return new Promise((resolve) =>
        timeout.addEventListener("abort", () =>
          resolve({ status: "timeout", text: "out of time" }),
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toEqual({ status: "timeout", text: "out of time" });
  });
});
