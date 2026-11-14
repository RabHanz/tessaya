// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

import { markPhase, startStallWatch, WATCH_SOURCE } from "./mainStall.ts";

it("the watcher program is valid and markers are harmless before the watch starts", () => {
  expect(() => new NodeVM.Script(WATCH_SOURCE)).not.toThrow();
  expect(() => markPhase("anything", { a: 1 })).not.toThrow();
});

it("a late tick names the phases still open, not only the last marker", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stall-"));
  const file = NodePath.join(dir, "lifecycle.ndjson");
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers({ now: 0 });
  const watch = startStallWatch({ file, version: "t", limitMs: 1e9, slowMs: 1e9 });
  try {
    markPhase("home-build:begin");
    markPhase("speech-model-ensure:begin");
    markPhase("home-build:end");
    markPhase("model-hash:begin");
    vi.setSystemTime(1_500);
    vi.advanceTimersByTime(1_000);
    const slow = NodeFS.readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry["event"] === "main-slow");
    expect(slow).toMatchObject({
      lateMs: 1_500,
      phase: "model-hash:begin",
      open: ["speech-model-ensure", "model-hash"],
    });
  } finally {
    watch.stop();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
