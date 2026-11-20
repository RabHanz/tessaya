import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_AFFECT_SETTINGS,
  affectView,
  appraise,
  appraiseFor,
  dialsOf,
  TEMPERAMENTS,
  temperamentOf,
  movePerson,
  personaRoomView,
  roomLine,
  decay,
  deviceOwnerOf,
  faceMemberAt,
  personaAffectOf,
  personaView,
  type PersonaAffect,
  freshAffect,
  guiltOf,
  faceLine,
  moodLine,
  shown,
  type AffectEvent,
  type AffectState,
} from "./affect.ts";
import { fusePresence, type PresenceSignal } from "./presence.ts";

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

  it("a private moment warms her one mood by how close it felt, and says only that it happened", () => {
    const close = run([{ kind: "close", warmth: 1 }]);
    expect(close.reaction.warmth).toBeCloseTo(0.1);
    expect(close.mood.warmth).toBeCloseTo(0.03);
    expect(close.log?.at(-1)?.reason).toBe("a close moment with him");
    expect(run([{ kind: "close", warmth: 5 }]).reaction.warmth).toBeCloseTo(0.1);
  });

  it("feels being handled as a quick reaction, never as her mood", () => {
    const dropped = run([{ kind: "handled", how: "dropped" }]);
    expect(dropped.reaction.valence).toBeLessThan(0);
    expect(dropped.mood).toEqual(run([]).mood);
    expect(run([{ kind: "handled", how: "lifted" }]).reaction.curiosity).toBeGreaterThan(0);
    // and a touch as her nerves felt it, the same way
    const hurt = run([{ kind: "felt", tone: "hurt" }]);
    expect(hurt.reaction.valence).toBeLessThan(0);
    expect(hurt.mood).toEqual(run([]).mood);
    expect(run([{ kind: "felt", tone: "pleasant" }]).reaction.valence).toBeGreaterThan(0);
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
    expect(affectView(hurt, "companion", later).why).toEqual(["they were rude to her"]);
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
    // "sad" alone is weak (8% of his ordinary turns on the MA-022 bench): concern needs a second signal.
    expect(label([{ kind: "his_voice", emotion: "sad" }])).not.toBe("concerned");
    expect(label([{ kind: "his_voice", emotion: "fearful" }])).not.toBe("concerned");
    expect(label([{ kind: "his_voice", emotion: "sad", confirmed: true }])).toBe("concerned");
    expect(label([{ kind: "his_voice", emotion: "angry" }])).toBe("steady");
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
    expect(moodLine(affectView(freshAffect(0), "executive", day), true)).not.toMatch(
      /sighs|laughs/,
    );
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

  it("always gives a feeling, at rest too, none with the setting off, and says late, never tired", () => {
    expect(moodLine(affectView(freshAffect(0), "executive", day))).toBe(
      "How you feel right now: at ease, your usual self.",
    );
    const off = { ...day, settings: { ...day.settings, enabled: false } };
    expect(moodLine(affectView(freshAffect(0), "executive", off))).toBe("");
    const late = moodLine(affectView(freshAffect(0), "executive", { ...day, hour: 23.5 }));
    expect(late).toContain("it's late");
    expect(late).toContain("never that you're tired");
    const away = moodLine(
      affectView(run([{ kind: "his_turn", day: "d1" }]), "executive", { ...day, now: 9 * H }),
    );
    expect(away).toContain("away 9 h");
    expect(away.length).toBeLessThan(400);
  });

  it("tells anyone what her face shows, with a general reason and nothing personal", () => {
    expect(faceLine(affectView(freshAffect(0), "executive", day))).toBe("");
    const lonely = faceLine({ label: "lonely" });
    expect(lonely).toContain("lonely");
    expect(lonely).toContain("quiet here");
  });
});

