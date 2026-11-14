#!/usr/bin/env node
// Fails a public release whose built files carry a private persona layer (apps/server/src/tessaya/PersonaLayers.ts):
// a layer's canary string, a private package name, or a build compiled as internal. Plain Node, no install.
//   node scripts/tessaya/check-no-private-layer.mjs <built dir or file>...
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MARKERS = [
  ["a private layer's canary", /tessaya-private-canary-[0-9a-f]+/],
  ["a private package", /@tessaya-private\//],
  // A public bundle compiles the switch to false; true means an internal build is being published.
  [
    "an internal build switch",
    /__TESSAYA_INTERNAL__\s*[:=]\s*true|TESSAYA_INTERNAL["']?\s*[:=]\s*["']1/,
  ],
];

const filesUnder = (path) => {
  const stat = NodeFS.statSync(path);
  if (!stat.isDirectory()) return [path];
  return NodeFS.readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => NodePath.join(d.parentPath, d.name));
};

/** Every marker found, as "file: what"; empty when the artefacts are clean. Missing paths are problems too. */
export const check = (paths) => {
  const problems = [];
  for (const path of paths) {
    if (!NodeFS.existsSync(path)) {
      problems.push(`${path}: not built, so it can't be checked`);
      continue;
    }
    for (const file of filesUnder(path)) {
      // latin1 keeps every byte, so a marker inside a binary (an asar, a SEA) is found as well.
      const text = NodeFS.readFileSync(file).toString("latin1");
      for (const [what, pattern] of MARKERS)
        if (pattern.test(text)) problems.push(`${file}: ${what}`);
    }
  }
  return problems;
};

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: check-no-private-layer.mjs <built dir or file>...");
    process.exit(2);
  }
  const problems = check(paths);
  if (problems.length > 0) {
    console.error(
      `check-no-private-layer: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(`check-no-private-layer: ok (${paths.join(", ")})`);
}
