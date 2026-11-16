// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-pulse: the pulse's decision prompt (`PULSE_SYSTEM` + `pulsePrompt`, exactly what the server sends) against
 * cases where staying quiet is usually right, on the subscription through `claude -p`. Reports pass rate, the share of
 * "nothing" answers and tokens per review, so a cheaper model can be proven before it is the default.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  PULSE_ACTIONS,
  PULSE_CATEGORIES,
  PULSE_CHEAP_MODEL,
  PULSE_SYSTEM,
  pulsePrompt,
  type PulseDecision,
} from "../../packages/tessaya-shared/src/pulse.ts";
import { PULSE_CASES } from "./cases.ts";
import { gradePulse } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: PULSE_CHEAP_MODEL },
    samples: { type: "string", default: "2" },
    case: { type: "string", multiple: true },
    claude: { type: "string", default: "claude" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;
const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action: { enum: [...PULSE_ACTIONS] },
    category: { enum: [...PULSE_CATEGORIES] },
    member: { type: ["string", "null"] },
    text: { type: "string" },
    why: { type: "string" },
    about: { type: "array", items: { type: "string" } },
    remindInMinutes: { type: ["number", "null"] },
  },
  required: ["action", "category", "member", "text", "why", "about", "remindInMinutes"],
});

interface Answer {
  readonly decision: PulseDecision | null;
  readonly tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

const ask = (prompt: string): Promise<Answer> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
    const child = NodeChildProcess.spawn(
      values.claude!,
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        SCHEMA,
        "--model",
        values.model!,
        "--system-prompt",
        PULSE_SYSTEM,
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
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        const r = Array.isArray(parsed) ? parsed.findLast((m) => m.type === "result") : parsed;
        const u = r?.usage ?? {};
        resolve({
          decision: r?.structured_output ?? null,
          tokens: {
            input: u.input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          },
        });
      } catch {
        resolve({ decision: null, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
      }
    });
    child.stdin.end(prompt);
  });

NodeFS.mkdirSync(values.out, { recursive: true });
const cases = PULSE_CASES.filter((c) => values.case === undefined || values.case.includes(c.id));
const rows = [];
for (const c of cases)
  for (let s = 0; s < Number(values.samples); s++) {
    const prompt = pulsePrompt({
      digest: c.digest,
      world: {
        localTime: "Mon 11:00",
        quiet: false,
        here: ["owner: near tessel-1 (0.82)"],
        mood: "calm",
        ...c.world,
      },
      level: c.level ?? "calm",
      categories: PULSE_CATEGORIES,
      recent: [],
    });
    const answer = await ask(prompt);
    const fail = gradePulse(c, answer.decision);
    rows.push({
      id: c.id,
      sample: s,
      fail,
      action: answer.decision?.action ?? null,
      ...answer.tokens,
      promptChars: prompt.length,
    });
    console.log(
      `${fail === null ? "pass" : "FAIL"} ${c.id} #${s}: ${answer.decision?.action ?? "-"}${fail === null ? "" : ` (${fail})`}`,
    );
  }
const passed = rows.filter((r) => r.fail === null).length;
const summary = {
  model: values.model,
  passRate: passed / rows.length,
  nothingShare: rows.filter((r) => r.action === "nothing").length / rows.length,
  meanTokens: {
    input: rows.reduce((a, r) => a + r.input, 0) / rows.length,
    cacheRead: rows.reduce((a, r) => a + r.cacheRead, 0) / rows.length,
    cacheWrite: rows.reduce((a, r) => a + r.cacheWrite, 0) / rows.length,
    output: rows.reduce((a, r) => a + r.output, 0) / rows.length,
  },
  meanPromptChars: rows.reduce((a, r) => a + r.promptChars, 0) / rows.length,
};
NodeFS.writeFileSync(
  NodePath.join(values.out, "rows.ndjson"),
  rows.map((r) => JSON.stringify(r)).join("\n"),
);
NodeFS.writeFileSync(NodePath.join(values.out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
// The bar: 90% of answers right. A model below it is not the pulse's cheap model.
process.exitCode = summary.passRate >= 0.9 ? 0 : 1;
