import { describe, expect, it } from "vite-plus/test";

import { CAMPLUS_POLICY, cosine, decideSpeaker, enrol, type SpeakerProfile } from "./speaker.ts";

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
/** Clips of this turn, each as long as `ms`. */
const decide = (
  vectors: Float32Array[],
  ms: number,
  use: "listen" | "steer" | "act",
  profiles = [owner],
) => decideSpeaker({ clips: vectors.map((vector) => ({ vector, ms })), profiles, policy, use });

describe("decideSpeaker", () => {
  it("is unverified, never a guess, with no model, no owner profile, or too little speech", () => {
    expect(
      decideSpeaker({
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
    expect(decide([at(0.25)], 2000, "listen").kind).toBe("owner");
    expect(decide([at(0.25)], 2000, "steer").kind).toBe("owner");
    expect(decide([at(0.2)], 2000, "steer").kind).toBe("guest");
    expect(decide([at(0.45)], 2000, "act").kind).toBe("unverified");
    expect(decide([at(0.45)], 4000, "act").kind).toBe("owner");
    expect(decide([at(0.38)], 4000, "act").kind).toBe("guest");
  });

  it("averages 3 consecutive clips and uses the averaged cut-offs", () => {
    expect(decide([at(0.3), at(0.3), at(0.27)], 2000, "steer").kind).toBe("owner");
    expect(decide([at(0.3), at(0.25), at(0.25)], 2000, "steer").kind).toBe("guest");
    expect(decide([at(0.38), at(0.37), at(0.36)], 2000, "act").kind).toBe("owner");
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
    expect(decide([at(0.45)], 3000, "act")).toEqual({ kind: "unverified", why: "too-short" });
    expect(decide([at(0.45)], 4000, "act").kind).toBe("owner");
    expect(decide([at(0.38), at(0.38), at(0.38)], 2000, "act").kind).toBe("owner");
    const mixed = decideSpeaker({
      clips: [
        { vector: at(0.9), ms: 500 },
        { vector: at(0.9), ms: 500 },
        { vector: at(0.3), ms: 2000 },
      ],
      profiles: [owner],
      policy,
      use: "steer",
    });
    // One long clip and two short ones: scored as one clip, at the one-clip cut-off.
    expect(mixed).toMatchObject({ kind: "owner", score: expect.closeTo(0.3, 5) });
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
