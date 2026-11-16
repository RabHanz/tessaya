import { describe, expect, it } from "vite-plus/test";

import { HAPTIC_PATTERNS } from "./expressionMap.ts";
import { gainFromFeel, renderHaptic, type HapticHardware } from "./haptics.ts";

const ALL_PRIMITIVES: HapticHardware = {
  kind: "android",
  primitives: ["CLICK", "TICK", "THUD", "QUICK_RISE"],
  amplitude: true,
};

describe("renderHaptic", () => {
  it("names the pattern to an ERM's firmware, which owns its pulses", () => {
    expect(renderHaptic({ kind: "erm" }, "giggle", 2)).toEqual({
      kind: "erm",
      p: "giggle",
      lvl: 2,
    });
  });

  it("makes a tap a crisp transient and a purr a soft continuous on Core Haptics", () => {
    const tap = renderHaptic({ kind: "core-haptics" }, "tap", 3);
    expect(tap).toEqual({
      kind: "core-haptics",
      events: [{ type: "transient", at: 0, intensity: 1, sharpness: 0.8 }],
    });
    const purr = renderHaptic({ kind: "core-haptics" }, "purr", 2);
    if (purr.kind !== "core-haptics") throw new Error(purr.kind);
    expect(purr.events.every((e) => e.type === "continuous" && e.sharpness <= 0.1)).toBe(true);
    expect(purr.events.map((e) => e.at)).toEqual([0, 200, 400, 600]);
  });

  it("falls back on Android from primitives to a waveform to plain timing", () => {
    const composed = renderHaptic(ALL_PRIMITIVES, "double_tap", 2);
    expect(composed).toEqual({
      kind: "android-composition",
      primitives: [
        { primitive: "CLICK", scale: 0.7, delay: 0 },
        { primitive: "CLICK", scale: 0.7, delay: 92 },
      ],
    });
    // A purr has no primitive form: a held waveform even where primitives exist.
    expect(renderHaptic(ALL_PRIMITIVES, "purr", 2).kind).toBe("android-waveform");
    // Missing THUD: a waveform for the thump, ending on its pulse.
    expect(renderHaptic({ ...ALL_PRIMITIVES, primitives: ["CLICK"] }, "thump", 2)).toEqual({
      kind: "android-waveform",
      timings: [0, 112],
      amplitudes: [0, 107],
    });
    expect(renderHaptic({ kind: "android", primitives: [], amplitude: false }, "nudge", 2)).toEqual(
      { kind: "android-timing", timings: [0, 72, 180, 72] },
    );
  });

  it("keeps the same level the same share of every motor, and a device's gain on top", () => {
    for (const pattern of HAPTIC_PATTERNS) {
      const low = renderHaptic({ kind: "core-haptics" }, pattern, 1);
      const high = renderHaptic({ kind: "core-haptics" }, pattern, 3);
      if (low.kind !== "core-haptics" || high.kind !== "core-haptics") throw new Error("kind");
      expect(low.events[0]!.intensity).toBeLessThan(high.events[0]!.intensity);
    }
    const soft = renderHaptic({ kind: "core-haptics" }, "thump", 2, 0.5);
    if (soft.kind !== "core-haptics") throw new Error(soft.kind);
    expect(soft.events[0]!.intensity).toBe(0.21);
  });
});

describe("gainFromFeel", () => {
  it("moves the gain toward his ratings, within bounds", () => {
    expect(gainFromFeel([])).toBe(1);
    expect(gainFromFeel(["right", "right"])).toBe(1);
    expect(gainFromFeel(["weak", "weak"])).toBe(1.25);
    expect(gainFromFeel(["strong"], 0.5)).toBe(0.4);
    expect(gainFromFeel(["weak"], 1.9)).toBe(2);
  });
});
