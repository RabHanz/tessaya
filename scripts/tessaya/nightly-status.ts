// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
/* oxlint-disable t3code/namespace-node-imports -- Baton file predating the rule (D82) */
// Builds nightly.json for the status branch from the nightly workflow's results (see .github/workflows/baton-nightly.yml).
// Env: NEEDS (JSON of the needs context), RESULTS_DIR (one folder per ref holding result.json), MAIN_SHA, RELEASE_TAG, RUN_URL.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildNightly, type NightlyRef } from "../../packages/tessaya-shared/src/nightly.ts";

const env = (name: string): string => process.env[name] ?? "";
const needs = JSON.parse(env("NEEDS") || "{}") as Record<string, { result?: string }>;
const dir = env("RESULTS_DIR");

const checks: Array<{ name: string; ref: NightlyRef; outcome: string | undefined }> = [];
for (const ref of ["main", "release"] as const) {
  let found: Record<string, string> = {};
  try {
    found = JSON.parse(readFileSync(join(dir, `checks-${ref}`, "result.json"), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    // The job did not run (no release yet): its checks stay skipped.
  }
  for (const name of ["memory evals", "employee spine", "intent harness"])
    checks.push({ name, ref, outcome: found[name] });
}
checks.push(
  { name: "voice proof and stranger install", ref: "main", outcome: needs["voice-main"]?.result },
  {
    name: "voice proof and stranger install",
    ref: "release",
    outcome: needs["voice-release"]?.result,
  },
  { name: "hands loop", ref: "main", outcome: needs["hands"]?.result },
  { name: "every Tessaya test", ref: "main", outcome: needs["tessaya-tests"]?.result },
);

const status = buildNightly({
  now: new Date().toISOString(),
  runUrl: env("RUN_URL"),
  main: env("MAIN_SHA").slice(0, 10),
  release: env("RELEASE_TAG") || null,
  checks,
});
writeFileSync("nightly.json", `${JSON.stringify(status, null, 2)}\n`);
console.log(
  readdirSync(dir).join(" "),
  "->",
  status.checks.map((c) => `${c.name}@${c.ref}=${c.result}`).join(", "),
);
