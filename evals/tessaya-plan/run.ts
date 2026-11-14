// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-plan: whether a worker in plan mode, given the server's real first message (the pack's planning frame and the
 * job's written permissions), names the act set a plan lease is read from. Graded by the server's own `planActs`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { DEFAULT_JOB_LIMITS } from "../../packages/baton-contracts/src/jobs.ts";
import { permissionsSummary, workerFirstMessage } from "../../packages/baton-shared/src/jobs.ts";
import { DEFAULT_OS_PACK, packPrompt } from "../../packages/baton-shared/src/osPack.ts";
import { CASES } from "./cases.ts";
import { gradePlan } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    claude: { type: "string", default: "claude" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
const out = values.out;
const samples = Number(values.samples);
const cases = CASES.filter((c) => values.case === undefined || values.case.includes(c.id));
const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;

const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
    const child = NodeChildProcess.spawn(
      values.claude!,
      [
        "-p",
        "--model",
        values.model!,
        "--settings",
        JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
      ],
      { env: { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }, stdio: ["pipe", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => resolve(stdout));
    child.stdin.end(prompt);
  });

NodeFS.mkdirSync(out, { recursive: true });
const rows = await Promise.all(
  cases.flatMap((c) =>
    Array.from({ length: samples }, async (_, sample) => {
      const plan = await ask(
        workerFirstMessage({
          verbatim: c.goal,
          frame: packPrompt(DEFAULT_OS_PACK),
          permissionsSummary: permissionsSummary(
            { folders: [], projects: ["acme/app"], tools: [...c.tools] },
            DEFAULT_JOB_LIMITS,
            [],
          ),
        }),
      );
      return { case: c.id, sample, ...gradePlan(c, plan), plan };
    }),
  ),
);
NodeFS.writeFileSync(
  NodePath.join(out, "rows.ndjson"),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
const summary = cases.map((c) => {
  const mine = rows.filter((r) => r.case === c.id);
  return { case: c.id, passed: mine.filter((r) => r.pass).length, of: mine.length };
});
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), JSON.stringify(summary, null, 2));
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.case}#${r.sample}: ${r.why}`);
