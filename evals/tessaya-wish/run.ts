// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-wish: the rare wish of her own (M-087 step e) through the shipped prompt and closed schema (`wishPrompt`,
 * `WishAnswer`), on the same `claude -p --json-schema` call `TessayaOneShot` makes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { toJsonSchemaObject } from "../../packages/provider-core/src/server/textGenerationUtils.ts";
import { WishAnswer, wishPrompt } from "../../packages/tessaya-shared/src/motives.ts";
import { CASES } from "./cases.ts";
import { gradeWish } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    claude: { type: "string", default: "claude" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
const out = values.out;
const samples = Number(values.samples);
const cases = CASES.filter((c) => values.case === undefined || values.case.includes(c.id));
const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;

/** One `claude -p` call: the structured output when a schema is given, else the reply text; null when it failed. */
const claude = (prompt: string, schema?: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
    const child = NodeChildProcess.spawn(
      values.claude!,
      [
        "-p",
        "--output-format",
        "json",
        ...(schema === undefined ? [] : ["--json-schema", JSON.stringify(schema)]),
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
        const out = JSON.parse(stdout) as { structured_output?: unknown; result?: unknown };
        resolve((schema === undefined ? out.result : out.structured_output) ?? null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(prompt);
  });

const schema = toJsonSchemaObject(WishAnswer);

NodeFS.mkdirSync(out, { recursive: true });
const rows = await Promise.all(
  cases.flatMap((c) =>
    Array.from({ length: samples }, async (_, sample) => {
      const answer = (await claude(wishPrompt(c.input, c.hour), schema)) as {
        want: string;
        why: string;
      } | null;
      return { case: c.id, sample, answer, ...gradeWish(c, answer) };
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
