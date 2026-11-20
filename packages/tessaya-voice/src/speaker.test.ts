import { describe, expect, it } from "vite-plus/test";

import {
  adaptProfile,
  admits,
  likelyHis,
  CAMPLUS_POLICY,
  cosine,
  decideSpeaker,
  enrol,
  forWire,
  HOLD_MS,
  holdVoice,
  identityOf,
  memberByVoice,
  NO_HOLD,
  profileScore,
  profilesFor,
  REPLAY_CUT,
  replayChecked,
  speakerPath,
  teaches,
  TEST_SPEAKER_ID,
  trustTestSpeaker,
  UNVERIFIED,
  spokenYesStands,
  voiceApproval,
  withName,
  type SpeakerGate,
  type SpeakerIdentity,
  type SpeakerProfile,
} from "./speaker.ts";

const v = (...xs: number[]) => Float32Array.from(xs);
const policy = { ...CAMPLUS_POLICY, model: "m" };
const owner: SpeakerProfile = {
  id: "owner",
  name: "Robin",
  kind: "owner",
  model: "m",
  centroid: v(1, 0, 0),
  samples: 10,
  sources: ["wispr"],
  enrolledAt: "2026-11-08T00:00:00Z",
};
const sarah: SpeakerProfile = {
  ...owner,
  id: "sarah",
  name: "Sarah",
  kind: "saved",
  centroid: v(0, 1, 0),
};
/** A unit vector at this cosine to (1, 0, 0). */
const at = (c: number) => v(c, Math.sqrt(1 - c * c), 0);
const { single, averaged } = CAMPLUS_POLICY;
/** Just over and just under a cut-off, so the rows hold whatever the calibration sets. */
const over = (c: number) => at(c + 0.02);
const under = (c: number) => at(c - 0.02);
/** Clips of this turn, each as long as `ms`. */
const decide = (
  vectors: Float32Array[],
  ms: number,
  use: "listen" | "steer" | "act",
  profiles = [owner],
) =>
  decideSpeaker({
    clips: vectors.map((vector) => ({ vector, ms })),
    model: "m",
    profiles,
    policy,
    use,
  });

describe("decideSpeaker", () => {
  it("is unverified, never a guess, with no model, no owner profile, or too little speech", () => {
    expect(
      decideSpeaker({
        model: "m",
        clips: [{ vector: at(0.9), ms: 3000 }],
        profiles: [owner],
        policy: null,
        use: "steer",
      }).kind,
    ).toBe("unverified");
    expect(decide([at(0.9)], 3000, "steer", [sarah])).toEqual({
      kind: "unverified",
      why: "no-profile",
    });
    expect(decide([at(0.9)], 1500, "steer")).toEqual({ kind: "unverified", why: "too-short" });
    expect(decide([at(0.9)], 3000, "steer", [{ ...owner, model: "other" }]).kind).toBe(
      "unverified",
    );
  });

  it("holds each use to its own cut-off, and acts on one clip only when it is 4 s long", () => {
    expect(decide([over(single.listen)], 2000, "listen").kind).toBe("owner");
    expect(decide([under(single.listen)], 2000, "listen").kind).toBe("guest");
    expect(decide([over(single.steer)], 2000, "steer").kind).toBe("owner");
    expect(decide([under(single.steer)], 2000, "steer").kind).toBe("guest");
    expect(decide([over(single.act)], 2000, "act").kind).toBe("unverified");
    expect(decide([over(single.act)], 4000, "act").kind).toBe("owner");
    expect(decide([under(single.act)], 4000, "act").kind).toBe("guest");
  });

  it("averages 3 consecutive clips and uses the averaged cut-offs", () => {
    const s = averaged.steer;
    expect(decide([at(s + 0.03), at(s + 0.03), at(s - 0.01)], 2000, "steer").kind).toBe("owner");
    expect(decide([at(s + 0.03), at(s - 0.03), at(s - 0.03)], 2000, "steer").kind).toBe("guest");
    expect(
      decide([over(averaged.act), over(averaged.act), over(averaged.act)], 2000, "act").kind,
    ).toBe("owner");
  });

  it("names a saved person, and calls a near tie between two people nobody's", () => {
    expect(decide([v(0, 1, 0)], 3000, "steer", [owner, sarah])).toMatchObject({
      kind: "saved",
      name: "Sarah",
    });
    const between = Float32Array.from([0.7, 0.68, 0.2]);
    expect(decide([between], 3000, "steer", [owner, sarah]).kind).toBe("guest");
  });
});

