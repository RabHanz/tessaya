// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createAnomalySource } from "./anomalySource.ts";

describe("the anomaly source", () => {
  it("remembers a failing job across ticks and raises it on the third failure", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "anom-"));
    let now = 0;
    const source = createAnomalySource({ dir, now: () => now, pressure: () => null });
    let last: ReturnType<typeof source.triggers> = [];
    for (let n = 0; n < 3; n++) {
      source.triggers([{ id: `j${n}`, title: "Sync", group: "running" }], []);
      now += 60_000;
      last = source.triggers([{ id: `j${n}`, title: "Sync", group: "failed" }], []);
      now += 60_000;
    }
    expect(last.map((t) => t.kind)).toEqual(["step_repeating"]);
  });
  it("raises low disk from the pressure reader", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "anom-"));
    const source = createAnomalySource({
      dir,
      now: () => 0,
      pressure: () => ({ freeDiskGb: 1, totalDiskGb: 100, freeMemPct: 50 }),
    });
    expect(source.triggers([], []).map((t) => t.kind)).toEqual(["pressure"]);
  });
});
