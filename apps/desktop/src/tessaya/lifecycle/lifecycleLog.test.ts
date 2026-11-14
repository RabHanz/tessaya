// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { classifyLeftover, createLifecycleLog } from "./lifecycleLog.ts";

const lines = (file: string) =>
  NodeFS.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the lifecycle log", () => {
  it("records a start, says why it is going down, and flags a run that left no clean exit", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-life-"));
    const file = NodePath.join(dir, "life.ndjson");
    const running = NodePath.join(dir, "running.json");
    const first = createLifecycleLog({ file, runningFile: running, version: "0.1.5" });
    expect(first.previousRunEndedBadly()).toBe(false);
    first.willExitFor("update", "to 0.1.6");
    expect(lines(file).map((l) => l["event"])).toEqual(["start", "exiting"]);
    expect(lines(file)[1]).toMatchObject({ reason: "update", detail: "to 0.1.6" });
    // The first run never reached a clean exit (the running file is still there), so this start says so.
    // The same version again, with no clean exit between: that is a bad end.
    const second = createLifecycleLog({ file, runningFile: running, version: "0.1.5" });
    expect(second.previousRunEndedBadly()).toBe(true);
    expect(lines(file).some((l) => l["event"] === "previous-run-ended-badly")).toBe(true);
    // A new version over it is the update.
    createLifecycleLog({ file, runningFile: running, version: "0.1.6" });
    expect(lines(file).some((l) => l["event"] === "replaced-by-update")).toBe(true);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a second launch while the first is running", () => {
  it("is not a crash, and leaves the running marker to its owner", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-life-"));
    const file = NodePath.join(dir, "life.ndjson");
    const running = NodePath.join(dir, "running.json");
    NodeFS.writeFileSync(
      running,
      JSON.stringify({ at: "2026-11-03T10:00:00.000Z", pid: 99_999_999, version: "0.1.5" }),
    );
    const second = createLifecycleLog({
      file,
      runningFile: running,
      version: "0.1.5",
      isAlive: () => true,
    });
    expect(second.previousRunEndedBadly()).toBe(false);
    expect(lines(file).map((l) => l["event"])).toEqual(["another-instance-running"]);
    expect(JSON.parse(NodeFS.readFileSync(running, "utf8")).pid).toBe(99_999_999);
    // The same marker with that process gone is a bad end.
    const third = createLifecycleLog({
      file,
      runningFile: running,
      version: "0.1.5",
      isAlive: () => false,
    });
    expect(third.previousRunEndedBadly()).toBe(true);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

describe("what a leftover marker means", () => {
  it("is an update when the version has changed, and a bad end only when it has not", () => {
    expect(classifyLeftover(null, "0.1.18")).toEqual({ kind: "none" });
    expect(classifyLeftover({ version: "0.1.15" }, "0.1.18")).toEqual({
      kind: "replaced-by-update",
      from: "0.1.15",
      to: "0.1.18",
    });
    expect(classifyLeftover({ version: "0.1.18" }, "0.1.18")).toEqual({ kind: "ended-badly" });
    expect(classifyLeftover({}, "0.1.18")).toEqual({ kind: "ended-badly" });
  });
});