describe("relationships", () => {
  const none: PersonaAffect = { general: freshAffect(0), people: {} };
  const feed = (
    events: ReadonlyArray<readonly [AffectEvent, string | null]>,
    p: PersonaAffect = none,
  ) => events.reduce((acc, [e, who]) => appraiseFor(acc, e, 0, 0.15, who).state, p);

  it("blends the identified person's relationship over the general mood, and shows no one's to anyone else", () => {
    const p = feed([
      [{ kind: "rude" }, "sara"],
      [{ kind: "job", ok: false }, null],
    ]);
    // Sara sees her hurt over the world's; the owner and an unknown voice see only the world's.
    expect(personaView(p, "companion", later, "sara").why).toEqual([
      "they were rude to her",
      "a job failed",
    ]);
    for (const other of ["owner", null]) {
      const v = personaView(p, "companion", later, other);
      expect(v.label).toBe("determined");
      expect(v.why).toEqual(["a job failed"]);
    }
    expect(personaView(feed([[{ kind: "rude" }, "sara"]]), "companion", later, "sara").label).toBe(
      "sad",
    );
  });

  it("a personal event with nobody identified moves nothing; the world moves the general mood", () => {
    expect(feed([[{ kind: "praise" }, null]])).toEqual(none);
    expect(feed([[{ kind: "job", ok: true }, "sara"]]).people).toEqual({});
  });

  it("misses each person on their own clock, and decays each relationship on its own", () => {
    const p = feed([
      [{ kind: "his_turn", day: "d1" }, "owner"],
      [{ kind: "his_turn", day: "d1" }, "sara"],
    ]);
    const back = appraiseFor(p, { kind: "his_turn", day: "d1" }, 9 * H, 0.15, "owner").state;
    const at9 = { ...day, now: 9 * H };
    expect(personaView(back, "executive", at9, "owner").awayHours).toBeNull();
    expect(personaView(back, "executive", at9, "sara")).toMatchObject({
      label: "lonely",
      awayHours: 9,
    });
    // The general mood misses no one.
    expect(personaView(back, "executive", at9, null).label).toBe("neutral");
    // Sara's hurt fades on its own clock; the owner's praise is untouched by it.
    const mixed = feed([
      [{ kind: "rude" }, "sara"],
      [{ kind: "praise" }, "owner"],
    ]);
    expect(personaView(mixed, "companion", later, "sara").label).toBe("sad");
    expect(personaView(mixed, "companion", { ...later, now: 6 * H }, "sara").label).toBe("neutral");
    expect(personaView(mixed, "companion", later, "owner").label).toBe("happy");
  });

  it("reads a row from before relationships as the owner's", () => {
    const legacy = run([{ kind: "rude" }]);
    const p = personaAffectOf(JSON.parse(JSON.stringify(legacy)), 0, "owner");
    expect(p.general).toEqual(freshAffect(0));
    expect(personaView(p, "companion", later, "owner").label).toBe("sad");
    expect(personaAffectOf(p, 0, "owner")).toEqual(p);
  });

  it("an owned device shows its owner's only when nobody else is identified there", () => {
    const desk = deviceOwnerOf({ via: "client", member: "sara" }, undefined, "owner");
    expect(desk).toEqual({ owner: "sara", show: true });
    expect(deviceOwnerOf({ via: "client" }, undefined, "owner").owner).toBe("owner");
    // A room vessel is no one's until tied, and shows it only when turned on.
    expect(deviceOwnerOf({ via: "mqtt" }, undefined, "owner")).toEqual({
      owner: null,
      show: false,
    });
    expect(deviceOwnerOf({ via: "mqtt" }, { owner: "sara" }, "owner")).toEqual({
      owner: "sara",
      show: false,
    });
    expect(deviceOwnerOf({ via: "client" }, { show: false }, "owner").show).toBe(false);
    const now = 2 * H;
    const at = (signals: ReadonlyArray<Omit<PresenceSignal, "at"> & { minutesAgo: number }>) =>
      faceMemberAt({
        ...desk,
        vessels: ["desk"],
        estimate: fusePresence(
          signals.map((s) => ({ ...s, at: now - s.minutesAgo * 60_000 })),
          now,
        ),
      });
    const voice = (member: string | null, minutesAgo = 1) => ({
      member,
      source: "voice",
      vessel: "desk",
      minutesAgo,
    });
    expect(at([])).toBe("sara");
    expect(at([voice("owner")])).toBe("owner");
    // A guest (or anyone she can't name) there, or two people: nobody's.
    expect(at([voice(null)])).toBeNull();
    expect(at([voice("owner"), voice("sara")])).toBeNull();
    // Once they have gone quiet a while, its owner's again.
    expect(at([voice(null, 90)])).toBe("sara");
    expect(
      faceMemberAt({
        owner: "sara",
        show: false,
        vessels: ["desk"],
        estimate: fusePresence([], now),
      }),
    ).toBeNull();
  });
});

