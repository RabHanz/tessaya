#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
/**
 * The direction library (M-070): her one assistant as it ships acts out what he directs; body calls are compiled by the
 * server's own decoders into what her body would play, scored for coverage, validity and (by a judge reading that
 * timeline) whether a viewer would know the direction. Seen and unseen directions are reported apart.
 */ import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeChildProcess from "node:child_process";

import { Tool } from "effect/ai";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { replayTurn } from "../../apps/desktop/src/tessaya/agent/replay.ts";
import { startTessayaMcp } from "../../apps/desktop/src/tessaya/agent/tessayaMcp.ts";
import { toolUsesOf } from "../../apps/desktop/src/tessaya/screen/claudeVision.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { BodyTools } from "../../apps/server/src/mcp/toolkits/body/tools.ts";
import { startVisionSession } from "../../apps/desktop/src/tessaya/screen/claudeVision.ts";
import { DESK_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { resolveIntents } from "../../apps/server/src/tessaya/bodyIntents.ts";
import { BODY_INTENT_TIER } from "../../packages/tessaya-shared/src/bodyLibrary.ts";
import * as MemoryEmbedder from "../../apps/server/src/tessaya/TessayaMemoryEmbedder.ts";
import {
  BODY_CAPABILITIES,
  decodeBodyMove,
} from "../../packages/tessaya-shared/src/bodyControl.ts";
import { mergeTemplates, templateFrame } from "../../packages/tessaya-shared/src/jobTemplates.ts";
import {
  assistantFrame,
  DEFAULT_OS_PACK,
  modelOf,
} from "../../packages/tessaya-shared/src/osPack.ts";
import { chooseTurnBrain } from "../../packages/tessaya-shared/src/turnTier.ts";
import { answerOf, retried } from "../shared/retry.ts";
import {
  CHANNELS,
  grade,
  JUDGE_SYSTEM,
  judgePrompt,
  samplePasses,
  scoreOf,
  type Direction,
  type Graded,
} from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    case: { type: "string", multiple: true },
    split: { type: "string" },
    samples: { type: "string", default: "1" },
    parallel: { type: "string", default: "3" },
    claude: { type: "string", default: "claude" },
    judge: { type: "string", default: "sonnet" },
    // An earlier run's results.json: grade and judge its recorded calls again (after a grader change), no new turns.
    regrade: { type: "string" },
    // Another direction file (the motion library's seed set), instead of library.json.
    library: { type: "string" },
    // "intent": the turn is told to give only an intent, as a weaker model would (M-081's lower tier).
    tier: { type: "string" },
    // Recall library intents by meaning (the memory embedder's sentence vectors), as a server with the model does.
    meaning: { type: "boolean", default: false },
    // An outside agent: a plain claude -p session given only her body tools over /mcp, no Tessaya prompt.
    outside: { type: "boolean", default: false },
  },
});
// the server's own resolver over the memory embedder, built once for the run
const meaning = values.meaning ? ManagedRuntime.make(MemoryEmbedder.layer) : null;
const resolved = async (input: unknown): Promise<unknown> =>
  meaning === null ? input : meaning.runPromise(resolveIntents(input));
if (values.out === undefined) throw new Error("Use --out <directory>.");
const out = values.out;
const library = JSON.parse(
  NodeFS.readFileSync(values.library ?? new URL("./library.json", import.meta.url), "utf8"),
) as { directions: Direction[] };
const directions = library.directions.filter(
  (d) =>
    (values.case === undefined || values.case.includes(d.id)) &&
    (values.split === undefined || d.split === values.split),
);

// The body is open on his desk, as when he talks to her there. Body calls answer as the server would: a move that does
// not decode gets the decoder's own error back, so the model can fix it as it would live; the rest are not run.
const bodyAnswer = async (name: string, input: unknown): Promise<string> => {
  if (name === "tessaya_body_state")
    return JSON.stringify({
      open: true,
      body: { posture: "stand", moving: false, contacts: [], vessel: "desk" },
      capabilities: BODY_CAPABILITIES,
    });
  if (name === "tessaya_body_move") {
    const d = decodeBodyMove(await resolved(input));
    return JSON.stringify(
      d.ok
        ? { ok: true, route: "desk", said: "Her body took it." }
        : { ok: false, route: "none", said: d.error },
    );
  }
  if (name === "tessaya_body_scene")
    return JSON.stringify({ ok: true, route: "desk", said: "Her body took it." });
  return `(eval) ${name} was not run.`;
};

