import { describe, expect, it } from "vite-plus/test";

import { turnLineFor } from "@t3tools/tessaya-shared/people";

import { placeVoice, splitTwo, suggestionsFor, VOICE_RULES } from "./peopleGraph.ts";

/** A unit vector at exactly `score` cosine to unit `a`, along the axis orthogonal to it. */
const at = (a: Float32Array, score: number, axis: number): Float32Array => {
  const o = new Float32Array(a.length);
  o[axis] = 1;
  const along = a[axis]!;
  const orth = o.map((x, i) => x - along * a[i]!);
  const n = Math.hypot(...orth);
  return a.map((x, i) => score * x + Math.sqrt(1 - score * score) * (orth[i]! / n));
};
const basis = (i: number, dim = 16) => {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
};

describe("where a stranger's voice goes (Voice ID's CAM++ cut-offs)", () => {
  const ali = { id: "ali", status: "guest" as const, centroid: basis(0), samples: 5 };
  it("joins at the steer cut-off, asks from the listen cut-off, else is someone new", () => {
    expect(VOICE_RULES).toMatchObject({ join: 0.45, suggest: 0.36 });
    expect(placeVoice(at(basis(0), 0.46, 3), [ali])).toMatchObject({ kind: "join", id: "ali" });
    expect(placeVoice(at(basis(0), 0.4, 3), [ali])).toMatchObject({
      kind: "new",
      near: { id: "ali" },
    });
    expect(placeVoice(at(basis(0), 0.3, 3), [ali])).toEqual({ kind: "new", near: null });
    expect(placeVoice(basis(1), [])).toEqual({ kind: "new", near: null });
  });
});

describe("what the owner is asked", () => {
  const node = (id: string, v: Float32Array, extra = {}) => ({
    id,
    status: "unknown" as const,
    centroid: v,
    samples: 3,
    heard: 1,
    split: null,
    ...extra,
  });
  it("asks about alike voices and voices heard often, never two members or a pair he set apart", () => {
    const a = basis(0);
    const b = at(a, 0.4, 2);
    const out = suggestionsFor(
      [node("a", a), node("b", b), node("c", basis(5), { heard: 3 })],
      new Set(),
    );
    expect(out.map((s) => s.kind)).toEqual(["same", "name"]);
    expect(suggestionsFor([node("a", a), node("b", b)], new Set(["a|b"]))).toEqual([]);
    expect(
      suggestionsFor(
        [node("a", a, { status: "member" }), node("b", b, { status: "member" })],
        new Set(),
      ),
    ).toEqual([]);
    expect(
      suggestionsFor([node("tv", a, { status: "not_person" }), node("b", b)], new Set()),
    ).toEqual([]);
  });

  it("splits a voice whose clips are two people, and leaves one voice whole", () => {
    const two = [basis(0), at(basis(0), 0.8, 2), basis(5), at(basis(5), 0.8, 7)];
    const parts = splitTwo(two)!;
    expect([...parts.a, ...parts.b].sort()).toEqual([0, 1, 2, 3]);
    expect(parts.score).toBeLessThan(VOICE_RULES.suggest);
    const one = [basis(0), at(basis(0), 0.8, 2), at(basis(0), 0.8, 3), at(basis(0), 0.8, 4)];
    expect(splitTwo(one)!.score).toBeGreaterThan(VOICE_RULES.suggest);
    expect(splitTwo(two.slice(0, 3))).toBeNull();
  });
});

describe("her line for the voice she hears", () => {
  const ali = {
    name: "Ali",
    status: "guest" as const,
    relations: ["the owner's cousin"],
    firstSeen: "2026-11-03T10:00:00.000Z",
    lastSeen: "2026-11-12T10:00:00.000Z",
    topics: [{ at: "2026-11-12T10:00:00.000Z", said: "my new job starts Monday" }],
    impression: "warm, funny",
  };
  it("loads a recognised person's context, and nothing of theirs for a claim the voice doesn't back", () => {
    const known = turnLineFor(ali, { recognised: true, askName: false });
    expect(known).toContain("it is Ali");
    expect(known).toContain("the owner's cousin");
    expect(known).toContain("my new job starts Monday");
    expect(known).toContain("never to be said: warm, funny");
    const claimed = turnLineFor(ali, { recognised: false, askName: false });
    expect(claimed).not.toContain("new job");
    expect(claimed).not.toContain("cousin");
    expect(claimed).not.toContain("warm");
  });

  it("asks a new voice's name only when allowed, and ignores a TV", () => {
    const fresh = { ...ali, name: null, status: "unknown" as const, topics: [], relations: [] };
    expect(turnLineFor(fresh, { recognised: true, askName: true })).toContain("What's your name?");
    expect(turnLineFor(fresh, { recognised: true, askName: false })).toContain("Don't ask");
    expect(
      turnLineFor({ ...fresh, status: "not_person" }, { recognised: true, askName: true }),
    ).toContain("TV");
  });
});
