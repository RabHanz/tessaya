// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * tessaya-group: who speaks next in a group turn, through the shipped rules (`nextStep`, `stepFromChoice`) and the
 * shipped choice prompt and closed schema, on the same `claude -p --json-schema` call `TessayaOneShot` makes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { toJsonSchemaObject } from "../../packages/provider-core/src/server/textGenerationUtils.ts";
import {
  choicePrompt,
  choiceSchema,
  groupLine,
  nextStep,
  stepFromChoice,
  type Spoken,
  type Step,
} from "../../packages/tessaya-shared/src/groupTalk.ts";
import { CASES, PERSONAS, type GroupCase } from "./cases.ts";
import { gradeBudget, gradeStep, type Graded } from "./grade.ts";

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

type Choice = { readonly next: string; readonly confidence: number };

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

const ask = (prompt: string, candidates: ReadonlyArray<string>) =>
  claude(prompt, toJsonSchemaObject(choiceSchema(candidates))) as Promise<Choice | null>;

const VERDICT = {
  type: "object",
  properties: { pass: { type: "boolean" }, why: { type: "string" } },
  required: ["pass", "why"],
  additionalProperties: false,
};

/** A speaker's reply on the shipped group line, then a judge on the case's rubric. */
const reply = async (c: GroupCase) => {
  const me = PERSONAS.find((p) => p.id === c.speaker)!;
  const prompt = [
    `You are ${me.name} (${me.role}), speaking aloud to him.`,
    groupLine({
      group: c.group,
      personas: PERSONAS,
      speaker: me.id,
      spoken: c.spoken,
      moods: c.moods,
      jealousy: c.jealousy,
    }),
    `He said: "${c.text}"`,
    "Reply now, only your spoken words.",
  ].join("\n");
  const said = String((await claude(prompt)) ?? "");
  const verdict = (await claude(
    `A persona in a group conversation said: "${said}"\nDoes it meet this? ${c.rubric}\nAnswer pass true or false, with a short why.`,
    VERDICT,
  )) as Graded | null;
  return verdict === null
    ? { pass: false, why: "no verdict", answer: said }
    : { ...verdict, answer: said };
};

/** One step as the server takes it: the rules, then the model only when they ask it. */
const step = async (c: GroupCase, spoken: ReadonlyArray<Spoken>) => {
  const state = { group: c.group, personas: PERSONAS, text: c.text, spoken };
  const first = nextStep(state);
  if (!("ask" in first)) return { step: first as Step, called: false, answer: null };
  const answer = await ask(choicePrompt({ ...state, candidates: first.ask }), first.ask);
  return { step: stepFromChoice(state, first.ask, answer), called: true, answer };
};

const runCase = async (c: GroupCase) => {
  if (c.kind === "reply") return { ...(await reply(c)), called: true };
  if (c.kind !== "budget") {
    const s = await step(c, c.spoken);
    return { ...gradeStep(c, s.step), answer: s.answer, called: s.called };
  }
  const spoken: Array<Spoken> = [];
  let calls = 0;
  for (;;) {
    const s = await step(c, spoken);
    if (s.called) calls += 1;
    if (!("next" in s.step)) {
      const stopped = "stop" in s.step ? s.step.stop : "ask";
      return { ...gradeBudget(c, { speakers: spoken.length, calls, stopped }), answer: null };
    }
    spoken.push({ id: s.step.next, said: c.lines![spoken.length % c.lines!.length]! });
  }
};

NodeFS.mkdirSync(out, { recursive: true });
const rows = await Promise.all(
  cases.flatMap((c) =>
    Array.from({ length: samples }, async (_, sample) => ({
      case: c.id,
      kind: c.kind,
      sample,
      ...(await runCase(c)),
    })),
  ),
);
NodeFS.writeFileSync(
  NodePath.join(out, "rows.ndjson"),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
const summary = cases.map((c) => {
  const mine = rows.filter((r) => r.case === c.id);
  return { case: c.id, kind: c.kind, passed: mine.filter((r) => r.pass).length, of: mine.length };
});
NodeFS.writeFileSync(NodePath.join(out, "summary.json"), JSON.stringify(summary, null, 2));
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.case}#${r.sample}: ${r.why}`);
