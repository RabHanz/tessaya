// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { createSessionTap, readTap, TAP_DOWN, TAP_UP } from "./sessionTap.ts";

it("writes every record in order, across flushes and the hour's file change, without blocking", async () => {
  const dir = NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tap-")), "tap");
  const tap = createSessionTap({ dir, capBytes: 1e9, maxAgeMs: 1e9, log: () => undefined });
  const at = Date.parse("2026-11-27T05:59:59Z");
  for (let i = 0; i < 50; i += 1) {
    tap.up("r1", Uint8Array.of(i), at + i * 40);
    tap.down("r1", Uint8Array.of(i, i), i * 320, at + i * 40);
    if (i % 7 === 0) void tap.drained();
  }
  await tap.drained();
  const files = NodeFS.readdirSync(dir).toSorted();
  expect(files).toEqual(["r1-20261127T05.tap", "r1-20261127T06.tap"]);
  const recs = files.flatMap((f) => readTap(NodeFS.readFileSync(NodePath.join(dir, f))));
  expect(recs.map((r) => [r.kind, r.bytes[0]])).toEqual(
    Array.from({ length: 50 }, (_, i) => [
      [TAP_UP, i],
      [TAP_DOWN, i],
    ]).flat(),
  );
  expect(NodeFS.statSync(NodePath.join(dir, files[0]!)).mode & 0o777).toBe(0o600);
});
