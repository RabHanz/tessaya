// @effect-diagnostics nodeBuiltinImport:off
/**
 * What a job's worker has spent, from the worker's own session transcript (Claude Code's project
 * logs and Codex's rollout logs), priced with the rate list T3's usage page already keeps on disk.
 * Nothing is sent anywhere. A transcript that cannot be found, or a model with no price, is
 * "not measured", never zero.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  claudeUsage,
  codexUsage,
  sumUsage,
  tokenCount,
  type ModelUsage,
} from "@t3tools/tessaya-shared/jobSpend";

import { parseRateTable, priceUsage, type RateTable } from "../usage/usagePricing.ts";

const MAX_BYTES = 64 * 1024 * 1024;

type Kind = "claude" | "codex";
const fileCache = new Map<string, { stamp: string; usage: ReadonlyArray<ModelUsage> }>();
const foundAt = new Map<string, { path: string; kind: Kind }>();

const readdir = (dir: string): string[] => {
  try {
    return NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
};

/** The transcript of one native session id, or null. */
export const findTranscript = (
  id: string,
  home: string,
  extraClaudeDirs: ReadonlyArray<string> = [],
): { path: string; kind: Kind } | null => {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  const known = foundAt.get(id);
  if (known !== undefined && NodeFS.existsSync(known.path)) return known;
  const claudeRoots = [NodePath.join(home, ".claude"), ...extraClaudeDirs];
  for (const root of claudeRoots) {
    const projects = NodePath.join(root, "projects");
    for (const slug of readdir(projects)) {
      const file = NodePath.join(projects, slug, `${id}.jsonl`);
      if (NodeFS.existsSync(file))
        return (foundAt.set(id, { path: file, kind: "claude" }), { path: file, kind: "claude" });
    }
  }
  const sessions = NodePath.join(home, ".codex", "sessions");
  for (const y of readdir(sessions)) {
    for (const m of readdir(NodePath.join(sessions, y))) {
      for (const d of readdir(NodePath.join(sessions, y, m))) {
        const dir = NodePath.join(sessions, y, m, d);
        const hit = readdir(dir).find((f) => f.endsWith(`${id}.jsonl`));
        if (hit !== undefined) {
          const found = { path: NodePath.join(dir, hit), kind: "codex" as const };
          foundAt.set(id, found);
          return found;
        }
      }
    }
  }
  return null;
};

const usageOfFile = (file: { path: string; kind: Kind }): ReadonlyArray<ModelUsage> | null => {
  try {
    const stat = NodeFS.statSync(file.path);
    if (stat.size > MAX_BYTES) return null;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const hit = fileCache.get(file.path);
    if (hit?.stamp === stamp) return hit.usage;
    const lines = NodeFS.readFileSync(file.path, "utf8").split("\n");
    const usage = file.kind === "claude" ? claudeUsage(lines) : codexUsage(lines);
    fileCache.set(file.path, { stamp, usage });
    return usage;
  } catch {
    return null;
  }
};

/** The rate list T3's usage page keeps (usage-model-rates.json), or null before it has ever been fetched. */
export const readRates = (stateDir: string): RateTable | null => {
  try {
    const raw = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, "usage-model-rates.json"), "utf8"),
    ) as { document?: unknown };
    const table = parseRateTable(raw.document);
    return table.size > 0 ? table : null;
  } catch {
    return null;
  }
};

export interface Spend {
  readonly tokens: number;
  /** Null when no part could be priced. */
  readonly dollars: number | null;
  /** Some transcript was missing or some model had no price, so the figure is a floor. */
  readonly partial: boolean;
}

export const spendOf = (input: {
  readonly nativeIds: ReadonlyArray<string>;
  readonly stateDir: string;
  readonly home?: string;
  readonly extraClaudeDirs?: ReadonlyArray<string>;
  readonly rates?: RateTable | null;
}): Spend => {
  const home = input.home ?? NodeOS.homedir();
  const lists: Array<ReadonlyArray<ModelUsage>> = [];
  let partial = false;
  for (const id of input.nativeIds) {
    const file = findTranscript(id, home, input.extraClaudeDirs);
    const usage = file === null ? null : usageOfFile(file);
    if (usage === null) partial = true;
    else lists.push(usage);
  }
  const all = sumUsage(lists);
  const rates = input.rates === undefined ? readRates(input.stateDir) : input.rates;
  let dollars: number | null = null;
  if (rates !== null) {
    for (const u of all) {
      const priced = priceUsage(rates, {
        model: u.model,
        totals: {
          uncachedInputTokens: u.totals.input,
          cachedInputTokens: u.totals.cacheRead,
          cacheCreationTokens: u.totals.cacheWrite,
          outputTokens: u.totals.output,
          reasoningTokens: 0,
        },
        speed: "standard",
        reportedCostUsd: null,
      });
      if (priced.costSource === "unpriced") partial = true;
      else dollars = (dollars ?? 0) + priced.costUsd;
    }
  } else if (all.length > 0) partial = true;
  return { tokens: tokenCount(all), dollars, partial };
};
