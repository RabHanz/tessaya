#!/usr/bin/env node
// Turns your own operating-system document into the pack files Tessaya reads (D148).
// The document is read here and sent only to your own `claude` (your login, no API key); what comes
// back is checked and written to your user data folder, never to the repository.
//   node scripts/tessaya/import-operating-system.mjs <file> [--out <folder>] [--model sonnet] [--force] [--dry-run]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { distilPrompt, parseDistilled } from "../../packages/tessaya-shared/src/osImport.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const file = args.find(
  (a, i) => !a.startsWith("--") && (i === 0 || !["--out", "--model"].includes(args[i - 1])),
);
if (file === undefined) {
  console.error(
    "usage: import-operating-system.mjs <file> [--out <folder>] [--model sonnet] [--force] [--dry-run]",
  );
  process.exit(2);
}
const home = process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3");
const out = flag("--out", NodePath.join(home, "userdata", "operating-system"));
const force = args.includes("--force");
const dry = args.includes("--dry-run");

const document = NodeFS.readFileSync(file, "utf8");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_.*)$/.test(key))
    delete env[key];
}
const reply = await new Promise((resolve, reject) => {
  const child = NodeChildProcess.spawn(
    process.env.CLAUDE_BINARY ?? "claude",
    ["-p", "--model", flag("--model", "sonnet"), "--tools", "", "--no-session-persistence"],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  let text = "";
  child.stdout.on("data", (d) => (text += d));
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0 ? resolve(text) : reject(new Error(`claude exited ${code}`)),
  );
  child.stdin.end(distilPrompt(document));
});
const parsed = parseDistilled(reply);
if (!parsed.ok) {
  console.error(`Nothing written: ${parsed.why}`);
  process.exit(1);
}
const targets = [
  [NodePath.join(out, "executive.md"), parsed.pack.executive],
  ...Object.entries(parsed.pack.roles).map(([name, brief]) => [
    NodePath.join(out, "roles", `${name}.md`),
    brief,
  ]),
  [NodePath.join(out, "reference", NodePath.basename(file)), document],
];
for (const [target] of targets) {
  if (NodeFS.existsSync(target) && !force) {
    console.error(
      `${target} exists. Nothing written; run again with --force to replace it (a .bak copy is kept).`,
    );
    process.exit(1);
  }
}
for (const [target, text] of targets) {
  console.log(`${dry ? "would write" : "writing"} ${target} (${text.length} characters)`);
  if (dry) continue;
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  if (NodeFS.existsSync(target)) NodeFS.copyFileSync(target, `${target}.bak`);
  NodeFS.writeFileSync(target, `${text.trim()}\n`);
}
