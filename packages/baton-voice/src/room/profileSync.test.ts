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
  return { store, sync, done: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
};

describe("enrol once, recognised everywhere: shared profiles and this R1's refinement", () => {
  it("takes a newer shared version as the base, ignores an older one or another model, and clears a member", () => {
    const r = rig();
    // His enrolment made on this R1, before the shared one arrives: replaced, never kept beside it.
    r.store.save({
      id: "owner",
      name: "Owner",
      kind: "owner",
      model: "m1",
      centroid: vec(1, 0, 0),
      samples: 5,
      sources: ["spoken"],
      enrolledAt: "2026-11-13T09:00:00Z",
    });
    expect(r.sync.shared(parseShared(shared(2, vec(1, 0, 0)))!)).toBe(true);
    expect(r.store.list().map((p) => p.id)).toEqual(["member-1"]);
    expect(r.sync.shared(parseShared(shared(1, vec(0, 1, 0)))!)).toBe(false);
    expect(r.sync.shared(parseShared(shared(3, vec(0, 1, 0), "other"))!)).toBe(false);
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual([1, 0, 0]);
    expect(parseShared("not json")).toBeNull();
    r.sync.clear("member-1");
    expect(r.store.list()).toEqual([]);
    r.done();
  });

  it("refines its own copy 2% toward a sure turn, never far from the base, not when switched off, and a new version restarts it", () => {
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
    r.sync.setRefining(false);
    const before = Array.from(r.store.list()[0]!.centroid);
    r.sync.refine("member-1", vec(0.9, 0.3, 0));
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual(before);
    r.sync.shared(parseShared(shared(2, vec(1, 0, 0)))!);
    expect(Array.from(r.store.list()[0]!.centroid)).toEqual([1, 0, 0]);
    r.done();
  });
});