describe("decideSpeaker fails closed", () => {
  it("never makes a broken score the owner: NaN in, a bad centroid, or vectors of another length", () => {
    expect(decide([v(Number.NaN, 0, 0)], 3000, "steer").kind).toBe("unverified");
    expect(
      decide([at(0.9)], 3000, "steer", [{ ...owner, centroid: v(Number.NaN, 0, 0) }]).kind,
    ).toBe("unverified");
    // A one-number centroid would score only the first value's sign: the owner for half of all voices.
    expect(decide([v(0.5, -0.8, 0.3)], 3000, "steer", [{ ...owner, centroid: v(1) }]).kind).toBe(
      "unverified",
    );
    expect(Number.isNaN(cosine(v(1, 0), v(1, 0, 0)))).toBe(true);
  });

  it("averages only clips of 2 s or more from this turn, and acts only on one 4 s clip or three", () => {
    expect(decide([at(0.9), at(0.9), at(0.9)], 1500, "steer")).toEqual({
      kind: "unverified",
      why: "too-short",
    });
    expect(decide([over(single.act)], 3000, "act")).toEqual({
      kind: "unverified",
      why: "too-short",
    });
    expect(decide([over(single.act)], 4000, "act").kind).toBe("owner");
    expect(
      decide([over(averaged.act), over(averaged.act), over(averaged.act)], 2000, "act").kind,
    ).toBe("owner");
    const mixed = decideSpeaker({
      model: "m",
      clips: [
        { vector: at(0.9), ms: 500 },
        { vector: at(0.9), ms: 500 },
        { vector: over(single.steer), ms: 2000 },
      ],
      profiles: [owner],
      policy,
      use: "steer",
    });
    // One long clip and two short ones: scored as one clip, at the one-clip cut-off.
    expect(mixed).toMatchObject({ kind: "owner", score: expect.closeTo(single.steer + 0.02, 5) });
  });
});

describe("profilesFor", () => {
  it("takes each person's profile for the input, else the one from her mic", () => {
    const p = (id: string, x: number) => ({
      id,
      name: id,
      kind: "saved" as const,
      model: "m",
      centroid: Float32Array.from([x]),
      samples: 3,
      sources: ["spoken" as const],
      enrolledAt: "2026-11-16T00:00:00.000Z",
    });
    const got = profilesFor([p("him", 2)], [p("him", 1), p("sara", 1)]);
    expect(got.map((g) => `${g.id}:${g.centroid[0]}`)).toEqual(["him:2", "sara:1"]);
  });
});

describe("enrol", () => {
  it("averages his clips and drops one that is someone else", () => {
    const his = [v(1, 0.1, 0), v(1, -0.1, 0), v(1, 0, 0.1), v(1, 0, -0.1), v(1, 0.05, 0.05)];
    const made = enrol([...his, v(0, 1, 0)])!;
    expect(made.kept).toBe(5);
    expect(made.dropped).toBe(1);
    expect(cosine(made.centroid, v(1, 0, 0))).toBeGreaterThan(0.99);
  });

  it("needs a few clips, and makes no profile from broken vectors", () => {
    expect(enrol([v(1, 0, 0), v(1, 0, 0)])).toBeNull();
    expect(enrol([v(1, 0, 0), v(1, 0, 0), v(Number.NaN, 0, 0)])).toBeNull();
    expect(enrol([v(1, 0, 0), v(1, 0), v(1, 0, 0)])).toBeNull();
  });
});

describe("test mode's test speaker (Director, 16 Nov)", () => {
  const clone = {
    ...UNVERIFIED(5),
    kind: "saved" as const,
    personId: TEST_SPEAKER_ID,
    name: "Test speaker",
    confidence: 0.8,
    verified: true,
  };
  it.each([
    ["on", 0, 100, { kind: "owner", personId: "owner", verified: true, test: true }],
    ["expired", 100, 100, { kind: "guest", personId: null, verified: false }],
    ["off", 0, 0, { kind: "guest", personId: null, verified: false }],
  ] as const)("is him only while test mode is %s", (_, now, until, want) => {
    const out = trustTestSpeaker(clone, now, until);
    expect(out).toMatchObject(want);
    if (want.kind === "guest") expect(out.test).toBeUndefined();
  });
  it("leaves every other voice as it was judged, and never leaves him held", () => {
    const guest = { ...UNVERIFIED(5), kind: "guest" as const, confidence: 0.2 };
    expect(trustTestSpeaker(guest, 0, 100)).toBe(guest);
    const trusted = trustTestSpeaker(clone, 0, 100);
    const after = holdVoice(NO_HOLD, trusted, 0);
    expect(after.hold).toEqual(NO_HOLD);
    expect(holdVoice(after.hold, UNVERIFIED(10), 10).identity.kind).toBe("unverified");
  });
});