const ask = async (system: string, text: string): Promise<string> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-direction-judge-"));
  const session = startVisionSession({
    claudeBinary: values.claude!,
    model: values.judge!,
    systemPrompt: system,
    workDir: dir,
    env: process.env,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
    platform: process.platform,
    timeoutMs: 120_000,
  });
  try {
    return await session.ask([{ type: "text", text }]);
  } catch (error) {
    return `judge failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    session.dispose();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

interface Row {
  readonly id: string;
  readonly said: string;
  readonly split: string;
  readonly category: string;
  readonly calls: string;
  readonly input: unknown;
  /** Every body call's arguments, in order, so a run can be graded again. */
  readonly bodyInputs?: ReadonlyArray<unknown>;
  readonly reply: string;
  readonly graded: Graded;
  readonly score: number;
  readonly why: string;
  readonly pass: boolean;
  readonly ms: number;
}

const OUTSIDE = "mcp__t3-code__";
const OUTSIDE_SETUP =
  'You drive Tessaya\'s own body through her body tools: pass target "her" on every call. What the user says is a direction to her body.';
const NO_PLAYGROUND = "No playground is open. Open /tessaya/playground in a browser first.";
/** One direction as an outside agent gets it: her body tools as /mcp advertises them, answered as the server does. */
const outsideTurn = async (said: string, model: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-direction-outside-"));
  const mcp = await startTessayaMcp({
    tools: BodyTools.map((tool: Tool.Any) => ({
      name: tool.name,
      description: Tool.getDescription(tool) ?? "",
      inputSchema: advertisedJsonSchema(tool) as Record<string, unknown>,
      // as the server answers an outside agent: its default body is the playground sandbox, and none is open here
      run: async (args) => ({
        text:
          args["target"] === "her"
            ? await bodyAnswer(tool.name, args)
            : JSON.stringify({ ok: false, route: "none", said: NO_PLAYGROUND }),
      }),
    })),
    gate: async () => ({ allow: true }),
  });
  const config = NodePath.join(dir, "mcp.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        "t3-code": {
          type: "http",
          url: mcp.url,
          headers: { Authorization: `Bearer ${mcp.token}` },
        },
      },
    }),
  );
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        values.claude!,
        // only her body tools: no shell or files, so what it does is what it asks her body to do
        [
          "-p",
          said,
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          model,
          "--mcp-config",
          config,
          "--strict-mcp-config",
          "--tools",
          "",
          "--allowedTools",
          `${OUTSIDE}*`,
          "--no-session-persistence",
          // how an agent set up to drive her (not the playground) is told so: the one line of setup it gets
          "--append-system-prompt",
          OUTSIDE_SETUP,
        ],
        { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
      );
      let text = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.stderr.on(
        "data",
        (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)),
      );
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          resolve(answerOf(text, code, stderr));
        } catch (error) {
          reject(error);
        }
      });
    });
    const lines = stdout.split("\n");
    const calls = lines.flatMap(toolUsesOf);
    const result = lines
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; result?: string };
        } catch {
          return {};
        }
      })
      .find((event) => event.type === "result");
    // only what reached her body is graded; calls that went to the absent playground did nothing
    const reached = calls.filter((c) => (c.input as Record<string, unknown>)["target"] === "her");
    return {
      calls: reached.map((c) => c.tool.replace(OUTSIDE, "")),
      inputs: reached.map((c) => c.input),
      reply: result?.result ?? "",
      replies: result?.result === undefined ? [] : [result.result],
    };
  } finally {
    await mcp.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const sample = async (d: Direction, index: number): Promise<Row> => {
  const brain = chooseTurnBrain(d.said, modelOf(DEFAULT_OS_PACK, "executive")).brain;
  const started = Date.now();
  const ran = await retried(`${d.id} #${index}`, () =>
    values.outside
      ? outsideTurn(d.said, values.model ?? "opus")
      : replayTurn({
          claudeBinary: values.claude!,
          shared: { specs: DESK_TOOL_SPECS, call: async (name, input) => bodyAnswer(name, input) },
          seed: index,
          brain: { model: values.model ?? brain.model, effort: values.effort ?? brain.effort },
          said: d.said,
          where: { window: "Notepad", session: null },
          notes: assistantFrame(DEFAULT_OS_PACK) + templateFrame(mergeTemplates()),
          ...(values.tier === "intent" ? { extra: BODY_INTENT_TIER } : {}),
          env: process.env,
          // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
          platform: process.platform,
        }),
  ).catch(() => ({ calls: ["error"], inputs: [], reply: "", replies: [] }));
  return judged(d, ran, Date.now() - started);
};

