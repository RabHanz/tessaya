// @effect-diagnostics globalConsole:off globalTimers:off
/* oxlint-disable t3code/no-global-process-runtime -- Baton file predating the rule (D82) */
// @effect-diagnostics globalDate:off nodeBuiltinImport:off
/**
 * The real clean-up on his own `claude` (see VOICE.md): `cases <out> [group]`, `clips <lab> <out> [count]`
 * (aggregates only), and `names <rows> <out> [dictionary]`, the app's whole path on `{id, raw}` rows kept outside
 * the repo, for the per-name score against his Wispr finals.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  localClean,
  needsModel,
  type DictionaryEntry,
} from "../../../packages/baton-shared/src/dictationCleanup.ts";
import {
  importWispr,
  makeRewriter,
  readDictionary,
} from "../../../apps/desktop/src/baton/voice/dictationRewriter.ts";
import { biasTranscript, parseVocabulary } from "../../../packages/baton-shared/src/vocabulary.ts";
import {
  ADVERSARIAL_CASES,
  DEFAULT_CASES,
  DICTIONARY_CASES,
  MODE_CASES,
  type CleanupCase,
} from "./cleanup-cases.ts";

const state = NodePath.join(NodeOS.tmpdir(), "baton-cleanup-lab");
const saved = readDictionary(state, []);
const labDictionary: ReadonlyArray<DictionaryEntry> =
  saved.length > 0
    ? saved
    : await importWispr({ stateDir: state, appData: process.env["APPDATA"], entries: [] });
let dictionary = labDictionary;
const rewriter = (always: boolean, limitMs?: number) =>
  makeRewriter({
    claudeBinary: "claude",
    model: process.env["BATON_CLEANUP_MODEL"] ?? "haiku",
    workDir: NodePath.join(state, "work"),
    env: process.env,
    platform: process.platform,
    dictionary: () => dictionary,
    ...(limitMs === undefined ? {} : { limitMs }),
    always,
  });

const sorted = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b);
const median = (values: ReadonlyArray<number>) =>
  sorted(values)[Math.floor(values.length / 2)] ?? 0;
const p95 = (values: ReadonlyArray<number>) =>
  sorted(values)[Math.floor(values.length * 0.95)] ?? 0;

const cases = async (out: string, only?: string) => {
  const r = rewriter(true, 30_000);
  r.warm();
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const lines: string[] = [];
  const run = async (group: string, list: ReadonlyArray<CleanupCase & { mode?: string }>) => {
    if (only !== undefined && only !== group) return;
    let failed = 0;
    for (const item of list) {
      const mode = (item.mode ?? "default") as "default";
      dictionary = item.dictionary ?? labDictionary;
      const words = parseVocabulary(dictionary);
      // As the app does: the near-miss bias first, then the clean-up.
      const result = await r.clean({ raw: biasTranscript(item.raw, words), mode, level: "claude" });
      const lost = item.keep.filter((k) => !result.text.includes(k));
      const stayed = (item.gone ?? []).filter((g) => result.text.includes(g));
      const pass = lost.length === 0 && stayed.length === 0;
      failed += pass ? 0 : 1;
      lines.push(
        JSON.stringify({
          group,
          mode,
          pass,
          stage: result.stage,
          why: result.why,
          ms: result.ms,
          lost,
          stayed,
          raw: item.raw,
          text: result.text,
        }),
      );
    }
    console.log(`${group}: ${list.length - failed} of ${list.length} kept everything required`);
  };
  await run("default", DEFAULT_CASES);
  await run("adversarial", ADVERSARIAL_CASES);
  await run("modes", MODE_CASES);
  await run("dictionary", DICTIONARY_CASES);
  NodeFS.writeFileSync(out, `${lines.join("\n")}\n`);
  r.dispose();
};

const clips = async (lab: string, out: string, count: number) => {
  const rows = NodeFS.readFileSync(NodePath.join(lab, "clips.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { asr: string | null });
  const usable = rows.flatMap((c) => (c.asr === null || c.asr.length === 0 ? [] : [c.asr]));
  const started = process.hrtime.bigint();
  const locals = usable.map((asr) => localClean(asr, "default", dictionary));
  const localMs = Number(process.hrtime.bigint() - started) / 1e6 / usable.length;
  const flagged = usable.filter((_, i) => needsModel(locals[i] as string, "default"));
  const r = rewriter(false);
  r.warm();
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const stages: Record<string, number> = {};
  const why: Record<string, number> = {};
  const ms: number[] = [];
  for (const raw of flagged.slice(0, count)) {
    const result = await r.clean({ raw, mode: "default", level: "claude" });
    stages[result.stage] = (stages[result.stage] ?? 0) + 1;
    if (result.why !== undefined) {
      const key = result.why.split(" ").slice(0, 2).join(" ");
      why[key] = (why[key] ?? 0) + 1;
    }
    ms.push(result.ms);
    // He is speaking again before the next one, which is when a replaced session comes up.
    if (result.why === "timed out") await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
  r.dispose();
  const report = {
    clips: usable.length,
    dictionaryTerms: dictionary.length,
    localMsPerClip: localMs,
    needModel: flagged.length,
    modelRuns: ms.length,
    stages,
    refusedBecause: why,
    medianMs: median(ms),
    p95Ms: p95(ms),
  };
  NodeFS.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
};

const names = async (rowsFile: string, out: string, dictionaryFile?: string) => {
  if (dictionaryFile !== undefined)
    dictionary = parseVocabulary(JSON.parse(NodeFS.readFileSync(dictionaryFile, "utf8")));
  const words = parseVocabulary(dictionary);
  const rows = NodeFS.readFileSync(rowsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; raw: string; mode?: string });
  const r = rewriter(false);
  r.warm();
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const lines: string[] = [];
  for (const row of rows) {
    const raw = biasTranscript(row.raw, words);
    const mode = (row.mode ?? "default") as "default";
    const local = localClean(raw, mode, dictionary);
    const result = await r.clean({ raw, mode, level: "claude" });
    lines.push(
      JSON.stringify({
        id: row.id,
        local,
        text: result.text,
        stage: result.stage,
        why: result.why,
        ms: result.ms,
      }),
    );
    if (result.why === "timed out") await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
  r.dispose();
  NodeFS.writeFileSync(out, `${lines.join("\n")}\n`);
};

const [, , step, a, b, c] = process.argv;
if (step === "cases") await cases(a as string, b);
else if (step === "names") await names(a as string, b as string, c);
else await clips(a as string, b as string, Number(c ?? 60));
process.exit(0);
