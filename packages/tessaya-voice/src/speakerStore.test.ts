// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  createSpeakerStore,
  profileFromWire,
  profileToWire,
  speakersPath,
} from "./speakerStore.ts";

const profile = (
  id: string,
  kind: "owner" | "saved",
  centroid = Float32Array.from([0.6, 0.8]),
) => ({
  id,
  name: id,
  kind,
  model: "m",
  centroid,
  samples: 5,
  sources: ["spoken" as const],
  enrolledAt: "2026-11-08T00:00:00Z",
});

const inTemp = (test: (dir: string) => void) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "speakers-"));
  try {
    test(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

it("keeps profiles as vectors in a private file, and forgets one when it is deleted", () =>
  inTemp((dir) => {
    const store = createSpeakerStore(dir);
    expect(store.list()).toEqual([]);
    store.save(profile("owner", "owner"));
    store.save(profile("sarah", "saved"));
    expect(Array.from(store.list().find((p) => p.id === "owner")!.centroid)).toEqual([
      Float32Array.from([0.6])[0],
      Float32Array.from([0.8])[0],
    ]);
    // Windows has no POSIX modes to check.
    if (NodePath.sep === "/") expect(NodeFS.statSync(speakersPath(dir)).mode & 0o777).toBe(0o600);
    store.remove("sarah");
    expect(store.list().map((p) => p.id)).toEqual(["owner"]);
  }));

it("sets an unreadable file aside instead of writing over it, and never loads a damaged vector", () =>
  inTemp((dir) => {
    const store = createSpeakerStore(dir);
    store.save(profile("owner", "owner"));
    NodeFS.writeFileSync(speakersPath(dir), "not json");
    expect(store.list()).toEqual([]);
    expect(
      NodeFS.readdirSync(NodePath.join(dir, "voice")).some((f) =>
        f.startsWith("speakers.json.corrupt-"),
      ),
    ).toBe(true);
    store.save(profile("broken", "owner", Float32Array.from([Number.NaN, 1])));
    expect(store.list()).toEqual([]);
  }));

it("keeps a device's copy over the shared profile, and sends only the shared part home", () =>
  inTemp((dir) => {
    const store = createSpeakerStore(dir);
    const shared = Float32Array.from([0.6, 0.8]);
    const refined = {
      ...profile("owner", "owner", Float32Array.from([0.8, 0.6])),
      base: shared,
      version: 3,
    };
    store.save({ ...refined, sources: ["spoken", "adapted"] });
    const kept = store.list()[0]!;
    expect([Array.from(kept.base!), kept.version]).toEqual([Array.from(shared), 3]);
    const wire = profileToWire(kept);
    expect(wire.sources).toEqual(["spoken"]);
    expect(Array.from(profileFromWire({ ...wire, version: 3 })!.centroid)).toEqual(
      Array.from(shared),
    );
    expect(profileFromWire({ ...wire, centroid: "!!", version: 1 })).toBeNull();
  }));
