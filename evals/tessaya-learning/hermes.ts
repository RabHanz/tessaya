// @effect-diagnostics nodeBuiltinImport:off
/**
 * A Hermes Agent baseline rebuilt from its code (NousResearch/hermes-agent @ ae3707b9): frozen MEMORY.md and USER.md,
 * a 60-character skill index, and a background review on its 10-turn and 10-call counters with its own prompts.
 * Where it differs, it favours Hermes: the owner's correction is always inside the reviewed session (README).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { reviewSkill } from "../../packages/baton-shared/src/skillReview.ts";
import { runClaude } from "./agent.ts";
import type { Arm } from "./arms.ts";
import {
  COMBINED_REVIEW_PROMPT,
  MEMORY_REVIEW_PROMPT,
  SKILL_REVIEW_PROMPT,
  SKILLS_INDEX_HEAD,
  SKILLS_INDEX_TAIL,
} from "./hermesPrompts.ts";

export const MEMORY_CHAR_LIMIT = 2_200;
export const USER_CHAR_LIMIT = 1_375;
export const NUDGE_INTERVAL = 10;
export const SKILL_DESC_LIMIT = 60;
const DELIM = "\n§\n";

interface Skill {
  readonly category: string;
  readonly description: string;
  readonly body: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface HermesState {
  readonly memory: ReadonlyArray<string>;
  readonly user: ReadonlyArray<string>;
  readonly skills: Readonly<Record<string, Skill>>;
  readonly turnsSinceMemory: number;
  readonly itersSinceSkill: number;
}

export const emptyHermes = (): HermesState => ({
  memory: [],
  user: [],
  skills: {},
  turnsSinceMemory: 0,
  itersSinceSkill: 0,
});

const render = (entries: ReadonlyArray<string>, title: string, limit: number) => {
  if (entries.length === 0) return "";
  const used = entries.join(DELIM).length;
  return `${"═".repeat(46)}\n${title} [${Math.round((used / limit) * 100)}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars]\n${entries.join(DELIM)}`;
};

/** The frozen snapshot and the skills index, as the session's system prompt carries them. */
export const hermesPrompt = (s: HermesState): string => {
  const byCategory = new Map<string, string[]>();
  for (const [name, skill] of Object.entries(s.skills))
    byCategory.set(skill.category, [
      ...(byCategory.get(skill.category) ?? []),
      `- ${name}: ${skill.description}`,
    ]);
  const index = [...byCategory].flatMap(([c, rows]) =>
    byCategory.size === 1 && rows.length === 1
      ? rows.map((r) => `  ${r}`)
      : [`  ${c}:`, ...rows.map((r) => `    ${r}`)],
  );
  return [
    render(s.memory, "MEMORY (your personal notes)", MEMORY_CHAR_LIMIT),
    render(s.user, "USER PROFILE (who the user is)", USER_CHAR_LIMIT),
    index.length === 0
      ? ""
      : `${SKILLS_INDEX_HEAD.replace("{basic}", "Bash, Read")}${index.join("\n")}\n${SKILLS_INDEX_TAIL}\nHere, skill_view(name) means reading .hermes/skills/<name>/SKILL.md (and its files) with the Read tool.`,
  ]
    .filter((x) => x !== "")
    .join("\n\n");
};

/** Hermes scans memory content for injection and exfiltration before it is written. */
const unsafe = (text: string) =>
  reviewSkill({ name: "m", description: "", body: text, allowedTools: null }, text).some(
    (f) => f.level === "high",
  );

