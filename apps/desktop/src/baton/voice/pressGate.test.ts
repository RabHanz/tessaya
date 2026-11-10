import { describe, expect, it, vi } from "vite-plus/test";

import { createPressGate } from "./pressGate.ts";

describe("the hold key's pill", () => {
  it("shows only once the key has been held 150 ms, and never for a shorter tap", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const gate = createPressGate(150, show);
    // A held press: the recording (mic open, ~100 ms) waits for the delay; the pill shows once, at 150 ms.
    gate.press();
    vi.advanceTimersByTime(100);
    gate.want();
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(show).toHaveBeenCalledTimes(1);
    // A tap: released at 120 ms, nothing ever shows.
    gate.press();
    vi.advanceTimersByTime(100);
    gate.want();
    vi.advanceTimersByTime(20);
    expect(gate.cancel()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledTimes(1);
    // The hands-free key sends no press: its recording shows at once.
    gate.want();
    expect(show).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
