import { describe, expect, it } from "vite-plus/test";

import { CAMPLUS_POLICY, type SpeakerProfile } from "../speaker.ts";
import { voicesOf } from "./segments.ts";

const RATE = 16_000;
const policy = { ...CAMPLUS_POLICY, model: "m" };
const profile = (id: string, centroid: number[]): SpeakerProfile => ({
  id,
  name: id,
  kind: id === "owner" ? "owner" : "saved",
  model: "m",
  centroid: Float32Array.from(centroid),
  samples: 10,
  sources: ["spoken"],
  enrolledAt: "2026-11-13T00:00:00Z",
});
const owner = profile("owner", [1, 0, 0, 0]);
const sara = profile("sara", [0, 1, 0, 0]);
const adam = profile("adam", [0, 0, 1, 0]);
/** Each voice is a sample value; "both" is owner and Sara at once, "guest" nobody enrolled. */
const VALUE = { owner: 1_000, sara: 2_000, adam: 3_000, both: 4_000, guest: 5_000 } as const;
const VECTOR: Record<number, number[]> = {
  1_000: [1, 0, 0, 0],
  2_000: [0, 1, 0, 0],
  3_000: [0, 0, 1, 0],
  4_000: [1, 1, 0, 0],
  5_000: [0, 0, 0, 1],
};
/** A mixture's vector is the sum of its voices, weighted by how long each speaks in the window. */
const embed = async (pcm: Int16Array) => {
  const out = new Float32Array(4);
  for (const s of pcm) VECTOR[s]?.forEach((x, i) => (out[i] = out[i]! + x));
  return out.some((x) => x !== 0) ? out : null;
};
const turn = (...parts: Array<[keyof typeof VALUE | "quiet", number]>) => {
  const pcm = new Int16Array(parts.reduce((n, [, ms]) => n + (ms * RATE) / 1000, 0));
  let at = 0;
  for (const [who, ms] of parts) {
    const n = (ms * RATE) / 1000;
    if (who !== "quiet") pcm.fill(VALUE[who], at, at + n);
    at += n;
  }
  return pcm;
};
const run = (pcm: Int16Array, profiles = [owner, sara, adam]) =>
  voicesOf({ pcm, embed, profiles, policy, at: 0 });

describe("who spoke when in one turn", () => {
  it("leaves one voice, or a home with one profile, exactly as today", async () => {
    expect(await run(turn(["owner", 5_000]))).toEqual({ kind: "one" });
    let calls = 0;
    const counted = await voicesOf({
      pcm: turn(["owner", 3_000], ["sara", 3_000]),
      embed: async (p) => ((calls += 1), embed(p)),
      profiles: [owner],
      policy,
      at: 0,
    });
    expect(counted).toEqual({ kind: "one" });
    expect(calls).toBe(0);
  });

  it("splits two people taking turns at the pause between them, each span only their own voice", async () => {
    for (const split of [3_000, 2_800, 3_250, 3_400]) {
      const pcm = turn(["owner", split], ["quiet", 200], ["sara", 6_000 - split]);
      const voices = await run(pcm);
      expect(voices.kind).toBe("many");
      if (voices.kind !== "many") return;
      expect(voices.spans.map((s) => s.identity.personId)).toEqual(["owner", "sara"]);
      for (const span of voices.spans) {
        const heard = new Set(
          pcm.subarray((span.startMs * RATE) / 1000, (span.endMs * RATE) / 1000),
        );
        heard.delete(0);
        expect([...heard]).toEqual([VALUE[span.identity.personId as "owner" | "sara"]]);
        expect(span.identity.verified).toBe(false);
      }
    }
  });

  it("asks for one at a time when two voices run into each other with no pause to cut at", async () => {
    expect(await run(turn(["owner", 3_000], ["both", 1_000], ["sara", 3_000]))).toEqual({
      kind: "one-at-a-time",
      why: "overlap",
    });
    expect(await run(turn(["owner", 3_000], ["sara", 3_000]))).toEqual({
      kind: "one-at-a-time",
      why: "overlap",
    });
  });

  it("asks for one at a time when three voices meet, or when too little can be named", async () => {
    expect(
      await run(turn(["owner", 1_500], ["sara", 1_000], ["adam", 1_500], ["owner", 1_500])),
    ).toEqual({ kind: "one-at-a-time", why: "three-voices" });
    expect(
      await run(turn(["owner", 1_500], ["guest", 6_000], ["sara", 1_500]), [owner, sara]),
    ).toEqual({ kind: "one-at-a-time", why: "unsure" });
  });
});