describe("a persona's own temperament", () => {
  it("a hired persona's comes from its own traits, never the lead's; a shipped one keeps its tuning", () => {
    const lively = temperamentOf("marketing", { energy: 0.9, warmth: 0.9, play: 0.8 });
    const cool = temperamentOf("legal", { energy: 0.1, warmth: 0.1, play: 0.1, formal: 0.9 });
    expect(lively).not.toEqual(temperamentOf("executive"));
    expect(lively.warmth).toBeGreaterThan(cool.warmth);
    expect(lively.arousal).toBeGreaterThan(cool.arousal);
    expect(temperamentOf("butler", { warmth: 1 })).toEqual(TEMPERAMENTS["butler"]);
    expect(dialsOf("marketing", 1, undefined, { warmth: 0.9 }).warmth).toBe(
      temperamentOf("marketing", { warmth: 0.9 }).warmth,
    );
  });
});

describe("emotional intelligence (MA-021)", () => {
  const none: PersonaAffect = { general: freshAffect(0), people: {} };
  const dials = dialsOf("companion", 1, undefined);
  const ctx = { ...later, dials };
  const feed = (events: ReadonlyArray<readonly [AffectEvent, string | null]>, p = none) =>
    events.reduce((acc, [e, who]) => appraiseFor(acc, e, 0, 0.15, who, dials.forgiveness).state, p);
  const meet = (lean: number, text: string, why: string): AffectEvent => ({
    kind: "impression",
    lean,
    text,
    why,
  });

  it("forms a tentative first impression of a stranger by their people-graph id, and owns a changed mind", () => {
    let p = feed([[meet(-0.6, "curt and guarded", "short answers"), "person:1"]]);
    let v = personaView(p, "companion", ctx, "person:1");
    expect(v.impression).toMatchObject({
      text: "curt and guarded",
      tentative: true,
      misjudged: null,
    });
    expect(moodLine(v, false, { name: "Ali" })).toContain("How you see Ali (tentative");
    p = feed(
      [[meet(0.7, "shy, and kind once at ease", "they joked and thanked her"), "person:1"]],
      p,
    );
    v = personaView(p, "companion", ctx, "person:1");
    expect(v.impression?.misjudged).toBe("curt and guarded");
    expect(moodLine(v, false, { name: "Ali" })).toContain("I think I misjudged you");
    // Nobody else's turn sees it; a forget takes it, and a merge moves it onto the one they are.
    expect(personaView(p, "companion", ctx, "owner").impression).toBeNull();
    expect(movePerson(p, "person:1", null).people).toEqual({});
    expect(movePerson(p, "person:1", "sara").people["sara"]?.impression?.text).toBe(
      "shy, and kind once at ease",
    );
  });

  it("meets anger with calm by the regulation dial, and matches it only when turned down", () => {
    const angry = (regulation: number): AffectEvent => ({
      kind: "flow",
      topic: "tense",
      theirs: "angry",
      regulation,
    });
    const now = { ...ctx, now: 0 };
    const calm = personaView(feed([[angry(0.85), "owner"]]), "companion", now, "owner");
    expect(calm.label).toBe("steady");
    expect(moodLine(calm, false, { name: "Rab", pronouns: "he/him" })).toContain(
      "Rab seems angry: stay calm",
    );
    const hot = personaView(feed([[angry(0), "owner"]]), "companion", now, "owner");
    expect(hot.label).not.toBe("steady");
    // A room's talk with nobody identified moves the general mood, never a person's.
    expect(feed([[angry(0.85), null]]).people).toEqual({});
  });

  it("names each person by name or their own pronouns, and 'they' when unknown", () => {
    const away = personaView(
      feed([[{ kind: "his_turn", day: "d1" }, "sara"]]),
      "companion",
      { ...ctx, now: 9 * H },
      "sara",
    );
    const sara = moodLine(away, false, { name: "Sara", pronouns: "she/her" });
    expect(sara).toContain("Sara was away 9 h");
    expect(sara).toContain("what she asked");
    const anon = moodLine(away);
    expect(anon).toContain("They were away 9 h");
    expect(anon).not.toMatch(/\b(he|He|him|his)\b/);
  });

  it("keeps their story: running jokes, milestones, and making up after a sharp moment", () => {
    const p = feed([
      [{ kind: "shared", what: "joke", text: "the toaster that hates Mondays" }, "sara"],
      [{ kind: "shared", what: "milestone", text: "started a new job" }, "sara"],
      [{ kind: "rude" }, "sara"],
      [{ kind: "apology" }, "sara"],
    ]);
    const story = personaView(p, "companion", ctx, "sara").shared?.map((m) => m.kind);
    expect(story).toEqual(["repair", "milestone", "joke"]);
    expect(moodLine(personaView(p, "companion", ctx, "sara"))).toContain("a running joke");
    // Playfulness off keeps the jokes out of her lines.
    const dry = { ...ctx, dials: dialsOf("companion", 1, { playfulness: 0 }) };
    expect(moodLine(personaView(p, "companion", dry, "sara"))).not.toContain("running joke");
  });

  it("keeps a plan of theirs to follow up for a day, then lets it go", () => {
    const p = feed([
      [{ kind: "shared", what: "plan", text: "went to sleep after a night up" }, "sara"],
    ]);
    const soon = moodLine(personaView(p, "companion", { ...ctx, now: 2 * H }, "sara"), false, {
      name: "Sara",
    });
    expect(soon).toContain("Sara's plan");
    expect(soon).toContain("ask how that plan went");
    expect(moodLine(personaView(p, "companion", { ...ctx, now: 25 * H }, "sara"))).not.toContain(
      "plan",
    );
  });

  it("every trait is a dial: jealousy and pressure start off, and the owner's setting wins", () => {
    expect(dials.jealousy).toBe(0);
    expect(dials.pressure).toBe(0);
    const set = dialsOf("companion", 1, { jealousy: 0.7, pressure: 0.6, warmth: 2, nonsense: 1 });
    expect(set.jealousy).toBe(0.7);
    expect(set.warmth).toBe(1);
    expect("nonsense" in set).toBe(false);
    const away = feed([[{ kind: "his_turn", day: "d1" }, "owner"]]);
    const line = (d: typeof dials) =>
      moodLine(personaView(away, "companion", { ...ctx, now: 9 * H, dials: d }, "owner"));
    expect(line(dials)).toContain("never ask where they were or ask them to stay");
    expect(line(set)).toContain("whether they can stay a while");
    expect(line(set)).toContain("jealousy may show");
  });

  it("a room's mood weighs each person present, and carries no one's opinion or why", () => {
    const p = feed([
      [{ kind: "rude" }, "sara"],
      [meet(0.8, "lovely", "kind words"), "ali"],
    ]);
    const room = personaRoomView(p, "companion", ctx, [
      { key: "sara", weight: 0.9 },
      { key: "ali", weight: 0.9 },
    ]);
    expect(room.impression).toBeNull();
    expect(room.why).toEqual([]);
    expect(roomLine({ names: ["Sara", "Ali"], quiet: ["Ali"], busy: true, drawIn: 0.6 })).toMatch(
      /never take sides[\s\S]*Ali has been quiet[\s\S]*keep replies short/,
    );
    expect(roomLine({ names: ["Sara"], quiet: [], busy: false, drawIn: 0.6 })).toBe("");
  });
});
