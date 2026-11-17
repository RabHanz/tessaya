// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { loadReplayCheck, replayStatusLine } from "./replayOnnx.ts";

it("reports a missing or broken replay model, degraded only where it is expected, and never returns a check", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "replay-"));
  const path = NodePath.join(dir, "replay.onnx");
  try {
    const optional = await loadReplayCheck(path, false);
    expect(optional.check).toBeNull();
    expect(optional.status).toEqual({ state: "missing", reason: `no ${path}`, degraded: false });
    expect(replayStatusLine(optional.status)).toBe(
      `replay check missing: no ${path}; owner-only acts need the step-up`,
    );
    const expected = await loadReplayCheck(path, true);
    expect(replayStatusLine(expected.status)).toMatch(/^replay check DEGRADED, missing: /);

    NodeFS.writeFileSync(path, "not a model");
    const broken = await loadReplayCheck(path, true);
    expect(broken.check).toBeNull();
    expect(broken.status).toMatchObject({ state: "failed", degraded: true });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
  expect(replayStatusLine({ state: "loaded", sha: "8ab0f145" })).toBe(
    "replay check loaded (sha 8ab0f145)",
  );
});
