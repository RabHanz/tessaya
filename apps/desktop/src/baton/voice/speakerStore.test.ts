// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { createSpeakerStore, speakersPath } from "./speakerStore.ts";

const profile = (id: string, kind: "owner" | "saved") => ({
  id,
  name: id,
  kind,
  model: "m",
  centroid: Float32Array.from([0.6, 0.8]),
  samples: 5,
  sources: ["spoken" as const],
  enrolledAt: "2026-11-08T00:00:00Z",
});

it("keeps profiles as vectors in a private file, and forgets one when it is deleted", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "speakers-"));
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
  NodeFS.writeFileSync(speakersPath(dir), "not json");
  expect(store.list()).toEqual([]);
  NodeFS.rmSync(dir, { recursive: true, force: true });
});
