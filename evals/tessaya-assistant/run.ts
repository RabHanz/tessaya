#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
/**
 * The one assistant as it ships: its real prompt, its real tool list on its real MCP server, and the
 * real `claude -p` session, on your own Claude login. Every tool call is recorded and refused (a
 * case's canned answers aside), so nothing runs on this machine; the score is which tool it reached
 * for first.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { replayTurn } from "../../apps/desktop/src/baton/agent/replay.ts";
import { startVisionSession } from "../../apps/desktop/src/baton/screen/claudeVision.ts";
import {
  assistantFrame,
  DEFAULT_OS_PACK,
  modelOf,
  personaFor,
  rosterLine,
} from "../../packages/tessaya-shared/src/osPack.ts";
import { mergeTemplates, templateFrame } from "../../packages/tessaya-shared/src/jobTemplates.ts";
import { memoryBlock } from "../../packages/tessaya-shared/src/memory.ts";
import { DESK_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { chooseTurnBrain } from "../../packages/tessaya-shared/src/turnTier.ts";
import { assistantCases, type AssistantCase } from "./cases.ts";
import {
  casePasses,
  firstTool,
  JUDGE_SYSTEM,
  judgePrompt,
  verdictOf,
  type Sample,
} from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    // Unset: each case runs on the model and effort a live turn would pick, as it ships.
    model: { type: "string" },
    effort: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    claude: { type: "string", default: "claude" },
    // A file added to every turn the way a matched skill is, to test a skill against the suite.
    "extra-notes": { type: "string" },
    // The model that grades a case's rubric.
    judge: { type: "string", default: "sonnet" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
const out = values.out;
const samples = Number(values.samples);
const cases = assistantCases.filter((c) => values.case === undefined || values.case.includes(c.id));

const extra =
  values["extra-notes"] === undefined
    ? undefined
    : NodeFS.readFileSync(values["extra-notes"], "utf8");

/** A case's remembered items as the live recall block (lessons first), added to the turn as a live recall is. */
const recalledFor = (c: AssistantCase): string | undefined =>
  c.remembered === undefined
    ? undefined
    : memoryBlock(
        c.remembered.map((r, i) => ({
          id: `r${i}`,
          kind: r.kind,
          text: r.text,
          source: r.his ? ("user" as const) : ("thread" as const),
          sourceRef: null,
          scope: "global" as const,
          scopeRef: null,
          confidence: r.his ? 1 : 0.8,
          pinned: r.pinned === true,
          createdAt: `2026-11-0${i + 1}T00:00:00.000Z`,
          updatedAt: `2026-11-0${i + 1}T00:00:00.000Z`,
          lastUsedAt: null,
          expiresAt: null,
          supersededBy: null,
          proposed: false,
        })),
      ).block;