interface MemoryOp {
  readonly target?: unknown;
  readonly action?: unknown;
  readonly content?: unknown;
  readonly old_text?: unknown;
}
interface SkillOp {
  readonly action?: unknown;
  readonly name?: unknown;
  readonly category?: unknown;
  readonly description?: unknown;
  readonly body?: unknown;
  readonly old_string?: unknown;
  readonly new_string?: unknown;
  readonly file_path?: unknown;
  readonly content?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The memory tool: the whole batch applies or none of it does. */
export const applyMemoryOps = (s: HermesState, ops: ReadonlyArray<MemoryOp>): HermesState => {
  let memory = [...s.memory];
  let user = [...s.user];
  for (const op of ops) {
    const target = op.target === "user" ? "user" : "memory";
    const list = target === "user" ? user : memory;
    const content = str(op.content).trim();
    const old = str(op.old_text);
    if (op.action === "add") {
      if (content === "" || unsafe(content)) return s;
      if (!list.includes(content)) list.push(content);
    } else if (op.action === "replace" || op.action === "patch") {
      const at = list.findIndex((e) => old !== "" && e.includes(old));
      if (at < 0 || content === "" || unsafe(content)) return s;
      list[at] = content;
    } else if (op.action === "remove") {
      const at = list.findIndex((e) => old !== "" && e.includes(old));
      if (at < 0) return s;
      list.splice(at, 1);
    }
    if (target === "user") user = list;
    else memory = list;
  }
  if (memory.join(DELIM).length > MEMORY_CHAR_LIMIT || user.join(DELIM).length > USER_CHAR_LIMIT)
    return s;
  return { ...s, memory, user };
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** skill_manage in a review: create, patch and write_file; atomic; never a delete. */
export const applySkillOps = (s: HermesState, ops: ReadonlyArray<SkillOp>): HermesState => {
  const skills: Record<string, Skill> = { ...s.skills };
  for (const op of ops) {
    const name = str(op.name);
    if (!SLUG.test(name)) return s;
    const had = skills[name];
    if (op.action === "create") {
      const description = str(op.description).trim();
      const body = str(op.body).trim();
      if (had !== undefined || description === "" || body === "") return s;
      if (description.length > SKILL_DESC_LIMIT) return s;
      skills[name] = { category: str(op.category) || "general", description, body, files: {} };
    } else if (op.action === "patch") {
      const from = str(op.old_string);
      if (had === undefined || from === "" || !had.body.includes(from)) return s;
      skills[name] = { ...had, body: had.body.replace(from, str(op.new_string)) };
    } else if (op.action === "write_file") {
      const path = str(op.file_path);
      if (had === undefined || !/^(references|templates|scripts|assets)\/[\w.-]+$/.test(path))
        return s;
      skills[name] = { ...had, files: { ...had.files, [path]: str(op.content) } };
    } else return s;
  }
  return { ...s, skills };
};

const REVIEW_TAIL = `

You can only call memory and skill management tools. Other tools will be denied at runtime — do not attempt them.

In this review your tool calls are written as one JSON object, which is the whole of your reply:
{"memory": [{"target": "memory"|"user", "action": "add"|"replace"|"remove", "content": "...", "old_text": "..."}],
 "skills": [{"action": "create", "name": "...", "category": "...", "description": "<= 60 chars", "body": "SKILL.md body"},
            {"action": "patch", "name": "...", "old_string": "...", "new_string": "..."},
            {"action": "write_file", "name": "...", "file_path": "references/<topic>.md", "content": "..."}]}
Empty lists mean "Nothing to save."`;

/** Hermes's aux-model digest of the session: older turns short, tool calls named, the rest verbatim. */
const digest = (input: {
  readonly goal: string;
  readonly steps: ReadonlyArray<string>;
  readonly results: ReadonlyArray<string>;
  readonly final: string;
  readonly feedback: string;
}) =>
  [
    `USER: ${input.goal}`,
    ...input.steps.flatMap((step, i) => [
      `ASSISTANT[tools: ${step}]`,
      `TOOL: ${(input.results[i] ?? "").slice(0, 1200)}`,
    ]),
    `ASSISTANT: ${input.final}`,
    ...(input.feedback === ""
      ? []
      : [`USER: ${input.feedback}`, "ASSISTANT: Understood — I'll get that right next time."]),
  ].join("\n");

export const hermes = (model: string, cwd: string): Arm => {
  let state = emptyHermes();
  return {
    id: "hermes",
    system: () => hermesPrompt(state),
    prepare: (_job, work) => {
      for (const [name, skill] of Object.entries(state.skills)) {
        const dir = NodePath.join(work, ".hermes", "skills", name);
        NodeFS.mkdirSync(dir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: "${skill.description}"\n---\n${skill.body}\n`,
        );
        for (const [path, text] of Object.entries(skill.files)) {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(dir, path), text);
        }
      }
    },
    learn: async (job, run, outcome) => {
      const userTurns = outcome.feedback === "" ? 1 : 2;
      const iters = run.steps.length + 1 + (userTurns - 1);
      const turns = state.turnsSinceMemory + userTurns;
      const reviewMemory = turns >= NUDGE_INTERVAL;
      const reviewSkills = state.itersSinceSkill + iters >= NUDGE_INTERVAL;
      state = {
        ...state,
        turnsSinceMemory: reviewMemory ? 0 : turns,
        itersSinceSkill: reviewSkills ? 0 : state.itersSinceSkill + iters,
      };
      if (!run.ok || (!reviewMemory && !reviewSkills)) return { tokens: 0, costUsd: 0 };
      const prompt =
        reviewMemory && reviewSkills
          ? COMBINED_REVIEW_PROMPT
          : reviewMemory
            ? MEMORY_REVIEW_PROMPT
            : SKILL_REVIEW_PROMPT;
      const library = Object.entries(state.skills).map(([name, s]) => ({
        name,
        category: s.category,
        description: s.description,
        "SKILL.md": s.body,
        files: s.files,
      }));
      const review = await runClaude({
        cwd,
        model,
        tools: false,
        system: `${hermesPrompt(state)}\n\nThe conversation:\n${digest({ goal: job.goal, steps: run.steps, results: run.results, final: run.final, feedback: outcome.feedback })}`,
        prompt: `${prompt}${REVIEW_TAIL}\n\nskills_list and skill_view, as you would have called them: ${JSON.stringify(library)}${reviewMemory ? `\n\nMEMORY.md entries: ${JSON.stringify(state.memory)}\nUSER.md entries: ${JSON.stringify(state.user)}` : ""}`,
      });
      let ops: { memory?: unknown; skills?: unknown } = {};
      try {
        ops = JSON.parse(/\{[\s\S]*\}/.exec(review.final)?.[0] ?? "{}") as typeof ops;
      } catch {
        ops = {};
      }
      if (reviewMemory && Array.isArray(ops.memory)) state = applyMemoryOps(state, ops.memory);
      if (Array.isArray(ops.skills)) state = applySkillOps(state, ops.skills);
      return { tokens: review.tokens, costUsd: review.costUsd };
    },
    memoryText: () =>
      [
        ...state.memory,
        ...state.user,
        ...Object.entries(state.skills).map(
          ([n, s]) => `${n}: ${s.description}\n${s.body}\n${Object.values(s.files).join("\n")}`,
        ),
      ].join("\n"),
  };
};
