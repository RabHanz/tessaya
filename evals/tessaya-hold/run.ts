// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
/**
 * tessaya-hold: the line she says while a slow answer comes (B-056), written by the server's own prompt
 * (`BRIDGE_SYSTEM`, `bridgePrompt` in packages/tessaya-shared/src/holdLine.ts) on Haiku through `claude -p`, and
 * graded by the server's own gate (`keptBridge`) plus whether it is about his words. See README.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  BRIDGE_SYSTEM,
  bridgePrompt,
  keptBridge,
} from "../../packages/tessaya-shared/src/holdLine.ts";
import { cases, gradeBridge } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    samples: { type: "string", default: "3" },
    case: { type: "string", multiple: true },
    claude: { type: "string", default: "claude" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
const samples = Number(values.samples);

const write = (prompt: string) => {
  const started = Date.now();
  const out = NodeChildProcess.spawnSync(
    values.claude,
    [
      "-p",
      "--output-format",
      "text",
      "--model",
      values.model,
      "--system-prompt",
      BRIDGE_SYSTEM,
      "--settings",
      JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
      "--tools",
      "",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
    ],
    // Outside any project, as the server's call runs, so no repository context rides along.
    { input: prompt, encoding: "utf8", timeout: 60_000, cwd: NodeOS.tmpdir() },
  );
  return { text: (out.stdout ?? "").trim(), ms: Date.now() - started };
};

const rows = [];
for (const c of cases.filter((x) => values.case === undefined || values.case.includes(x.id))) {
  const said: Array<string> = [];
  const lines: Array<{ text: string; kept: string | null; why: string | null; ms: number }> = [];
  for (let i = 0; i < samples; i++) {
    // Each sample sees the ones before as said lately, as a session does.
    const { text, ms } = write(bridgePrompt({ ...c, recent: said }));
    const kept = keptBridge(text, said, c.persona);
    if (kept !== null) said.push(kept);
    lines.push({ text, kept, why: gradeBridge(c, kept), ms });
  }
  // A line the gate refuses is silence, which is allowed; a line she says must be good, and she must say some.
  const spoken = lines.filter((l) => l.kept !== null);
  const pass = spoken.length > 0 && spoken.every((l) => l.why === null);
  rows.push({ id: c.id, pass, kept: spoken.length, lines });
  console.log(
    `${pass ? "pass" : "FAIL"}  ${c.id}: ${lines.map((l) => l.kept ?? `(${l.why})`).join(" | ")}`,
  );
}
NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(rows, null, 2));
const passed = rows.filter((r) => r.pass).length;
const kept = rows.reduce((n, r) => n + r.kept, 0);
console.log(
  `${passed} of ${rows.length} pass (${values.model}); ${kept} of ${rows.length * samples} lines kept, the rest silent`,
);
process.exit(passed === rows.length ? 0 : 1);
