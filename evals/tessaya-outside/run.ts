#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
/**
 * Tessaya's /mcp tools as an outside agent sees them: their real names, descriptions and schemas, served to a
 * plain `claude -p` session on your own Claude login, with no T3 or Tessaya prompt and no built-in tools. Tools answer from the case;
 * nothing reaches Tessaya. Scored on which tools it called and what it said it did.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { Tool } from "effect/ai";

import { startTessayaMcp } from "../../apps/desktop/src/tessaya/agent/tessayaMcp.ts";
import { toolUsesOf } from "../../apps/desktop/src/tessaya/screen/claudeVision.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { TessayaToolkit } from "../../apps/server/src/mcp/toolkits/tessaya/tools.ts";
import { outsideCases, type OutsideCase } from "./cases.ts";

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
const cases = outsideCases.filter((c) => values.case === undefined || values.case.includes(c.id));
const PREFIX = "mcp__t3-code__";

interface Sample {
  readonly calls: ReadonlyArray<{ readonly tool: string; readonly input: unknown }>;
  readonly reply: string;
}

const sample = async (c: OutsideCase): Promise<Sample> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-outside-"));
  const mcp = await startTessayaMcp({
    tools: Object.values(TessayaToolkit.tools).map((tool: Tool.Any) => ({
      name: tool.name,
      description: Tool.getDescription(tool) ?? "",
      inputSchema: advertisedJsonSchema(tool) as Record<string, unknown>,
      run: async () => ({ text: JSON.stringify(c.answers[tool.name] ?? {}) }),
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
        [
          "-p",
          c.prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          values.model!,
          "--mcp-config",
          config,
          "--strict-mcp-config",
          // Only Tessaya's tools: no shell or file tools reach this machine, and the score is which of hers it picks.
          "--tools",
          "",
          "--allowedTools",
          `${PREFIX}*`,
          "--no-session-persistence",
        ],
        { cwd: dir, stdio: ["ignore", "pipe", "ignore"] },
      );
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
    const lines = stdout.split("\n");
    const calls = lines
      .flatMap(toolUsesOf)
      .map((call) => ({ tool: call.tool.replace(PREFIX, ""), input: call.input }));
    const result = lines
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; result?: string };
        } catch {
          return {};
        }
      })
      .find((event) => event.type === "result");
    return { calls, reply: result?.result ?? "" };
  } finally {
    await mcp.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

export const samplePasses = (c: OutsideCase, s: Sample): boolean => {
  const tools = s.calls.map((call) => call.tool);
  const ask = s.calls.find((call) => call.tool === "tessaya_ask");
  return (
    c.calls.every((tool) => tools.includes(tool)) &&
    c.callsMustNot.every((tool) => !tools.includes(tool)) &&
    (c.askMatches === undefined ||
      ask === undefined ||
      c.askMatches.test(String((ask.input as { text?: unknown }).text ?? ""))) &&
    (c.replyMustNot === undefined || !c.replyMustNot.test(s.reply)) &&
    (c.replyMust === undefined || c.replyMust.test(s.reply)) &&
    s.calls.every(
      (call) =>
        c.inputs?.[call.tool] === undefined ||
        c.inputs[call.tool]!((call.input ?? {}) as Readonly<Record<string, unknown>>),
    )
  );
};

NodeFS.mkdirSync(out, { recursive: true });
const rows = [];
for (const c of cases) {
  const runs: Sample[] = [];
  for (let i = 0; i < Number(values.samples); i += 1)
    runs.push(await sample(c).catch(() => ({ calls: [{ tool: "error", input: {} }], reply: "" })));
  const pass = runs.every((s) => samplePasses(c, s));
  rows.push({
    id: c.id,
    pass,
    calls: runs.map((s) => s.calls.map((x) => x.tool)),
    replies: runs.map((s) => s.reply),
  });
  console.log(
    `${pass ? "pass" : "FAIL"}  ${c.id}: ${runs.map((s) => s.calls.map((x) => x.tool).join(">") || "none").join(", ")}`,
  );
}
NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
console.log(`${rows.filter((r) => r.pass).length} of ${rows.length} pass`);
