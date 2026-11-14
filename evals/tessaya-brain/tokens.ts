// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off
/**
 * B0 (BRAIN-DESIGN §3.2): what each tool set costs in a request's context, counted by the API (`count_tokens`, free),
 * eager and with every non-core tool deferred behind tool search.
 */
import { Tool } from "effect/ai";

import {
  buildTessayaTools,
  type ToolHost,
} from "../../apps/desktop/src/tessaya/agent/tessayaTools.ts";
import { LOOK, ROOM_SYSTEM } from "../../apps/server/src/home/R1Device.ts";
import { ROOM_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { TessayaToolkit } from "../../apps/server/src/mcp/toolkits/tessaya/tools.ts";
import { countTokens } from "./api.ts";

const key = process.env["ANTHROPIC_API_KEY"];
if (key === undefined || key === "") throw new Error("Set ANTHROPIC_API_KEY to run this.");

interface Spec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}

const tessaya: ReadonlyArray<Spec> = Object.entries(TessayaToolkit.tools).map(([name, tool]) => ({
  name,
  description: Tool.getDescription(tool as Tool.Any) ?? "",
  input_schema: advertisedJsonSchema(tool as Tool.Any),
}));
// Every host method answers nothing: only the tool table is read.
const host = new Proxy({}, { get: () => async () => "" }) as ToolHost;
const desktop: ReadonlyArray<Spec> = buildTessayaTools(host).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));
const device: ReadonlyArray<Spec> = [...ROOM_TOOL_SPECS, LOOK];

/** BRAIN-DESIGN §3.1's always-loaded set, as far as today's tools have it. */
const CORE = new Set([
  "tessaya_memory_search",
  "memory_search",
  "home_find",
  "home_do",
  "settings_find",
  "settings_set",
  "tessaya_ask",
  "set_device_volume",
  "room_look",
]);

const MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const base = { system: ROOM_SYSTEM, messages: [{ role: "user", content: "hello" }] };

const count = (model: string, tools?: ReadonlyArray<unknown>) =>
  countTokens(key, { model, ...base, ...(tools === undefined ? {} : { tools }) });

const deferred = (specs: ReadonlyArray<Spec>) => [
  { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
  ...specs.map((s) => (CORE.has(s.name) ? s : { ...s, defer_loading: true })),
];

const unique = (specs: ReadonlyArray<Spec>) => [...new Map(specs.map((s) => [s.name, s])).values()];
const sets: ReadonlyArray<readonly [string, ReadonlyArray<Spec>]> = [
  ["device (ROOM_TOOLS + room_look)", device],
  ["tessaya toolkit (all)", tessaya],
  ["desktop assistant (all)", desktop],
  ["every tool, one registry", unique([...device, ...tessaya, ...desktop])],
];

for (const model of MODELS) {
  const none = await count(model);
  console.log(`\n${model}: system and one message, no tools = ${none}`);
  for (const [label, specs] of sets) {
    const eager = (await count(model, specs)) - none;
    const lazy = await count(model, deferred(specs))
      .then((n) => String(n - none))
      .catch((e: unknown) => `error: ${String(e).slice(0, 160)}`);
    const core = specs.filter((s) => CORE.has(s.name)).length;
    console.log(
      `  ${label}: ${specs.length} tools; eager ${eager} tokens; deferred (${core} core + search) ${lazy} tokens`,
    );
  }
}