const sample = async (c: AssistantCase, index: number): Promise<Sample> => {
  const face =
    c.wake === undefined
      ? undefined
      : personaFor(DEFAULT_OS_PACK.personas, { wake: c.wake, text: c.said });
  // As a live turn picks it: the persona's model is the most this sentence gets.
  const brain = chooseTurnBrain(c.said, modelOf(DEFAULT_OS_PACK, face?.id ?? "executive")).brain;
  const model = values.model ?? brain.model;
  const ran = await replayTurn({
    claudeBinary: values.claude!,
    // His server's shared tools as the desktop gets them: listed, never run (the job tools live there now).
    shared: {
      specs: DESK_TOOL_SPECS,
      call: async (name) => `(eval) ${name} was not run.`,
    },
    // The sample's index seeds the greeting's manner, so a rerun is comparable sample by sample.
    seed: index,
    brain: { model, effort: values.effort ?? brain.effort },
    said: c.said,
    ...(c.again === undefined ? {} : { again: c.again }),
    ...(c.before === undefined
      ? {}
      : {
          before: c.before.map((b) => {
            const by = personaFor(DEFAULT_OS_PACK.personas, { wake: b.wake, text: "" });
            return {
              persona: { id: by.id, name: by.name, role: by.role },
              said: b.said,
              reply: b.reply,
              ...(b.minutesAgo === undefined ? {} : { minutesAgo: b.minutesAgo }),
            };
          }),
        }),
    ...(c.now === undefined ? {} : { now: { at: new Date(c.now.at), timeZone: c.now.timeZone } }),
    where: {
      window: c.window ?? "Notepad",
      session: null,
      ...(c.outside === true ? { outside: true } : {}),
      ...(c.cutIn === undefined ? {} : { cutIn: c.cutIn }),
      ...(face === undefined
        ? {}
        : {
            persona: {
              id: face.id,
              name: face.name,
              role: face.role,
              ...(face.lead ? {} : { lead: "Tessaya" }),
              roster: rosterLine(DEFAULT_OS_PACK.personas, face.id),
            },
          }),
    },
    // As a live session gets it: the pack's frame names the specialists.
    notes: assistantFrame(DEFAULT_OS_PACK) + templateFrame(mergeTemplates()),
    ...(c.answers === undefined ? {} : { answers: c.answers }),
    ...(() => {
      const recalled = recalledFor(c);
      const all = [extra, recalled].filter((x): x is string => x !== undefined && x !== "");
      return all.length === 0 ? {} : { extra: all.join("\n\n") };
    })(),
    env: process.env,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
    platform: process.platform,
  });
  if (c.rubric === undefined) return { ...ran, model };
  const verdict = await judge(c, face, ran.replies);
  return { ...ran, model, judged: verdictOf(verdict), judgeNote: verdict };
};

/** A fresh session with no tools reads the replies against the case's rubric. */
const judge = async (
  c: AssistantCase,
  face: { readonly name: string; readonly role: string } | undefined,
  replies: ReadonlyArray<string>,
): Promise<string> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-judge-"));
  const session = startVisionSession({
    claudeBinary: values.claude!,
    model: values.judge!,
    systemPrompt: JUDGE_SYSTEM,
    workDir: dir,
    env: process.env,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
    platform: process.platform,
    timeoutMs: 120_000,
  });
  try {
    return await session.ask([{ type: "text", text: judgePrompt(c, face, replies) }]);
  } catch (error) {
    return `judge failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    session.dispose();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

NodeFS.mkdirSync(out, { recursive: true });
const rows: Array<{
  id: string;
  said: string;
  firsts: string[];
  calls: string[];
  replies: string[];
  judged: Array<string | boolean | undefined>;
  pass: boolean;
  ms: number[];
}> = [];
for (const c of cases) {
  const runs: Sample[] = [];
  const ms: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = Date.now();
    runs.push(await sample(c, i).catch(() => ({ calls: ["error"], inputs: [], reply: "" })));
    ms.push(Date.now() - started);
  }
  const row = {
    id: c.id,
    said: c.said,
    firsts: runs.map((r) => firstTool(r.calls)),
    calls: runs.map((r) =>
      r.calls.map((t) => t.replace(/^mcp__(baton|tessaya)__/, "")).join(" > "),
    ),
    replies: runs.map((r) => (r.replies ?? [r.reply]).join(" | ")),
    judged: runs.map((r) => r.judgeNote ?? r.judged),
    pass: casePasses(c, runs),
    ms,
  };
  rows.push(row);
  console.log(`${row.pass ? "pass" : "FAIL"}  ${c.id}: ${row.firsts.join(", ")}`);
}
NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
const passed = rows.filter((r) => r.pass).length;
const times = rows.flatMap((r) => r.ms).toSorted((a, b) => a - b);
const median = times[Math.floor(times.length / 2)] ?? 0;
NodeFS.writeFileSync(
  NodePath.join(out, "summary.md"),
  [
    `model ${values.model ?? "per persona"} (effort ${values.effort ?? "per persona"}), ${samples} samples a case: ${passed} of ${rows.length} pass, median sample ${(median / 1000).toFixed(1)} s`,
    "",
    ...rows.map(
      (r) => `- ${r.pass ? "pass" : "FAIL"} ${r.id} ("${r.said}"): ${r.firsts.join(", ")}`,
    ),
  ].join("\n"),
);
console.log(`${passed} of ${rows.length} pass, median sample ${(median / 1000).toFixed(1)} s`);
