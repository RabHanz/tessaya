// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-lines: the wordings her brain writes ahead for each moment (`linesPrompt`, the server's TessayaExpression),
 * on the subscription through `claude -p`, graded by the server's own gate and for variety. `--write-pool` also folds
 * the kept wordings into the shipped offline pool (packages/tessaya-shared/src/expressionPool.json).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  EXPRESSION_GESTURES,
  EXPRESSION_MOODS,
} from "../../packages/tessaya-contracts/src/expression.ts";
import {
  LINE_EVENT_IDS,
  isLineEvent,
  lineId,
  linesPrompt,
  type Line,
  type LineEvent,
} from "../../packages/tessaya-shared/src/expression.ts";
import { DEFAULT_OS_PACK } from "../../packages/tessaya-shared/src/osPack.ts";
import { gradeMoment, summarize, type MomentGrade, type Written } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "sonnet" },
    persona: { type: "string", multiple: true },
    event: { type: "string", multiple: true },
    per: { type: "string", default: "12" },
    samples: { type: "string", default: "1" },
    "write-pool": { type: "boolean", default: false },
    "pool-size": { type: "string", default: "40" },
    claude: { type: "string", default: "claude" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
const out = values.out;
const per = Number(values.per);
const samples = Number(values.samples);
const poolSize = Number(values["pool-size"]);
const personas = DEFAULT_OS_PACK.personas.filter((p) =>
  (values.persona ?? ["executive", "butler"]).includes(p.id),
);
const events = (values.event ?? LINE_EVENT_IDS).filter(isLineEvent);
const POOL_FILE = NodePath.join(
  import.meta.dirname,
  "../../packages/tessaya-shared/src/expressionPool.json",
);
// Her words are persona speech: the subscription, never a metered key (BRAIN-DESIGN §13).
const METERED =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          event: { type: "string" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                mood: { enum: [...EXPRESSION_MOODS] },
                gesture: { enum: [...EXPRESSION_GESTURES] },
              },
              required: ["text", "mood", "gesture"],
            },
          },
        },
        required: ["event", "lines"],
      },
    },
  },
  required: ["moments"],
});

const ask = (prompt: string): Promise<{ moments: Array<{ event: string; lines: Written[] }> }> =>
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
        const parsed = JSON.parse(stdout);
        const result = Array.isArray(parsed) ? parsed.findLast((m) => m.type === "result") : parsed;
        resolve(result?.structured_output ?? { moments: [] });
      } catch {
        resolve({ moments: [] });
      }
    });
    child.stdin.end(prompt);
  });

const pool: Record<string, Partial<Record<LineEvent, Array<Line>>>> = JSON.parse(
  NodeFS.readFileSync(POOL_FILE, "utf8"),
);
NodeFS.mkdirSync(out, { recursive: true });
const rows: Array<MomentGrade & { persona: string; sample: number }> = [];
const BATCH = 8;

for (const persona of personas) {
  for (let sample = 0; sample < samples; sample++) {
    const batches: Array<ReadonlyArray<LineEvent>> = [];
    for (let i = 0; i < events.length; i += BATCH) batches.push(events.slice(i, i + BATCH));
    const results = await Promise.all(
      batches.map((batch) =>
        ask(
          linesPrompt({
            persona,
            events: batch,
            perEvent: per,
            avoid: Object.fromEntries(
              batch.map((e) => [e, (pool[persona.id]?.[e] ?? []).map((l) => l.text).slice(-8)]),
            ),
          }),
        ).then((r) => ({ batch, r })),
      ),
    );
    for (const { batch, r } of results) {
      for (const event of batch) {
        const written = r.moments.find((m) => m.event === event)?.lines ?? [];
        const grade = gradeMoment(event, per, written);
        rows.push({ ...grade, persona: persona.id, sample });
        if (values["write-pool"]) {
          const held = (pool[persona.id] ??= {})[event] ?? [];
          const seen = new Set(held.map((l) => lineId(event, l.text)));
          const add = grade.kept.filter((k) => !seen.has(lineId(event, k.text)));
          pool[persona.id]![event] = [...held, ...add].slice(0, poolSize);
        }
      }
    }
    console.log(`${persona.id} sample ${sample + 1}/${samples} done`);
  }
}

const summary = summarize(rows);
NodeFS.writeFileSync(
  NodePath.join(out, "moments.ndjson"),
  rows.map((r) => JSON.stringify({ ...r, kept: r.kept.map((k) => k.text) })).join("\n") + "\n",
);
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
if (values["write-pool"]) NodeFS.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