const judged = async (
  d: Direction,
  ran: { calls: ReadonlyArray<string>; inputs: ReadonlyArray<unknown>; reply: string },
  ms: number,
): Promise<Row> => {
  // what the server would have played: intents named by meaning when the run recalls that way
  const graded = grade({ ...ran, inputs: await Promise.all(ran.inputs.map(resolved)) });
  const verdict = graded.moved ? await ask(JUDGE_SYSTEM, judgePrompt(d, graded)) : "";
  const score = graded.moved ? scoreOf(verdict) : 1;
  const bodyAt = ran.calls.findIndex((c) => /tessaya_body_(move|scene)$/.test(c));
  const body = ran.calls.flatMap((c, i) =>
    /tessaya_body_(move|scene)$/.test(c) ? [ran.inputs[i]] : [],
  );
  return {
    id: d.id,
    said: d.said,
    split: d.split,
    category: d.category,
    calls: ran.calls.map((t) => t.replace(/^mcp__(baton|tessaya)__/, "")).join(" > "),
    input: bodyAt < 0 ? null : ran.inputs[bodyAt],
    bodyInputs: body,
    reply: ran.reply,
    graded,
    score,
    why: verdict,
    pass: samplePasses(graded, score),
    ms,
  };
};

// A regrade replays each recorded row's body calls (only the first, for rows from before bodyInputs was kept).
const jobs =
  values.regrade === undefined
    ? directions.flatMap((d) =>
        Array.from({ length: Number(values.samples) }, (_, i) => () => sample(d, i)),
      )
    : (JSON.parse(NodeFS.readFileSync(values.regrade, "utf8")) as Row[])
        .filter((r) => directions.some((d) => d.id === r.id))
        .map((r) => () => {
          const tool = /tessaya_body_scene/.test(r.calls)
            ? "tessaya_body_scene"
            : "tessaya_body_move";
          const inputs = r.bodyInputs ?? (r.input === null ? [] : [r.input]);
          return judged(
            directions.find((d) => d.id === r.id)!,
            { calls: inputs.map(() => tool), inputs, reply: r.reply },
            r.ms,
          );
        });
const rows: Row[] = [];
const worker = async () => {
  for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
    const row = await job();
    rows.push(row);
    console.log(
      `${row.pass ? "pass" : "FAIL"}  ${row.split.padEnd(6)} ${row.id}: ${row.graded.moved ? `[${row.graded.channels.join(" ")}] score ${row.score}` : "no move"}`,
    );
  }
};
await Promise.all(Array.from({ length: Number(values.parallel) }, worker));
rows.sort((a, b) => a.id.localeCompare(b.id));

const pct = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((100 * n) / of)}%`);
const line = (label: string, set: Row[]) => {
  const moved = set.filter((r) => r.graded.moved);
  const coverage =
    set.reduce((s, r) => s + r.graded.channels.length / CHANNELS.length, 0) /
    Math.max(1, set.length);
  const score = set.reduce((s, r) => s + r.score, 0) / Math.max(1, set.length);
  return `| ${label} | ${set.length} | ${pct(moved.length, set.length)} | ${Math.round(coverage * 100)}% | ${pct(set.filter((r) => r.graded.overSpeed.length === 0 && r.graded.corrections === 0).length, set.length)} | ${score.toFixed(2)} | ${pct(set.filter((r) => r.pass).length, set.length)} |`;
};
NodeFS.mkdirSync(out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
const table = [
  `model ${values.model ?? "as a live turn routes it"}, judge ${values.judge}, ${values.samples} sample(s) a direction`,
  "",
  "| split | samples | moved | channels | valid | judge (1-5) | pass |",
  "|---|---|---|---|---|---|---|",
  line(
    "unseen",
    rows.filter((r) => r.split === "unseen"),
  ),
  line(
    "seen",
    rows.filter((r) => r.split === "seen"),
  ),
  line("all", rows),
  "",
  ...rows.map(
    (r) =>
      `- ${r.pass ? "pass" : "FAIL"} ${r.split} ${r.id} ("${r.said}"): ${r.graded.moved ? `[${r.graded.channels.join(", ")}] score ${r.score}${r.graded.overSpeed.length > 0 ? `, too fast: ${r.graded.overSpeed.join(", ")}` : ""}` : "no move"}`,
  ),
].join("\n");
NodeFS.writeFileSync(NodePath.join(out, "summary.md"), table);
console.log(table.split("\n").slice(0, 7).join("\n"));
