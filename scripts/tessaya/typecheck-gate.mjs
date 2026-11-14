// Typechecks the Baton workspaces and fails only on errors not listed in typecheck-baseline.txt.
// Owners delete baseline lines as they fix them; `--write` regenerates the file.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..");
const dirs = [
  "apps/server",
  "apps/desktop",
  "apps/web",
  "packages/tessaya-shared",
  "packages/tessaya-voice",
  "packages/tessaya-contracts",
  "scripts/tessaya",
];
const baselineFile = NodePath.join(root, "scripts/tessaya/typecheck-baseline.txt");

const found = new Set();
for (const dir of dirs) {
  // The same checker as each package's `typecheck`; `tsc` is no longer a workspace binary.
  const tsgo = NodePath.join(root, "node_modules/.bin/effect-tsgo");
  const run = NodeChildProcess.spawnSync(tsgo, ["tsrs", "--noEmit", "--pretty", "false"], {
    cwd: NodePath.join(root, dir),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const out = `${run.stdout}${run.stderr}`;
  const lines = out.split("\n").filter((l) => /\berror TS\d+/.test(l));
  if (run.status !== 0 && lines.length === 0) {
    console.error(`${dir}: the typecheck failed without a diagnostic\n${out.slice(-2000)}`);
    process.exit(1);
  }
  for (const l of lines) found.add(`${dir}/${l.replace(/\(\d+,\d+\)/, "")}`);
}

if (process.argv.includes("--write")) {
  NodeFS.writeFileSync(baselineFile, [...found].sort().join("\n") + "\n");
  console.log(`wrote ${found.size} baseline errors`);
  process.exit(0);
}
const known = new Set(NodeFS.readFileSync(baselineFile, "utf8").split("\n").filter(Boolean));
const fresh = [...found].filter((l) => !known.has(l));
const fixed = [...known].filter((l) => !found.has(l));
if (fixed.length)
  console.log(
    `${fixed.length} baseline errors are fixed; delete them from typecheck-baseline.txt:\n${fixed.join("\n")}`,
  );
if (fresh.length) {
  console.error(`${fresh.length} new type errors:\n${fresh.join("\n")}`);
  process.exit(1);
}
console.log(`typecheck ok (${known.size - fixed.length} known errors remain in the baseline)`);
