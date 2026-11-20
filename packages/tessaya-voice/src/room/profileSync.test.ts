// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createSpeakerStore } from "../speakerStore.ts";
import { createProfileSync, parseShared } from "./profileSync.ts";

const vec = (...xs: number[]) => {
  const v = Float32Array.from(xs);
  let n = 0;
  for (const x of v) n += x * x;
  return Float32Array.from(v, (x) => x / Math.sqrt(n));
};
const b64 = (v: Float32Array) => Buffer.from(v.buffer).toString("base64");
const shared = (version: number, v: Float32Array, model = "m1") =>
  JSON.stringify({
    id: "member-1",
    name: "Rab",
    kind: "owner",
    model,
    centroid: b64(v),
    samples: 6,
    version,
    updatedAt: "2026-11-13T10:00:00Z",
  });

const rig = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "profile-sync-"));
  const store = createSpeakerStore(dir);
  const sync = createProfileSync({
    store,
    file: NodePath.join(dir, "voice", "shared.json"),
    model: "m1",
    log: () => undefined,
  });
  return { dir, store, sync, done: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
};

describe("enrol once, recognised everywhere: shared profiles and this R1's refinement", () => {
  it("takes a newer shared version as the base, ignores an older one or another model, and clears a member", () => {
    const r = rig();
    // His enrolment made on this R1, before the shared one arrives: replaced, never kept beside it.
    const local = {
      id: "owner",
      name: "Owner",
      kind: "owner",
      model: "m1",
      centroid: vec(1, 0, 0),
      samples: 5,
      sources: ["spoken"],
      enrolledAt: "2026-11-13T09:00:00Z",
    } as const;
    r.store.save(local);
    expect(r.sync.localOnly().map((p) => p.id)).toEqual(["owner"]);
    expect(r.sync.shared(parseShared(shared(2, vec(1, 0, 0)))!)).toBe(true);
    expect(r.store.list().map((p) => p.id)).toEqual(["member-1"]);
    // Only an enrolment made here is sent home at start; a shared one is the home's already.
    expect(r.sync.localOnly()).toEqual([]);
    expect(r.sync.shared(parseShared(shared(1, vec(0, 1, 0)))!)).toBe(false);
    expect(r.sync.shared(parseShared(shared(3, vec(0, 1, 0), "other"))!)).toBe(false);
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual([1, 0, 0]);
    expect(parseShared("not json")).toBeNull();
    r.sync.clear("member-1");
    expect(r.store.list()).toEqual([]);
    r.done();
  });

  it("refines its own copy 2% toward a sure turn, never far from the base, not when switched off; a reset or a new version restarts it", () => {
    const r = rig();
    r.sync.shared(parseShared(shared(1, vec(1, 0, 0)))!);
    r.sync.refine("member-1", vec(0.9, 0.3, 0));
    const once = r.store.list()[0]!.centroid;
    expect(once[1]!).toBeGreaterThan(0);
    expect(once[1]!).toBeLessThan(0.02);
    expect(r.store.list()[0]!.sources).toContain("adapted");
    // Far from the base: many nudges stop before it drifts past the cap.
    for (let i = 0; i < 500; i += 1) r.sync.refine("member-1", vec(0, 1, 0));
    expect(r.store.list()[0]!.centroid[0]!).toBeGreaterThanOrEqual(0.969);
    // A damaged turn (no length, or not a number) never moves it.
    const settled = Array.from(r.store.list()[0]!.centroid);
    r.sync.refine("member-1", Float32Array.from([0, 0, 0]));
    r.sync.refine("member-1", Float32Array.from([Number.NaN, 0, 0]));
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual(settled);
    r.sync.reset();
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual([1, 0, 0]);
    expect(r.store.list()[0]!.sources).not.toContain("adapted");
    r.sync.refine("member-1", vec(0.9, 0.3, 0));
    r.sync.setRefining(false);
    const before = Array.from(r.store.list()[0]!.centroid);
    r.sync.refine("member-1", vec(0.9, 0.3, 0));
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual(before);
    r.sync.shared(parseShared(shared(2, vec(1, 0, 0)))!);
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual([1, 0, 0]);
    r.done();
  });

  it("learns a room profile on its mic from sure turns, versioned, never far from the enrolled one, and resets it", () => {
    const r = rig();
    r.sync.shared(parseShared(shared(1, vec(1, 0, 0)))!);
    const learn = (v: Float32Array, at: number) =>
      r.sync.learn("member-1", v, { at, how: "verified", score: 0.6, ms: 3_000 });
    // Too few sure turns: none yet.
    for (let i = 0; i < 11; i += 1) learn(vec(0.8, 0.6, i % 2 === 0 ? 0.05 : -0.05), i);
    expect(r.sync.room("member-1")).toBeUndefined();
    learn(vec(0.8, 0.6, 0), 11);
    const room = r.sync.room("member-1")!;
    expect(room[1]!).toBeGreaterThan(0.5);
    // Kept beside the enrolled centroid, and what made it is on disk.
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual([1, 0, 0]);
    const file = JSON.parse(
      NodeFS.readFileSync(NodePath.join(r.dir, "voice", "room.json"), "utf8"),
    );
    expect(file["member-1"].version).toBe(1);
    expect(file["member-1"].samples[11]).toMatchObject({ at: 11, how: "verified" });
    expect(file["member-1"].versions[0]).toMatchObject({ version: 1, samples: 12 });
    // Someone else's turns, however many, never become a room profile far from the enrolled one.
    for (let i = 0; i < 200; i += 1) {
      learn(vec(0, 0.2, 1), 100 + i);
      expect(r.sync.room("member-1")![0]!).toBeGreaterThanOrEqual(0.6);
    }
    // A reset, switched off, or the member gone: dropped, or nothing learnt.
    r.sync.reset();
    expect(r.sync.room("member-1")).toBeUndefined();
    r.sync.setRefining(false);
    for (let i = 0; i < 12; i += 1) learn(vec(0.8, 0.6, 0), i);
    expect(r.sync.room("member-1")).toBeUndefined();
    r.sync.setRefining(true);
    for (let i = 0; i < 12; i += 1) learn(vec(0.8, 0.6, 0), i);
    expect(r.sync.room("member-1")).toBeDefined();
    r.sync.clear("member-1");
    expect(r.sync.room("member-1")).toBeUndefined();
    r.done();
  });

  it("keeps a far voice near the shared base, measured against that base and not this R1's moved copy", () => {
    const r = rig();
    r.sync.shared(parseShared(shared(1, vec(1, 0, 0)))!);
    // His copy here has moved (refined), but the bar stays the shared base.
    r.store.save({ ...r.store.list()[0]!, centroid: vec(0.7, 0.7, 0) });
    r.sync.setFar("member-1", vec(0.2, 1, 0), 10, 5);
    expect(r.sync.far("member-1")).toBeUndefined();
    r.sync.setFar("member-1", vec(0.8, 0.5, 0), 10, 5);
    expect(r.sync.far("member-1")).toBeDefined();
    expect(r.sync.learning()).toEqual([{ id: "member-1", roomSamples: 0, farClips: 10, farAt: 5 }]);
    // Forgetting what was learnt clears it with the room profile.
    r.sync.reset();
    expect(r.sync.far("member-1")).toBeUndefined();
    r.done();
  });
});
