// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-read: the server's per-turn appraisal as it ships (`readPrompt` and its `TurnRead` schema, the same
 * `claude -p --json-schema` call `TessayaOneShot` makes), graded field by field.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { toJsonSchemaObject } from "../../packages/provider-core/src/server/textGenerationUtils.ts";
import { readPrompt, TurnRead } from "../../packages/tessaya-shared/src/affect.ts";
import { askClaudeJson } from "../shared/claudeJson.ts";
import { CASES } from "./cases.ts";
import { gradeRead, type ReadAnswer } from "./grade.ts";

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
const schema = JSON.stringify(toJsonSchemaObject(TurnRead));
const ask = (prompt: string) =>
  askClaudeJson<ReadAnswer>(prompt, schema, { model: values.model!, claude: values.claude! });

NodeFS.mkdirSync(out, { recursive: true });
const rows = await Promise.all(
  cases.flatMap((c) =>
    Array.from({ length: samples }, async (_, sample) => {
      const answer = await ask(
        readPrompt(c.said, c.opinion === undefined ? {} : { opinion: c.opinion }),
      );
      return { case: c.id, sample, ...gradeRead(c, answer), answer };
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
