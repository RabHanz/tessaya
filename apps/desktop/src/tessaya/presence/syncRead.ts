// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The two things about the upstream sync that are not in the status file: how far behind upstream the
 * repo checkout is (counted there, when a checkout is named in BATON_REPO_DIR), and the open sync pull
 * request with its checks (the GitHub command line). Read only and cached; no `gh`, no checkout or no
 * network all mean "unknown", never an error.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { summariseChecks, type SyncPr } from "@t3tools/tessaya-shared/syncState";

import type { RunGh } from "./nightlyRead.ts";

export type RunGit = (cwd: string, args: ReadonlyArray<string>) => Promise<string>;

const runGit: RunGit = (cwd, args) =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 8_000, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );

export const readLocalBehind = async (
  repoDir: string | undefined,
  git: RunGit = runGit,
): Promise<number | null> => {
  if (repoDir === undefined || repoDir === "") return null;
  try {
    const pin = NodeFS.readFileSync(
      NodePath.join(repoDir, "vendor-patches", "t3code", "PIN"),
      "utf8",
    ).trim();
    const n = Number((await git(repoDir, ["rev-list", "--count", `${pin}..upstream/main`])).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

interface PrRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
  readonly statusCheckRollup?: ReadonlyArray<{
    conclusion?: string | null;
    status?: string | null;
    state?: string | null;
  }>;
}

export const readSyncPr = async (repo: string, run: RunGh): Promise<SyncPr | null> => {
  try {
    const rows = JSON.parse(
      await run([
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--limit",
        "30",
        "--json",
        "number,title,url,headRefName,statusCheckRollup",
      ]),
    ) as ReadonlyArray<PrRow>;
    const pr = rows.find((r) => r.headRefName.startsWith("baton/sync-"));
    return pr === undefined
      ? null
      : {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          checks: summariseChecks(pr.statusCheckRollup ?? []),
        };
  } catch {
    return null;
  }
};

const CACHE_MS = 10 * 60_000;

/** At most every ten minutes; a failed read is remembered for that long too. */
export const createSyncExtraCache = (
  repo: string,
  repoDir: string | undefined,
  run: RunGh,
  git?: RunGit,
  now: () => number = Date.now,
) => {
  let at = Number.NEGATIVE_INFINITY;
  let held: { readonly localBehind: number | null; readonly pr: SyncPr | null } = {
    localBehind: null,
    pr: null,
  };
  return async () => {
    if (now() - at < CACHE_MS) return held;
    at = now();
    held = { localBehind: await readLocalBehind(repoDir, git), pr: await readSyncPr(repo, run) };
    return held;
  };
};
