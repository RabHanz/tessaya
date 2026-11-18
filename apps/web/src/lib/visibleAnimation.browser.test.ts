import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import { startStillIndicators } from "./visibleAnimation";

describe("startStillIndicators", () => {
  it("holds the indicators still a minute after the last input, or out of sight, and wakes on input", () => {
    using _timers = fakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    // Focused first: the window gains focus here, so the second field's focus is the element's alone.
    const fields = [0, 1].map(() => document.body.appendChild(document.createElement("input")));
    fields[0]!.focus();
    using indicators = new DisposableStack();
    indicators.defer(startStillIndicators());
    const still = () => document.documentElement.hasAttribute("data-still");

    vi.advanceTimersByTime(30_000);
    fields[1]!.focus();
    vi.advanceTimersByTime(15_000);
    expect(still()).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(still()).toBe(true);
    for (const field of fields) field.remove();

    window.dispatchEvent(new Event("pointermove"));
    expect(still()).toBe(false);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(still()).toBe(true);
    visibility = "visible";
    window.dispatchEvent(new Event("keydown"));
    expect(still()).toBe(false);

    indicators.dispose();
    vi.advanceTimersByTime(120_000);
    expect(still()).toBe(false);
  });
});
