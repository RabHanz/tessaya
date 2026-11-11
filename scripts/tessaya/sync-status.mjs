#!/usr/bin/env node
/* oxlint-disable t3code/namespace-node-imports -- Baton file predating the rule (D82) */
// The daily upstream sync's one status file: what happened and, when it stopped, exactly where.
// node scripts/tessaya/sync-status.mjs --result opened|conflict|gates|nothing|disk [--pin sha] [--to sha] [--behind n]
//   [--days n] [--patches "a.patch b.patch"] [--files "path path"] [--pr url] [--log file] > upstream-sync.json
// Pure formatter (exported for the test); the timer publishes the output to the baton/status branch.
import { pathToFileURL } from "node:url";

const HINTS = {
  opened: "Synced and gates green. The PR is open for review; merging and deploying are by hand.",
  nothing: "Tessaya is on upstream's tip.",
  conflict:
    "A patch no longer applies. Resolve the files below on a branch from main, run patches.sh refresh and verify, open the PR.",
  gates: "The series applied but a gate failed. The branch is pushed; read the gates log.",
  disk: "Skipped: the volume is below its free-space floor.",
};

export const syncStatus = (a) => ({
  at: a.at ?? new Date().toISOString(),
  result: a.result,
  ok: a.result === "opened" || a.result === "nothing",
  pin: a.pin ?? null,
  target: a.to ?? null,
  behindCommits: a.behind ?? null,
  oldestUnsyncedDays: a.days ?? null,
  conflictingPatches: a.patches ?? [],
  conflictingFiles: a.files ?? [],
  // For each conflicting file: the upstream commits that touched it since the pin.
  touching: a.touching ?? {},
  pr: a.pr ?? null,
  log: a.log ?? null,
  hint: HINTS[a.result] ?? "",
});

const words = (v) => (v ?? "").split(/\s+/).filter(Boolean);
const num = (v) => (v === undefined || v === "" ? null : Number(v));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2)
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  console.log(
    JSON.stringify(
      syncStatus({
        result: args.result,
        pin: args.pin,
        to: args.to,
        behind: num(args.behind),
        days: num(args.days),
        patches: words(args.patches),
        files: words(args.files),
        touching: args.touching ? JSON.parse(args.touching) : {},
        pr: args.pr,
        log: args.log,
      }),
      null,
      2,
    ),
  );
}
