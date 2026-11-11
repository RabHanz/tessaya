import { describe, expect, it } from "vite-plus/test";

import {
  adaptProfile,
  admits,
  CAMPLUS_POLICY,
  cosine,
  decideSpeaker,
  enrol,
  identityOf,
  speakerPath,
  UNVERIFIED,
  voiceApproval,
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

  it("sends everyone but him down the outside path", () => {
    expect(
      ["owner", "unverified", "saved", "guest"].map((k) => speakerPath(who(k as never))),
    ).toEqual(["his", "his", "outside", "outside"]);
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

  it("adapts his profile a little, and only from a confident long clip of him", () => {
    const moved = adaptProfile(owner, { vector: at(0.8), ms: 4_000 }, policy);
    expect(moved?.sources).toEqual(["wispr", "adapted"]);
    expect(cosine(moved!.centroid, owner.centroid)).toBeGreaterThan(0.999);
    expect(cosine(moved!.centroid, at(0.8))).toBeGreaterThan(cosine(owner.centroid, at(0.8)));
    expect(adaptProfile(owner, { vector: at(0.45), ms: 4_000 }, policy)).toBeNull();
    expect(adaptProfile(owner, { vector: at(0.8), ms: 2_000 }, policy)).toBeNull();
    expect(adaptProfile(sarah, { vector: v(0, 1, 0), ms: 4_000 }, policy)).toBeNull();
  });
});
