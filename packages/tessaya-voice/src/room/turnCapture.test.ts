// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { createTurnCapture } from "./turnCapture.ts";

it("keeps his turns private, and drops the oldest past its size or age", () => {
  const dir = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "turncap-")),
    "turns",
  );
  let clock = Date.parse("2026-11-19T00:00:00Z");
  const capture = createTurnCapture({
    dir,
    capBytes: 3_000,
    maxAgeMs: 60_000,
    now: () => clock,
    log: () => undefined,
  });
  const meta = { text: "What time is it?", speaker: "owner", score: 0.5, overHer: false };
  capture.turn("r1-a", new Int16Array(500), { ...meta, turn: 1 });
  expect((NodeFS.statSync(dir).mode & 0o777).toString(8)).toBe("700");
  const first = NodeFS.readdirSync(dir).toSorted();
  expect(first).toHaveLength(2);
  expect((NodeFS.statSync(NodePath.join(dir, first[0]!)).mode & 0o777).toString(8)).toBe("600");
  expect(JSON.parse(NodeFS.readFileSync(NodePath.join(dir, first[0]!), "utf8"))).toMatchObject({
    turn: 1,
    speaker: "owner",
    samples: 500,
  });
  // Over the size cap: the oldest turn goes with its record.
  clock += 1_000;
  capture.turn("r1-a", new Int16Array(500), { ...meta, turn: 2 });
  clock += 1_000;
  capture.turn("r1-a", new Int16Array(500), { ...meta, turn: 3 });
  expect(NodeFS.readdirSync(dir).some((f) => f.includes("_t1."))).toBe(false);
  // Past the age limit: gone too.
  clock += 120_000;
  capture.turn("r1-a", new Int16Array(10), { ...meta, turn: 4 });
  expect(
    NodeFS.readdirSync(dir)
      .filter((f) => f.endsWith(".pcm"))
      .map((f) => f.split("_t")[1]),
  ).toEqual(["4.pcm"]);
});

it("keeps a turn it could not verify 14 days and apart: his far voice is made from his verified turns only", () => {
  const dir = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "turncap-")),
    "turns",
  );
  let clock = Date.parse("2026-11-20T00:00:00Z");
  const capture = createTurnCapture({
    dir,
    capBytes: 1_000_000,
    maxAgeMs: 30 * 86_400_000,
    now: () => clock,
    log: () => undefined,
  });
  const meta = { text: "Did you hear me?", speaker: "owner", score: 0.6, overHer: false };
  capture.turn("r1-a", new Int16Array(500).fill(1), { ...meta, turn: 1 });
  capture.turn("r1-a", new Int16Array(500).fill(2), { ...meta, turn: 2, overHer: true });
  capture.turn("r1-a", new Int16Array(500).fill(3), {
    ...meta,
    turn: 3,
    speaker: "unverified",
    score: 0.02,
    verified: false,
  });
  expect(capture.ownerClips(0).map((c) => c[0])).toEqual([1]);
  expect(capture.ownerClips(clock)).toEqual([]);
  clock += 15 * 86_400_000;
  capture.turn("r1-a", new Int16Array(500).fill(4), { ...meta, turn: 4 });
  const left = NodeFS.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted();
  expect(left.map((f) => f.replace(/^.*_t/, "t"))).toEqual(["t1.json", "t2.json", "t4.json"]);
});
