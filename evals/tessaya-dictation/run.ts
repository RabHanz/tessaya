// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-dictation: Tessaya's own clean-up (prompt, checker and one retry, as `cleanDictation` runs them) on made-up
 * dictations shaped like his real misses. Code-graded: the text must come from the model, with the words each case needs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  cleanDictation,
  rewriteMessage,
  rewriteSystemPrompt,
} from "../../packages/tessaya-shared/src/dictationCleanup.ts";
import { parseVocabulary } from "../../packages/tessaya-shared/src/vocabulary.ts";
import { CASES } from "./cases.ts";

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

const ask = (system: string, message: string): Promise<string> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !METERED.test(k)));
    const child = NodeChildProcess.spawn(
      values.claude!,
      [
        "-p",
        "--model",
        values.model!,
        "--system-prompt",
        system,
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
    child.on("close", () => resolve(stdout.trim()));
    child.stdin.end(message);
  });

NodeFS.mkdirSync(out, { recursive: true });
const rows = await Promise.all(
  cases.flatMap((c) =>
    Array.from({ length: samples }, async (_, sample) => {
      const dictionary = parseVocabulary(c.dictionary ?? []);
      const system = rewriteSystemPrompt(dictionary);
      const cleaned = await cleanDictation({
        raw: c.heard,
        mode: "default",
        level: "claude",
        dictionary,
        always: true,
        ...(c.context === undefined ? {} : { context: c.context }),
        ask: (text, mode, refused) =>
          ask(system, rewriteMessage(text, mode, c.context ?? {}, [], refused)),
      });
      const missing = c.must.filter((w) => !cleaned.text.includes(w));
      const kept = c.never.filter((w) => cleaned.text.toLowerCase().includes(w.toLowerCase()));
      const why =
        cleaned.stage !== "model"
          ? `${cleaned.stage}: ${cleaned.why ?? ""}`
          : [...missing.map((w) => `missing "${w}"`), ...kept.map((w) => `kept "${w}"`)].join(", ");
      return { case: c.id, sample, pass: why === "", why, text: cleaned.text };
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
for (const r of rows)
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.case}#${r.sample}: ${r.why || r.text}`);
