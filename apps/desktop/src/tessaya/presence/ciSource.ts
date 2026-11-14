// @effect-diagnostics nodeBuiltinImport:off
/** Recent workflow runs on repositories he lists, read with `gh run list`. Read-only; empty by default. */
import * as NodeChildProcess from "node:child_process";

import type { CiRun } from "@t3tools/tessaya-shared/initiative";

import type { Run } from "./needsSources.ts";

const gh: Run = (file, args) =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      file,
      [...args],
      { timeout: 20_000, maxBuffer: 2_000_000, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );

const REPO = /^[\w.-]+\/[\w.-]+$/;

export const readCiRuns = async (
  repos: ReadonlyArray<string>,
  run: Run = gh,
): Promise<ReadonlyArray<CiRun>> => {
  const runs: CiRun[] = [];
  for (const repo of repos) {
    if (!REPO.test(repo)) continue;
    try {
      const out = await run("gh", [
        "run",
        "list",
        "-R",
        repo,
        "--limit",
        "20",
        "--json",
        "databaseId,name,headBranch,conclusion,createdAt",
      ]);
      for (const r of JSON.parse(out) as ReadonlyArray<{
        databaseId: number;
        name: string;
        headBranch: string;
        conclusion: string;
        createdAt: string;
      }>) {
        runs.push({
          repo,
          runId: r.databaseId,
          name: r.name,
          branch: r.headBranch,
          conclusion: r.conclusion,
          createdAt: r.createdAt,
        });
      }
    } catch {
      // A repository gh cannot read is skipped; the Now page shows the sources it did read.
    }
  }
  return runs;
};