describe("the speaker identity", () => {
  const owned = (vector: Float32Array, ms: number) =>
    identityOf(decide([vector], ms, "listen"), decide([vector], ms, "act"), 1);

  it("is verified only when this turn's own clip clears the act cut-off", () => {
    expect(owned(at(0.6), 4_000)).toMatchObject({
      kind: "owner",
      personId: "owner",
      verified: true,
    });
    expect(owned(at(0.6), 2_500)).toMatchObject({ kind: "owner", verified: false });
    expect(owned(at(0.05), 4_000)).toMatchObject({
      kind: "guest",
      personId: null,
      verified: false,
    });
    expect(owned(at(0.6), 1_000)).toEqual(UNVERIFIED(1));
    // No owner profile: Voice ID cannot run, the one unverified voice kept on his path.
    expect(
      identityOf(
        decideSpeaker({ clips: [], model: "m", profiles: [], policy: null, use: "listen" }),
        decideSpeaker({ clips: [], model: "m", profiles: [], policy: null, use: "act" }),
        1,
      ),
    ).toEqual({ ...UNVERIFIED(1), voiceIdOff: true });
    // His profile only from another model (a model switch before he re-enrols): closed, never "Voice ID off".
    const stale = [{ ...owner, model: "old" }];
    expect(decide([at(0.9)], 4_000, "listen", stale)).toEqual({
      kind: "unverified",
      why: "stale-profile",
    });
    expect(
      identityOf(
        decide([at(0.9)], 4_000, "listen", stale),
        decide([at(0.9)], 4_000, "act", stale),
        1,
      ),
    ).toEqual(UNVERIFIED(1));
  });

  it("keeps him verified through a session, from three owner turns or one verified, until another voice", () => {
    // His Tessel turns at 09:27-09:30 (GMT+5), 15 Nov: short ones unverified, longer ones owner under the act cut-off.
    const turns: Array<[SpeakerIdentity["kind"], number | null]> = [
      ["unverified", null],
      ["owner", 0.597],
      ["owner", 0.739],
      ["unverified", null],
      ["owner", 0.564],
      ["owner", 0.486],
      ["unverified", null],
    ];
    let hold = NO_HOLD;
    const verified = turns.map(([kind, confidence], i) => {
      const out = holdVoice(hold, { ...UNVERIFIED(i), kind, confidence }, i * 10_000);
      hold = out.hold;
      return out.identity.kind === "owner" && out.identity.verified;
    });
    expect(verified).toEqual([false, false, false, false, true, true, false]);
    // Verified by the session, never by this turn's own clips: marked so nothing private opens on it.
    expect(hold.verifiedAt).not.toBeNull();
    expect(
      holdVoice(hold, { ...UNVERIFIED(9), kind: "owner", confidence: 0.4 }, 60_000).identity,
    ).toMatchObject({ verified: true, session: true });
    // A clip that clears the act cut-off verifies him at once; anyone else ends the hold.
    const once = holdVoice(NO_HOLD, owned(at(0.6), 4_000), 0);
    expect(once.identity.verified).toBe(true);
    expect(once.identity.session).toBeUndefined();
    // Not scored yet (the early guess): his path while held, never an owner-only act.
    expect(holdVoice(once.hold, UNVERIFIED(1), HOLD_MS).identity).toMatchObject({
      kind: "owner",
      verified: false,
      lifted: true,
    });
    expect(holdVoice(once.hold, UNVERIFIED(1), HOLD_MS + 1).identity.verified).toBe(false);
    const other = holdVoice(once.hold, owned(at(0.05), 4_000), 1);
    expect(other.identity.kind).toBe("guest");
    expect(holdVoice(other.hold, UNVERIFIED(2), 2).identity.kind).toBe("unverified");
  });

  it("lifts his short and weak turns on his session's evidence, and lends it to no other voice", () => {
    // Scores from his held-out Tessel turns, 16 Nov (GMT+5 07:05 on); the intruders score as the clone and LibriSpeech do.
    const scored = (kind: SpeakerIdentity["kind"], score: number, ms: number): SpeakerIdentity => ({
      ...UNVERIFIED(0),
      kind,
      personId: kind === "owner" ? "owner" : null,
      confidence: kind === "unverified" ? null : score,
      own: { score, ms },
    });
    const turns: Array<[string, SpeakerIdentity, string]> = [
      ["her name's clip, too short alone", scored("unverified", 0.5, 1_200), "unverified"],
      ["his short first turn, on her name's clip", scored("unverified", 0.48, 1_300), "lifted"],
      ["his 2 s turn", scored("owner", 0.69, 2_400), "owner"],
      ["his short turn", scored("unverified", 0.56, 1_700), "lifted"],
      ["his weak turn", scored("guest", 0.38, 2_200), "lifted"],
      [
        "a short low blip, too short to call a change",
        scored("unverified", 0.2, 600),
        "unverified",
      ],
      ["the clone inside his session", scored("guest", 0.3, 2_300), "guest"],
      ["a short turn after it: no evidence left", scored("unverified", 0.5, 1_500), "unverified"],
    ];
    let hold = NO_HOLD;
    const seen = turns.map(([, identity], i) => {
      const out = holdVoice(hold, identity, i * 10_000);
      hold = out.hold;
      if (out.identity.lifted === true) expect(out.identity.verified).toBe(false);
      return out.identity.lifted === true ? "lifted" : out.identity.kind;
    });
    expect(seen).toEqual(turns.map(([, , want]) => want));
    // His live session on Tumble (16 Nov 12:35Z): every turn under 2 s and at 0.36-0.38; all were left unverified.
    let live = NO_HOLD;
    const his = [0.361, 0.381, 0.381].map((score, i) => {
      const out = holdVoice(live, scored("unverified", score, 1_800), i * 10_000);
      live = out.hold;
      return out.identity.lifted === true ? "lifted" : out.identity.kind;
    });
    expect(his).toEqual(["unverified", "lifted", "lifted"]);
    // A held session's evidence never lifts a turn far under it, nor a voice under the floor.
    const strong = holdVoice(
      holdVoice(NO_HOLD, scored("owner", 0.8, 3_000), 0).hold,
      scored("owner", 0.8, 3_000),
      1,
    ).hold;
    expect(holdVoice(strong, scored("unverified", 0.39, 1_500), 2).identity.kind).toBe(
      "unverified",
    );
    expect(holdVoice(strong, scored("unverified", 0.34, 1_500), 2).identity.kind).toBe(
      "unverified",
    );
    expect(holdVoice(strong, scored("unverified", 0.34, 1_500), 2).hold).toEqual(NO_HOLD);
    expect(holdVoice(strong, scored("unverified", 0.45, 1_500), HOLD_MS + 2).identity.kind).toBe(
      "unverified",
    );
  });

  it("takes his first turn on her name's clip scored with it, never a voice under the floor", () => {
    const turn = (score: number): SpeakerIdentity => ({
      ...UNVERIFIED(0),
      own: { score, ms: 1_800 },
    });
    const joined = { ...UNVERIFIED(0), kind: "owner" as const, personId: "owner", confidence: 0.5 };
    // 16 Nov 12:35Z: "What's up? Why are you crying?" scored 0.361 alone and was left unverified.
    expect(withName(turn(0.361), joined)).toMatchObject({
      kind: "owner",
      lifted: true,
      verified: false,
    });
    expect(withName(turn(0.3), joined).kind).toBe("unverified");
    expect(withName(turn(0.361), { ...joined, kind: "guest", personId: null }).kind).toBe(
      "unverified",
    );
  });

  it("hears his far voice only as him talking, from 0.45 up, and never for acting on his word", () => {
    const anchor = Float32Array.of(1, 0, 0);
    const far = Float32Array.of(0, 1, 0);
    const him = {
      id: "owner",
      name: "Owner",
      kind: "owner" as const,
      model: "m",
      centroid: anchor,
      samples: 3,
      sources: ["spoken" as const],
      enrolledAt: "",
      far,
    };
    const across = Float32Array.of(0.1, 0.9, 0);
    expect(profileScore(across, him)).toBeCloseTo(cosine(across, far));
    expect(profileScore(across, him, "act")).toBeCloseTo(cosine(across, anchor));
    // Under FAR_MIN the far voice adds nothing.
    const faint = Float32Array.of(0.9, 0.4, 0);
    expect(profileScore(faint, { ...him, far: Float32Array.of(0, 0, 1) })).toBeCloseTo(
      cosine(faint, anchor),
    );
  });

  it("hears his voice over hers at a lower cut-off while his session holds", () => {
    // 16 Nov 12:36Z: his 3 words over her voice scored 0.33 and were dropped as "not a household voice".
    expect(memberByVoice(0.33, 2)).toBe("other");
    expect(memberByVoice(0.33, 2, true)).toBe("member");
    expect(memberByVoice(0.25, 2, true)).toBe("other");
    // 20 Nov 17:15, a session he opened by her name: his 0.6 s under her audio scored 0.03 and 0.01, and she went on
    // over him. She stays paused until it is surely someone else; his 0.30 at 1.8 s stops her.
    for (const [best, seconds] of [
      [0.03, 0.6],
      [0.01, 0.6],
      [0.15, 0.6],
      [0.21, 1.2],
      [0.25, 2],
    ] as const)
      expect(memberByVoice(best, seconds, false, true)).toBe("unsure");
    expect(memberByVoice(0.3, 1.8, true, true)).toBe("member");
    expect(memberByVoice(0.1, 2, false, true)).toBe("other");
  });

  it("takes a loudspeaker for a guest and never verifies a turn the replay check could not judge", () => {
    const him: SpeakerIdentity = {
      ...UNVERIFIED(0),
      kind: "owner",
      personId: "owner",
      confidence: 0.7,
      verified: true,
      own: { score: 0.7, ms: 4_000 },
    };
    // A pass keeps its logit too, so the metrics can show how near the cut it was.
    expect(replayChecked(him, -3.5, 0)).toEqual({ ...him, replayScore: -3.5 });
    const played = replayChecked(him, 2, 0);
    expect(played).toMatchObject({
      kind: "guest",
      personId: null,
      verified: false,
      replay: "heard",
      replayScore: 2,
    });
    // A replay ends his session, so nothing it said lends evidence to the next turn.
    expect(holdVoice(holdVoice(NO_HOLD, him, 0).hold, played, 1).hold).toEqual(NO_HOLD);
    const unjudged = replayChecked(him, null, 0);
    expect(unjudged).toMatchObject({ kind: "owner", verified: false, replay: "unchecked" });
    // Not even his held session verifies it.
    const held = holdVoice(NO_HOLD, him, 0).hold;
    expect(holdVoice(held, unjudged, 1).identity.verified).toBe(false);
  });

  it("keeps his verified session through replies his profile scores low, unless the voice clearly changes", () => {
    // 17 Nov, his bedroom: verified, then replies at 0.1-0.3 to his profile that each ended his session.
    const turn = (kind: SpeakerIdentity["kind"], score: number, ms: number, vector: Float32Array) =>
      ({
        ...UNVERIFIED(0),
        kind,
        personId: kind === "owner" ? "owner" : null,
        confidence: kind === "unverified" ? null : score,
        verified: kind === "owner" && score >= 0.53 && ms >= 4_000,
        own: { score, ms, vector },
      }) as SpeakerIdentity;
    const start = holdVoice(NO_HOLD, turn("owner", 0.6, 4_000, v(1, 0, 0)), 0);
    expect(start.identity.verified).toBe(true);
    // Like his own first turn (cosine 0.8), whatever his profile says: his path, never an owner-only act.
    const reply = holdVoice(start.hold, turn("guest", 0.2, 1_800, v(0.8, 0.6, 0)), 10_000);
    expect(reply.identity).toMatchObject({ kind: "owner", lifted: true, verified: false });
    expect(reply.identity.same).toBeCloseTo(0.8);
    // His own turns in the session carry their likeness to it too, so the metrics show it on every turn.
    const ownTurn = holdVoice(start.hold, turn("owner", 0.6, 4_000, v(0.6, 0.8, 0)), 5_000);
    expect(ownTurn.identity.same).toBeCloseTo(0.6);
    expect(start.identity.same).toBeUndefined();
    // Neither like him nor clearly not (0.3): not his, and his session waits.
    const unsure = holdVoice(reply.hold, turn("guest", 0.2, 1_800, v(0.3, 0.954, 0)), 20_000);
    expect(unsure.identity.kind).toBe("guest");
    expect(unsure.hold.verifiedAt).toBe(10_000);
    // Another voice (0.1 to his pieces) ends it, so nothing of his reaches the turns after it.
    const other = holdVoice(unsure.hold, turn("guest", 0.2, 1_800, v(0.1, 0.995, 0)), 30_000);
    expect(other.hold).toEqual(NO_HOLD);
    expect(holdVoice(other.hold, turn("guest", 0.2, 1_800, v(1, 0, 0)), 40_000).identity.kind).toBe(
      "guest",
    );
    // A session never verified lends nothing, and a loudspeaker is a guest however like him it sounds.
    const unheld = holdVoice(NO_HOLD, turn("owner", 0.46, 2_000, v(1, 0, 0)), 0);
    expect(holdVoice(unheld.hold, turn("guest", 0.2, 1_800, v(1, 0, 0)), 1).identity.kind).toBe(
      "guest",
    );
    const played = replayChecked(turn("guest", 0.2, 1_800, v(1, 0, 0)), 2, REPLAY_CUT);
    expect(holdVoice(start.hold, played, 10_000).identity.kind).toBe("guest");
  });

  it("teaches the room profile only from turns it is sure of, never a replay, a guest or a short turn", () => {
    const him = (more: Partial<SpeakerIdentity>): SpeakerIdentity => ({
      ...UNVERIFIED(0),
      kind: "owner",
      personId: "owner",
      own: { score: 0.4, ms: 2_000, vector: v(1, 0, 0) },
      ...more,
    });
    expect(teaches(him({ verified: true }))).toBe("verified");
    expect(teaches(him({ verified: true, session: true }))).toBe("session");
    expect(teaches(him({ lifted: true, same: 0.6 }))).toBe("continuity");
    expect(teaches(him({ lifted: true, same: 0.45 }))).toBeNull();
    expect(teaches(him({ lifted: true }))).toBeNull();
    expect(teaches(him({}))).toBeNull();
    expect(teaches(him({ verified: true, replay: "unchecked" }))).toBeNull();
    expect(teaches(him({ verified: true, test: true }))).toBeNull();
    expect(
      teaches(him({ verified: true, own: { score: 0.6, ms: 1_000, vector: v(1) } })),
    ).toBeNull();
    expect(teaches({ ...him({}), kind: "guest", personId: null })).toBeNull();
    // The embedding never leaves the device with the identity.
    expect(forWire(him({})).own).toEqual({ score: 0.4, ms: 2_000 });
  });

  it("scores a clip against a person's room centroid too, the better of the two", () => {
    const roomed = { ...owner, room: v(0, 1, 0) };
    expect(profileScore(v(0, 1, 0), owner)).toBe(0);
    expect(profileScore(v(0, 1, 0), roomed)).toBe(1);
    expect(
      decideSpeaker({
        clips: [{ vector: v(0, 1, 0), ms: 4_000 }],
        model: "m",
        profiles: [roomed],
        policy,
        use: "act",
      }).kind,
    ).toBe("owner");
  });

  const who = (kind: SpeakerIdentity["kind"], more: Partial<SpeakerIdentity> = {}) => ({
    ...UNVERIFIED(0),
    kind,
    ...more,
  });
  const gate: SpeakerGate = {
    respondToOthers: false,
    offSilencesSaved: false,
    savedBarge: false,
    strictWhenUnavailable: false,
  };

  it.each([
    // kind, gate change, turn, barge
    ["owner", {}, true, true],
    ["saved", {}, true, false],
    ["saved", { offSilencesSaved: true }, false, false],
    ["saved", { savedBarge: true }, true, true],
    ["guest", {}, false, false],
    ["guest", { respondToOthers: true }, true, false],
    ["unverified", {}, true, true],
    ["unverified", { strictWhenUnavailable: true }, false, false],
  ] as const)("lets %s in with %j: turn %s, barge %s", (kind, change, turn, barge) => {
    expect(admits(who(kind), { ...gate, ...change }, "turn")).toBe(turn);
    expect(admits(who(kind), { ...gate, ...change }, "barge")).toBe(barge);
  });

  it("answers a voice just under the bar in his own session as likely him, never a replay, never outside it", () => {
    const low = (confidence: number, more: Partial<SpeakerIdentity> = {}) =>
      who("guest", { confidence, ...more });
    // 20 Nov, the new case: his words read under the listen bar and were ignored.
    expect(admits(likelyHis(low(0.3), true), gate, "turn")).toBe(true);
    expect(likelyHis(low(0.3), true).kind).toBe("unverified");
    expect(speakerPath(likelyHis(low(0.3), true))).toBe("outside");
    expect(likelyHis(low(0.3), false).kind).toBe("guest");
    expect(likelyHis(low(0.1), true).kind).toBe("guest");
    expect(likelyHis(low(0.3, { replay: "heard" }), true).kind).toBe("guest");
  });

  it("sends everyone but him down the outside path, an unjudged voice too where Voice ID runs", () => {
    expect(
      ["owner", "unverified", "saved", "guest"].map((k) => speakerPath(who(k as never))),
    ).toEqual(["his", "outside", "outside", "outside"]);
    expect(speakerPath({ ...who("unverified"), voiceIdOff: true })).toBe("his");
  });

  it("never lets a voice alone approve a risky act, and counts only his verified voice as a factor", () => {
    const him = who("owner", { verified: true });
    expect(voiceApproval(him, "risky", true)).toEqual({ voiceFactor: true, cardRequired: true });
    expect(voiceApproval(him, "ordinary", true)).toEqual({
      voiceFactor: true,
      cardRequired: false,
    });
    expect(voiceApproval(him, "ordinary", false).cardRequired).toBe(true);
    expect(
      voiceApproval(who("owner", { verified: true, inherited: true }), "ordinary", true),
    ).toEqual({
      voiceFactor: false,
      cardRequired: false,
    });
    expect(voiceApproval(who("saved", { verified: true }), "ordinary", true)).toEqual({
      voiceFactor: false,
      cardRequired: true,
    });
    expect(voiceApproval(who("unverified"), "ordinary", true).cardRequired).toBe(true);
  });

  it("takes a yes too short to judge as the voice of the turn it answers, never one judged as someone else's", () => {
    const turn = who("owner", { verified: true });
    // 2026-11-12: "Yes." at 1.2 s came back unverified, and the card waited with nothing said.
    expect(spokenYesStands(who("unverified"), turn, "ordinary", true)).toBe(true);
    expect(spokenYesStands(who("unverified"), who("guest"), "ordinary", true)).toBe(false);
    expect(spokenYesStands(who("unverified"), null, "ordinary", true)).toBe(false);
    expect(spokenYesStands(who("guest"), turn, "ordinary", true)).toBe(false);
    expect(spokenYesStands(who("unverified"), turn, "risky", true)).toBe(false);
    expect(spokenYesStands(who("unverified"), turn, "ordinary", false)).toBe(false);
  });

  it("adapts his profile a little, and only from a confident long clip of him", () => {
    const moved = adaptProfile(owner, { vector: at(0.8), ms: 4_000 }, policy);
    expect(moved?.sources).toEqual(["wispr", "adapted"]);
    expect(cosine(moved!.centroid, owner.centroid)).toBeGreaterThan(0.999);
    expect(cosine(moved!.centroid, at(0.8))).toBeGreaterThan(cosine(owner.centroid, at(0.8)));
    expect(adaptProfile(owner, { vector: at(0.45), ms: 4_000 }, policy)).toBeNull();
    expect(adaptProfile(owner, { vector: at(0.8), ms: 2_000 }, policy)).toBeNull();
    // Every member's copy refines on the device that hears them, not only his.
    expect(adaptProfile(sarah, { vector: v(0, 1, 0), ms: 4_000 }, policy)?.base).toEqual(
      sarah.centroid,
    );
  });

  it("never lets a device's refinements take a profile far from the shared one", () => {
    let mine: SpeakerProfile | null = owner;
    let steps = 0;
    // The same confident clip over and over walks the copy towards it, until the cap stops it.
    while (mine !== null && steps < 1_000) {
      const next = adaptProfile(mine, { vector: at(0.8), ms: 4_000 }, policy);
      if (next === null) break;
      mine = next;
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
    expect(cosine(mine!.centroid, owner.centroid)).toBeGreaterThanOrEqual(0.92);
    expect(mine!.base).toEqual(owner.centroid);
  });
});
