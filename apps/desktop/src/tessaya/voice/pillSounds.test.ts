import { describe, expect, it } from "vite-plus/test";

import { endCueOn, PILL_SOUNDS, renderSound, soundMs, type PillSound } from "./pillSounds.ts";

describe("the cue sounds", () => {
  const all = Object.keys(PILL_SOUNDS) as PillSound[];

  it("are short, quiet and never clip, so none can distort", () => {
    for (const name of all) {
      const samples = renderSound(PILL_SOUNDS[name], 48_000);
      const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak, name).toBeLessThan(0.2);
      expect(soundMs(name), name).toBeLessThanOrEqual(600);
    }
  });

  it("the five guided cues are as loud as each other and under 400 ms", () => {
    const names = ["start", "stepDone", "waiting", "error", "finished"] as const;
    const db = names.map((name) => {
      const w = renderSound(PILL_SOUNDS[name], 48_000);
      return 10 * Math.log10(w.reduce((s, v) => s + v * v, 0) / w.length);
    });
    expect(Math.max(...db) - Math.min(...db)).toBeLessThan(1.5);
    for (const name of names) expect(soundMs(name), name).toBeLessThan(400);
  });

  it("say what happened by their shape: start rises, an error falls, finished resolves upward in three", () => {
    const hz = (name: PillSound) => PILL_SOUNDS[name].map((n) => n.hz);
    expect(hz("start")[1]!).toBeGreaterThan(hz("start")[0]!);
    expect(hz("error")[1]!).toBeLessThan(hz("error")[0]!);
    expect(hz("finished")).toHaveLength(3);
    expect(hz("finished")[2]!).toBeGreaterThan(hz("finished")[0]!);
    expect(PILL_SOUNDS.stepDone).toHaveLength(1);
    expect(PILL_SOUNDS.waiting).toHaveLength(1);
  });
});

describe("the end cue", () => {
  // 0.1.72: it played as the pill lowered, seconds after the window had closed, and its silence on the
  // microphone took the start of his next "Freya, bring Notepad to the front".
  it.each([
    // [the phase before, the phase now (null: the pill lowers), whether the end cue sounds]
    ["listening", "ended", true],
    ["ended", null, false],
    ["listening", null, true],
    ["speaking", null, true],
    ["error", null, false],
    ["done", null, false],
    ["idle", null, false],
    ["ended", "ended", false],
    ["listening", "thinking", false],
  ] as const)("%s to %s: %s", (before, now, sounds) => {
    expect(endCueOn(before, now)).toBe(sounds);
  });
});
