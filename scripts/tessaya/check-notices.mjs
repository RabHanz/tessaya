#!/usr/bin/env node
// Fails when something Tessaya's own code ships or downloads has no licence entry (public release checklist).
// Looks at: the dependencies of packages/tessaya-*, apps/desktop, the Rust crates of native/baton-dictation, tessel-flash's Go
// modules, the model files it ships, and the fonts in the window. Each must be in docs/baton/notices.json, named in
// THIRD_PARTY_NOTICES.md, and point at a licence text that exists.  Plain Node:  node scripts/tessaya/check-notices.mjs
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "../..");
const read = (root, file) => {
  try {
    return NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  } catch {
    return null;
  }
};

/** The npm packages Tessaya's own workspaces add (not workspace links, not upstream's). */
const BATON_PACKAGES = [
  "packages/tessaya-voice",
  "packages/tessaya-shared",
  "packages/tessaya-contracts",
];
/** apps/desktop mixes upstream's dependencies with ours; only these are ours to account for. */
const DESKTOP_OURS = ["electron"];

export const wanted = (root) => {
  const keys = new Set();
  for (const dir of BATON_PACKAGES) {
    const pkg = JSON.parse(read(root, `${dir}/package.json`) ?? "{}");
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (
        String(version).startsWith("workspace:") ||
        name.startsWith("@t3tools/") ||
        name === "effect"
      )
        continue;
      keys.add(`npm:${name}`);
    }
  }
  const desktop = JSON.parse(read(root, "apps/desktop/package.json") ?? "{}");
  for (const name of DESKTOP_OURS) {
    if (desktop.dependencies?.[name] ?? desktop.devDependencies?.[name]) keys.add(`npm:${name}`);
  }
  const cargo = read(root, "native/baton-dictation/Cargo.toml") ?? "";
  let inDeps = false;
  for (const line of cargo.split(/\r?\n/)) {
    if (/^\[/.test(line)) inDeps = /^\[(target\.[^\]]*\.)?dependencies\]/.test(line);
    else if (inDeps) {
      const m = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (m) keys.add(`crate:${m[1]}`);
    }
  }
  // tessel-flash's Go modules (go.mod `require` lines), and the bootrom protocol it ports from bk7231tools.
  const gomod = read(root, "tools/tessel-flash/go.mod") ?? "";
  for (const m of gomod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[^\s]+/gm))
    keys.add(`go:${m[1]}`);
  if (gomod !== "") keys.add("port:bk7231tools");
  const models = NodePath.join(root, "native/baton-dictation/models");
  if (NodeFS.existsSync(models)) {
    for (const f of NodeFS.readdirSync(models)) if (f.endsWith(".onnx")) keys.add(`model:${f}`);
  }
  // The server's memory recall model (MEM-16): its vocabulary is in git, the model is fetched at build time.
  if (NodeFS.existsSync(NodePath.join(root, "apps/server/resources/memory-model/vocab.txt")))
    keys.add("model:bge-small-en-v1.5");
  const fonts = read(root, "apps/desktop/src/tessaya/home/fonts.ts") ?? "";
  for (const m of fonts.matchAll(/^\s*"([A-Z][A-Za-z ]+)",\s*$/gm)) keys.add(`font:${m[1]}`);
  return keys;
};

export const check = (root = ROOT) => {
  const problems = [];
  const notices = JSON.parse(read(root, "docs/baton/notices.json") ?? "{}");
  const text = read(root, "docs/baton/THIRD_PARTY_NOTICES.md") ?? "";
  const entries = notices.entries ?? {};
  for (const key of [...wanted(root)].toSorted()) {
    const e = entries[key];
    if (e === undefined) {
      problems.push(
        `${key}: no entry in docs/baton/notices.json (add its licence, holder and a mention)`,
      );
      continue;
    }
    if (!text.includes(e.mention))
      problems.push(`${key}: THIRD_PARTY_NOTICES.md never mentions "${e.mention}"`);
    const file =
      e.file ??
      notices.licenceFiles?.[e.licence] ??
      (e.licence.includes(" OR ") ? notices.licenceFiles?.[e.licence.split(" OR ")[0]] : undefined);
    if (file === undefined || read(root, file) === null)
      problems.push(`${key}: the licence text for ${e.licence} is missing`);
  }
  return problems;
};

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-notices.mjs")
) {
  const problems = check();
  if (problems.length > 0) {
    console.error(`check-notices: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("check-notices: ok");
}
