import { describe, expect, it, vi } from "vite-plus/test";

import { createPressGate } from "./pressGate.ts";

describe("the hold key's pill", () => {
  it("shows only once the key has been held 200 ms, and never for a shorter tap", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const gate = createPressGate(200, show);
    // A held press: the recording (mic open, ~100 ms) waits for the delay; the pill shows once, at 200 ms.
    gate.press();
    vi.advanceTimersByTime(100);
    gate.want();
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
    // A tap the helper cancels: released at 190 ms, nothing ever shows.
    gate.press();
    vi.advanceTimersByTime(100);
    gate.want();
    vi.advanceTimersByTime(90);
    expect(gate.cancel()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledTimes(1);
    // The hands-free key sends no press: its recording shows at once.
    gate.want();
    expect(show).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
