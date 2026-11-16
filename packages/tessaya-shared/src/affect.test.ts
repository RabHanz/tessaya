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
/** Past a flash's hold (the hurt after a rude word lasts 90 s). */
const later = { ...day, now: 2 * 60_000 };
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

  it("meets how his voice sounds: warmer when he sounds low, nothing from a label it doesn't know", () => {
    // 15 Nov: the room heard his emotion and the server threw it away.
    expect(run([{ kind: "his_voice", emotion: "sad" }]).reaction.warmth).toBeCloseTo(0.15);
    expect(run([{ kind: "his_voice", emotion: "happy" }]).reaction.valence).toBeCloseTo(0.1);
    expect(run([{ kind: "his_voice", emotion: "other" }]).reaction).toEqual(run([]).reaction);
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
    // His next turn inside that minute ends it: the hmph never outlasts the reply it was for.
    const next = appraise(back, { kind: "his_turn", day: "d1" }, 9 * H + 20_000, 0.15).state;
    expect(
      affectView(next, "companion", { ...later, now: 9 * H + 20_000, guilt: "playful" }).label,
    ).toBe("neutral");
  });

  it("meets how he treats her: rudeness hurts (sad, never frustrated at him), sorry and warmth lift it", () => {
    const hurt = run([{ kind: "rude" }]);
    // The face shows a short hurt, then the low mood under it; she can say why.
    expect(affectView(hurt, "companion", day).label).toBe("hurt");
    expect(affectView(hurt, "companion", later).label).toBe("sad");
    expect(affectView(hurt, "companion", later).why).toEqual(["he was rude to her"]);
    expect(affectView(run([{ kind: "rude" }, { kind: "apology" }]), "companion", day).label).toBe(
      "happy",
    );
    // However hurt, his sorry lets the reaction go and halves the low mood.
    const low = run([{ kind: "rude" }, { kind: "rude" }]);
    expect(affectView(low, "executive", later).label).toBe("sad");
    const sorry = run([{ kind: "apology" }], low);
    expect(sorry.reaction.valence).toBeCloseTo(0.15);
    expect(sorry.mood.valence).toBeCloseTo(-0.05);
    expect(affectView(run([{ kind: "warmth" }]), "companion", day).label).toBe("happy");
    // A sorry to a happy mood takes nothing away from it.
    expect(run([{ kind: "apology" }], run([{ kind: "praise" }])).mood.valence ?? 0).toBe(0);
  });

  it("holds labels from real events: jobs failing build to cross at the world, his low voice to concern", () => {
    const fail = { kind: "job", ok: false } as const;
    const label = (events: ReadonlyArray<AffectEvent>, s?: AffectState) =>
      affectView(run(events, s), "executive", day).label;
    expect(label([fail])).toBe("determined");
    expect(label([fail, fail])).toBe("frustrated");
    expect(label([fail, fail, fail, fail])).toBe("angry");
    expect(label([fail, fail, { kind: "job", ok: true }])).not.toBe("frustrated");
    // An hour on, old failures no longer count.
    expect(
      affectView(run([fail], run([fail, fail]), 2 * H), "executive", { ...day, now: 2 * H }).label,
    ).toBe("determined");
    expect(label([{ kind: "his_voice", emotion: "sad" }])).toBe("concerned");
    expect(label([{ kind: "rude" }, { kind: "apology" }])).not.toBe("hurt");
    const why = affectView(run([fail, fail]), "executive", day);
    expect(why.intensity).toBeGreaterThanOrEqual(0.7);
    expect(why.why).toEqual(["a job failed"]);
  });

  it("sounds the mood out loud only, through the shared stage directions", () => {
    const sad = affectView(run([{ kind: "rude" }]), "companion", later);
    expect(moodLine(sad, true)).toContain("*sighs*");
    expect(moodLine(sad)).not.toContain("*sighs*");
    expect(moodLine(affectView(run([{ kind: "warmth" }]), "companion", day), true)).toContain(
      "[laughs]",
    );
    expect(moodLine(affectView(freshAffect(0), "executive", day), true)).toBe("");
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
