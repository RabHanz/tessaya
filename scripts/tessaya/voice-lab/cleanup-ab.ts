// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
/* oxlint-disable t3code/no-global-process-runtime -- a lab script run by hand, like cleanup-lab.ts */
/**
 * Dictation cleanup A/B on rows kept outside the repo: `cleanup-ab.ts <rows.jsonl> <outdir> <arm> [count] [dict.json]`.
 * Arms: `local` (rules only), `cli` (the warm subscription session, the app's default) and `api` (the Messages API
 * with Haiku, the key read from the 0600 file named by ANTHROPIC_KEY_FILE, never logged). Each writes `<outdir>/<arm>.jsonl` ({id, text, ms, stage}) and prints cleanup latency at p50/p90/p99;
 * score quality with `dictation-bench.ts score`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  cleanDictation,
  rewriteMessage,
  rewriteSystemPrompt,
  type DictationMode,
  type DictionaryEntry,
} from "../../../packages/baton-shared/src/dictationCleanup.ts";
import { makeRewriter } from "../../../apps/desktop/src/baton/voice/dictationRewriter.ts";
import { biasTranscript } from "../../../packages/baton-shared/src/vocabulary.ts";

const [rowsPath, outDir, arm, count, dictPath] = process.argv.slice(2);
if (rowsPath === undefined || outDir === undefined || arm === undefined)
  throw new Error("cleanup-ab.ts <rows.jsonl> <outdir> <local|cli|api> [count] [dict.json]");
const rows = NodeFS.readFileSync(rowsPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { id: string; raw: string; mode?: DictationMode })
  .slice(0, Number(count ?? 80));
const dictionary: ReadonlyArray<DictionaryEntry> =
  dictPath === undefined
    ? []
    : (JSON.parse(NodeFS.readFileSync(dictPath, "utf8")) as DictionaryEntry[]);

const usage = { input: 0, cached: 0, output: 0 };
/** The direct API arm: what the app's optional API path sends, timed from the request to the answer. */
const apiKey =
  arm === "api" ? NodeFS.readFileSync(process.env["ANTHROPIC_KEY_FILE"] ?? "", "utf8").trim() : "";
const askApi = async (text: string, mode: DictationMode): Promise<string> => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 64 + Math.ceil(text.length / 2),
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: [
        {
          type: "text",
          text: rewriteSystemPrompt(dictionary),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: rewriteMessage(text, mode) }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`api ${response.status}`);
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  usage.input += body.usage?.input_tokens ?? 0;
  usage.cached += body.usage?.cache_read_input_tokens ?? 0;
  usage.output += body.usage?.output_tokens ?? 0;
  return (body.content ?? [])
    .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
    .join("")
    .trim();
};

const rewriter =
  arm === "local" || arm === "api"
    ? null
    : makeRewriter({
        claudeBinary: "claude",
        model: "haiku",
        workDir: NodePath.join(outDir, "work"),
        env: process.env,
        platform: process.platform,
        dictionary: () => dictionary,
        keepWarm: () => true,
        always: true,
      });
rewriter?.warm();
// The session is up before the first dictation, as it is while he holds the key.
await new Promise((resolve) => setTimeout(resolve, rewriter === null ? 0 : 8_000));

NodeFS.mkdirSync(outDir, { recursive: true });
const out: string[] = [];
const times: number[] = [];
for (const row of rows) {
  const started = Date.now();
  const cleaned =
    rewriter === null
      ? await cleanDictation({
          // As the app does: his own names put back before the model sees the words.
          raw: biasTranscript(row.raw, dictionary),
          mode: row.mode ?? "default",
          level: arm === "api" ? "claude" : "local",
          dictionary,
          ask: arm === "api" ? askApi : () => Promise.reject(new Error("local")),
          always: true,
        })
      : await rewriter.clean({ raw: row.raw, mode: row.mode ?? "default", level: "claude" });
  const ms = Date.now() - started;
  times.push(ms);
  out.push(JSON.stringify({ id: row.id, text: cleaned.text, ms, stage: cleaned.stage }));
}
rewriter?.dispose();
NodeFS.writeFileSync(NodePath.join(outDir, `${arm}.jsonl`), `${out.join("\n")}\n`);
times.sort((a, b) => a - b);
const at = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
const stages = out.map((l) => (JSON.parse(l) as { stage: string }).stage);
console.log(
  JSON.stringify({
    arm,
    n: times.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    fallbacks: stages.filter((s) => s === "fallback").length,
    ...(arm === "api" ? { usage } : {}),
  }),
);
process.exit(0);
