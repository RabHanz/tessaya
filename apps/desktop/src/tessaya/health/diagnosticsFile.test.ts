// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeDiagnosticsFile } from "./diagnosticsFile.ts";

describe("the diagnostics file", () => {
  it("holds timings and the lifecycle but none of his words, tokens or addresses", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "diag-"));
    const logDir = NodePath.join(root, "logs");
    NodeFS.mkdirSync(logDir);
    NodeFS.writeFileSync(
      NodePath.join(logDir, "voice-turns.ndjson"),
      `${JSON.stringify({ kind: "agent_turn", totalMs: 3707, said: "secret plans for Ann", reply: "ok" })}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(logDir, "baton-lifecycle.ndjson"),
      `${JSON.stringify({ event: "start", version: "0.1.34" })}\n`,
    );
    const settings = NodePath.join(root, "settings.json");
    NodeFS.writeFileSync(
      settings,
      JSON.stringify({ claudeToken: "sk-abcdefghijklmnopqrstuv", appearance: "dark" }),
    );
    const file = makeDiagnosticsFile({
      stateDir: root,
      logDir,
      version: "0.1.34",
      settingsFile: settings,
      now: new Date("2026-11-02T10:00:00Z"),
    });
    const text = NodeFS.readFileSync(file, "utf8");
    expect(text).toContain('"totalMs":3707');
    expect(text).toContain('"event":"start"');
    expect(text).toContain('"appearance": "dark"');
    expect(text).not.toMatch(/secret plans|Ann|sk-abc/);
    expect(NodePath.basename(file)).toBe("tessaya-diagnostics-2026-11-02-10-00-00.txt");
  });
});
