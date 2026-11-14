import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_AFFECT_SETTINGS,
  affectView,
  appraise,
  decay,
  freshAffect,
  guiltOf,
  moodLine,
  shown,
  type AffectEvent,
  type AffectState,
} from "./affect.ts";

const H = 3_600_000;
const day = { now: 0, hour: 12, guilt: "light" as const, settings: DEFAULT_AFFECT_SETTINGS };
const run = (events: ReadonlyArray<AffectEvent>, s: AffectState = freshAffect(0), at = 0) =>
  events.reduce((acc, e) => appraise(acc, e, at, 0.15).state, s);

describe("affect", () => {
  it("rests on the temperament: neutral by day, sleepy late at night", () => {
    expect(affectView(freshAffect(0), "executive", day).label).toBe("neutral");
    expect(affectView(freshAffect(0), "executive", { ...day, hour: 23.5 }).label).toBe("sleepy");
  });

  it("labels relative to each persona's own temperament, so the same events read the same", () => {
    const wins = run([{ kind: "praise" }, { kind: "turn_outcome", ok: true }]);
    for (const persona of ["executive", "companion", "butler", "alter-ego", "engineering"])
      expect(affectView(wins, persona, day).label).toBe("proud");
    // Thresholds are after intensity: one small win shows only at full intensity.
    const win = run([{ kind: "turn_outcome", ok: true }]);
    expect(affectView(win, "companion", day).label).toBe("neutral");
    const full = { ...day, settings: { ...day.settings, intensity: 1 } };
    expect(affectView(win, "companion", full).label).toBe("happy");
  });

  it("failure makes her focused, then frustrated, never below the floors", () => {
    expect(affectView(run([{ kind: "turn_outcome", ok: false }]), "executive", day).label).toBe(
      "focused",
    );
    const bad = run(Array.from({ length: 40 }, () => ({ kind: "correction" }) as const));
    const d = shown(bad, "executive", { ...day, settings: { ...day.settings, intensity: 1 } });
    expect(d.confidence).toBe(0.35);
    expect(d.valence).toBeGreaterThanOrEqual(-0.7);
    expect(d.arousal).toBeLessThanOrEqual(0.8);
  });

  it("decays lazily: a reaction is gone in minutes, a mood in hours", () => {
    const s = run([{ kind: "praise" }]);
    expect(decay(s, 4 * 60_000).reaction.valence).toBeCloseTo(0.1);
    expect(decay(s, 3 * H).mood.confidence).toBeCloseTo(0.04);
    expect(affectView(s, "executive", { ...day, now: 30 * 60_000 }).label).toBe("neutral");
  });

  it("misses him inside the guilt dial, and the return resolves once", () => {
    const seen = run([{ kind: "his_turn", day: "d1" }]);
    const later = { ...day, now: 9 * H };
    expect(affectView(seen, "executive", later)).toMatchObject({ label: "lonely", awayHours: 9 });
    expect(affectView(seen, "companion", { ...later, guilt: "playful" }).label).toBe("sulky");
    expect(affectView(seen, "executive", { ...later, guilt: "off" }).label).toBe("neutral");
    const back = appraise(seen, { kind: "his_turn", day: "d1" }, 9 * H, 0.15).state;
    expect(affectView(back, "executive", later)).toMatchObject({
      label: "neutral",
      awayHours: null,
    });
    // Playful: a hmph for the first minute of the return reply, then glad.
    expect(affectView(back, "companion", { ...later, guilt: "playful" }).label).toBe("sulky");
    expect(
      affectView(back, "companion", { ...later, now: 9 * H + 2 * 60_000, guilt: "playful" }).label,
    ).toBe("neutral");
  });

  it("grows the bond once a day up to its cap, and it never falls because he is away", () => {
    let s = freshAffect(0);
    for (let i = 0; i < 30; i++) s = appraise(s, { kind: "his_turn", day: `d${i}` }, 0, 0.15).state;
    expect(s.bond).toBeCloseTo(0.15);
    expect(appraise(s, { kind: "his_turn", day: "d29" }, 0, 0.15).state.bond).toBeCloseTo(0.15);
    const warm = shown(s, "executive", day).warmth;
    expect(warm).toBeCloseTo(0.65);
    expect(
      shown(s, "executive", { ...day, settings: { ...day.settings, bondCap: 0 } }).warmth,
    ).toBe(0.5);
  });

  it("off and intensity 0 show the plain temperament", () => {
    const wins = run([{ kind: "praise" }]);
    expect(
      affectView(wins, "executive", { ...day, settings: { ...day.settings, enabled: false } })
        .label,
    ).toBe("neutral");
    expect(
      affectView(wins, "executive", { ...day, settings: { ...day.settings, intensity: 0 } }),
    ).toMatchObject({
      label: "neutral",
      intensity: 0,
    });
  });

  it("maps the pack's guilt to the teasing dial", () => {
    expect([0, 1, 2, 3, undefined].map(guiltOf)).toEqual([
      "off",
      "light",
      "playful",
      "playful",
      "light",
    ]);
  });

  it("puts nothing in the line at rest, and says late, never tired", () => {
    expect(moodLine(affectView(freshAffect(0), "executive", day))).toBe("");
    const late = moodLine(affectView(freshAffect(0), "executive", { ...day, hour: 23.5 }));
    expect(late).toContain("it's late");
    expect(late).toContain("never that you're tired");
    const away = moodLine(
      affectView(run([{ kind: "his_turn", day: "d1" }]), "executive", { ...day, now: 9 * H }),
    );
    expect(away).toContain("away 9 h");
    expect(away.length).toBeLessThan(400);
  });
});
