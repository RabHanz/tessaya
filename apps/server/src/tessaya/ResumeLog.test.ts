// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { appendResumeLog } from "./ResumeLog.ts";

it("writes one JSON line per step and creates the logs folder", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "resume-log-"));
  const file = NodePath.join(dir, "logs", "baton-resume.ndjson");
  appendResumeLog(file, { event: "import-done", outcome: "ok", sessionId: "s", ms: 5 });
  const [line] = NodeFS.readFileSync(file, "utf8").trim().split("\n");
  expect(JSON.parse(line!)).toMatchObject({ source: "server", outcome: "ok", sessionId: "s" });
});
