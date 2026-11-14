// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The read-only sources behind "what needs me": issue labels on repositories he lists, and a
 * deadlines file. Both are settings and empty by default; nothing is written, sent or spent. A
 * source that fails is named in `unreadable` so a short list is never taken for a clear one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { notConnected, parseFeed, type FeedRead } from "@t3tools/tessaya-shared/needsFeeds";
import {
  needsFromDeadlines,
  needsFromLedger,
  type DeadlineRow,
  type LedgerIssue,
  type NeedItem,
} from "@t3tools/tessaya-shared/needsMe";

export type Run = (file: string, args: ReadonlyArray<string>) => Promise<string>;

const gh: Run = (file, args) =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      file,
      [...args],
      { timeout: 20_000, maxBuffer: 4_000_000, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );

const LABELS = ["ledger:money-blocker", "ledger:blocked-on-director"] as const;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const readLedger = async (
  repos: ReadonlyArray<string>,
  run: Run = gh,
): Promise<{ issues: ReadonlyArray<LedgerIssue>; unreadable: ReadonlyArray<string> }> => {
  const issues: LedgerIssue[] = [];
  const unreadable: string[] = [];
  for (const repo of repos) {
    if (!REPO.test(repo)) {
      unreadable.push(repo);
      continue;
    }
    try {
      for (const label of LABELS) {
        const out = await run("gh", [
          "issue",
          "list",
          "-R",
          repo,
          "--label",
          label,
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          "number,title,labels,updatedAt",
        ]);
        const rows = JSON.parse(out) as ReadonlyArray<{
          number: number;
          title: string;
          labels: ReadonlyArray<{ name: string }>;
          updatedAt: string;
        }>;
        for (const r of rows) {
          issues.push({
            repo,
            number: r.number,
            title: r.title,
            labels: r.labels.map((l) => l.name),
            updatedAt: r.updatedAt,
          });
        }
      }
    } catch {
      unreadable.push(`the ledger ${repo}`);
    }
  }
  return { issues, unreadable };
};

export const readDeadlines = (file: string): ReadonlyArray<DeadlineRow> => {
  const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    rows?: ReadonlyArray<DeadlineRow>;
  };
  return Array.isArray(parsed.rows) ? parsed.rows : [];
};

export interface NeedsConfig {
  readonly repos: ReadonlyArray<string>;
  readonly deadlinesFile: string | null;
  /** Files other systems write (a status export): read-only. */
  readonly feeds?: ReadonlyArray<string>;
  /** Sources he expects an answer from; one with no readable feed is listed as not connected. */
  readonly expect?: ReadonlyArray<string>;
}

export const readFeeds = (files: ReadonlyArray<string>, now: number): ReadonlyArray<FeedRead> =>
  files.map((file) => {
    const name = file.split(/[\\/]/).at(-1) ?? file;
    try {
      return parseFeed(NodeFS.readFileSync(file, "utf8"), now, name);
    } catch {
      return {
        source: name,
        items: [],
        problem: `${name}: the feed file could not be read`,
      } satisfies FeedRead;
    }
  });

export const readExternalNeeds = async (
  config: NeedsConfig,
  now: number,
  run?: Run,
): Promise<{ items: ReadonlyArray<NeedItem>; unreadable: ReadonlyArray<string> }> => {
  const ledger = await readLedger(config.repos, run);
  const unreadable = [...ledger.unreadable];
  let deadlines: ReadonlyArray<NeedItem> = [];
  if (config.deadlinesFile !== null) {
    try {
      deadlines = needsFromDeadlines(readDeadlines(config.deadlinesFile), now);
    } catch {
      unreadable.push("the deadlines file");
    }
  }
  const feeds = readFeeds(config.feeds ?? [], now);
  for (const f of feeds) if (f.problem !== null) unreadable.push(f.problem);
  for (const missing of notConnected(config.expect ?? [], feeds))
    unreadable.push(`${missing} (not connected)`);
  return {
    items: [...needsFromLedger(ledger.issues), ...deadlines, ...feeds.flatMap((f) => f.items)],
    unreadable,
  };
};

type External = { items: ReadonlyArray<NeedItem>; unreadable: ReadonlyArray<string> };
export type ExternalNeeds = (config: NeedsConfig, now: number) => Promise<External>;

/**
 * gh is slow and a spoken answer must not wait for it: serve the last read while it is fresh, and
 * otherwise wait only `timeoutMs` for a new one (the read carries on and fills the cache).
 */
export const createExternalNeeds = (
  options: { readonly run?: Run; readonly ttlMs?: number; readonly timeoutMs?: number } = {},
): ExternalNeeds => {
  const ttl = options.ttlMs ?? 5 * 60_000;
  const timeout = options.timeoutMs ?? 2_500;
  let cache: { key: string; at: number; value: External } | null = null;
  let inflight: Promise<External> | null = null;
  return async (config, now) => {
    const key = JSON.stringify(config);
    if (cache?.key === key && now - cache.at < ttl) return cache.value;
    if (config.repos.length === 0 && config.deadlinesFile === null)
      return { items: [], unreadable: [] };
    inflight ??= readExternalNeeds(config, now, options.run)
      .then((value) => {
        cache = { key, at: now, value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeout);
    });
    try {
      const got = await Promise.race([inflight, slow]);
      if (got !== null) return got;
    } finally {
      clearTimeout(timer);
    }
    // Stale beats nothing; with nothing, say it is still loading.
    return cache?.key === key
      ? cache.value
      : { items: [], unreadable: ["the ledger and deadlines (still loading)"] };
  };
};
