// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-hire: "hire a persona from one sentence" (VOXTA-STUDY G9) through the shipped prompt and schema
 * (`hirePrompt`, `HireDraft`) on the same `claude -p --json-schema` call `TessayaOneShot` makes, then the shipped
 * `draftOfHire`, graded on the name, dials, description and greetings.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { toJsonSchemaObject } from "../../packages/provider-core/src/server/textGenerationUtils.ts";
import {
  draftOfHire,
  HireDraft,
  hirePrompt,
} from "../../packages/tessaya-shared/src/characterCard.ts";
import { CASES } from "./cases.ts";
import { gradeHire } from "./grade.ts";

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
const SCHEMA = JSON.stringify(toJsonSchemaObject(HireDraft));

/** One `claude -p --json-schema` call, as TessayaOneShot makes it; null when it failed. */
const claude = (prompt: string): Promise<HireDraft | null> =>
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
        resolve(
          ((JSON.parse(stdout) as { structured_output?: unknown }).structured_output ??
            null) as HireDraft | null,
        );
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(prompt);
  });

NodeFS.mkdirSync(out, { recursive: true });
const rows: Array<Record<string, unknown>> = [];
const summary: Array<{ id: string; passed: number; samples: number; pass: boolean }> = [];
for (const c of cases) {
  let passed = 0;
  for (let i = 0; i < samples; i++) {
    const hire = await claude(hirePrompt(c.sentence, c.taken ?? []));
    const draft = hire === null ? null : draftOfHire(hire);
    const misses = gradeHire(c, draft);
    if (misses.length === 0) passed++;
    rows.push({ id: c.id, sample: i, misses, draft });
    console.log(`${c.id} #${i}: ${misses.length === 0 ? "pass" : misses.join("; ")}`);
  }
  // A case fails when half or more of its samples fail.
  summary.push({ id: c.id, passed, samples, pass: passed > samples / 2 });
}
NodeFS.writeFileSync(
  NodePath.join(out, "rows.ndjson"),
  rows.map((r) => JSON.stringify(r)).join("\n"),
);
NodeFS.writeFileSync(
  NodePath.join(out, "summary.json"),
  JSON.stringify({ model: values.model, cases: summary }, null, 2),
);
console.log(
  `${summary.filter((s) => s.pass).length}/${summary.length} cases pass on ${values.model}`,
);
