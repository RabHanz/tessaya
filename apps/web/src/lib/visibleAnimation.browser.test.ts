import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import { tickTextContent } from "./tickTextContent";
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

  it("a running timer drops its seconds and ticks on the minute in a still window", () => {
    using _timers = fakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    const startedAt = Date.parse("2026-11-18T11:59:30.000Z");
    const label = document.body.appendChild(document.createElement("span"));
    const stopTicking = tickTextContent((now) => {
      const s = Math.floor((now - startedAt) / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }, true)(label);
    using indicators = new DisposableStack();
    indicators.defer(startStillIndicators());

    // Untouched: still after a minute; a label under a minute keeps its seconds until it passes one.
    vi.advanceTimersByTime(75_000);
    expect(document.documentElement.hasAttribute("data-still")).toBe(true);
    expect(label.textContent).toBe("1m");
    const shown = Array.from({ length: 120 }, () => {
      vi.advanceTimersByTime(1_000);
      return label.textContent;
    });
    expect(new Set(shown)).toEqual(new Set(["1m", "2m", "3m"]));

    window.dispatchEvent(new Event("pointermove"));
    expect(label.textContent).toBe("3m 45s");
    vi.advanceTimersByTime(1_000);
    expect(label.textContent).toBe("3m 46s");
    stopTicking?.();
    label.remove();
  });
});
