#!/usr/bin/env node
// Fails when something private is in the public repository (D148, D135, the open-core rule): a maintainer
// host, account or path, a key or token, a tailnet address, or a hashed phrase of a private pack.
// Plain Node, no install, so CI runs it before anything else:  node scripts/tessaya/guard-private.mjs
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "../..");

// Everything tracked that Tessaya wrote: files upstream T3 Code does not have at the pin, plus the
// lines our patches add to upstream files. Upstream's own text (its Hetzner examples, tailnet test
// addresses) is not ours to change. Vendored references, the lockfile and third-party material are skipped.
const PIN_FILE = "vendor-patches/t3code/PIN";
const SKIPPED = [
  /^\.repos\//,
  /^pnpm-lock\.yaml$/,
  /^patches\//,
  /^docs\/baton\/licences\//,
  /THIRD_PARTY|third-party-licenses/i,
  /^scripts\/tessaya\/guard-private\.mjs$/,
  /^scripts\/tessaya\/private-markers\.txt$/,
];
// Without the pin's tree (a shallow clone) only the code Tessaya ships is checked.
const SHIPPED = [
  "apps/desktop/src/baton/",
  "apps/server/src/baton/",
  "packages/tessaya-",
  "apps/web/src/components/sidebar/Baton",
  "apps/web/src/components/chat/Baton",
  "apps/web/src/components/panes/baton",
  "scripts/tessaya/",
];

const PRIVATE = [
  [
    "a host or account of the maintainer",
    /signzart|onnyx|ventureos|venture-os|xiaomi|rabee|hanzla/i,
  ],
  ["a cloud provider's name used as a machine", /\bhetzner\b/i],
  [
    "a key or token",
    /sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|gh[opsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ],
  ["a tailnet address", /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b|\.ts\.net\b/],
  ["a path on the maintainer's machines", /\/mnt\/HC_Volume_\d+/],
  [
    "an email address",
    /[A-Za-z0-9._%+-]+@(?!example\.|[A-Za-z0-9.-]*\.(invalid|test|example|local)\b|users\.noreply\.github\.com|anthropic\.com)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/,
  ],
];

// Where a private name stays for now, and why: only the named text is excused, the rest of the
// file is still checked. Each is an operator step for the maintainer's own machines, not a
// default for anyone else; the list only shrinks.
const ALLOWED = {
  "apps/desktop/src/baton/voice/roomRecognizer.test.ts": [
    /100\.101\.2\.3/g,
    "a made-up address in Tailscale's range, to test that the room recogniser finds one",
  ],
  "scripts/tessaya/apply-release-branding.sh": [
    /dev\\?\.rabee\\?\.baton/g,
    "the installed app's id; it stays until the public release (D8), or existing installs stop upgrading",
  ],
  "scripts/tessaya/upgrade-proof.ps1": [
    /dev\\\.rabee\\\.baton/g,
    "finds the installed app by that same id (D8)",
  ],
  "scripts/tessaya/stranger-proof.ps1": [
    /^\$private = '[^']*'$/gm,
    "carries this guard's own pattern, to check a built installer",
  ],
  "apps/desktop/src/baton/backup/backup.test.ts": [
    /sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789/g,
    "a made-up key, to prove a backup leaves secrets out",
  ],
  "apps/desktop/src/baton/cloud/vaultKey.test.ts": [
    /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    "a made-up key header, to prove the vault hands it over",
  ],
  "packages/tessaya-shared/src/memory.test.ts": [
    /ghp_abcdefghijklmnopqrstuvwxyz0123/g,
    "a made-up token, to prove memory refuses secrets",
  ],
};

const WINDOW = 4;
const sha = (words) => NodeCrypto.createHash("sha256").update(words.join(" ")).digest("hex");

export const phraseHits = (text, hashes) => {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i + WINDOW <= words.length; i++) {
    if (hashes.has(sha(words.slice(i, i + WINDOW)))) return true;
  }
  return false;
};

const tracked = () =>
  NodeChildProcess.execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

const read = (file) => {
  try {
    const full = NodePath.join(ROOT, file);
    return NodeFS.statSync(full).size > 2_000_000 ? null : NodeFS.readFileSync(full, "utf8");
  } catch {
    return null;
  }
};

const upstreamPaths = () => {
  try {
    const pin = NodeFS.readFileSync(NodePath.join(ROOT, PIN_FILE), "utf8").trim();
    const listed = NodeChildProcess.execFileSync("git", ["ls-tree", "-r", "--name-only", pin], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(listed.split("\n").filter(Boolean));
  } catch {
    return null;
  }
};

/** The text of ours in a file: a patch contributes only the lines it adds. */
const ours = (file, text) =>
  file.endsWith(".patch")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .join("\n")
    : text;

export const run = () => {
  const problems = [];
  const files = tracked();
  const upstream = upstreamPaths();
  // In CI the narrower fallback would pass silently: patches.sh verify fetches the pin first.
  if (upstream === null && process.env.CI)
    return [`${PIN_FILE}: the pin's tree is missing; run scripts/tessaya/patches.sh verify first`];
  const scanned = files.filter(
    (f) =>
      !SKIPPED.some((r) => r.test(f)) &&
      (upstream === null ? SHIPPED.some((p) => f.startsWith(p)) : !upstream.has(f)),
  );
  for (const file of scanned) {
    const text = read(file);
    if (text === null || text.includes("\u0000")) continue;
    const allowed = ALLOWED[file]?.[0];
    const body = allowed ? ours(file, text).replace(allowed, "") : ours(file, text);
    for (const [what, pattern] of PRIVATE)
      if (pattern.test(body)) problems.push(`${file}: ${what}`);
  }
  // A merge left unfinished must never reach main: this is what broke a release once.
  for (const file of files.filter(
    (f) => /\.(ts|tsx|mjs|js|json|md|yml|yaml)$/.test(f) && !f.startsWith(".repos/"),
  )) {
    const text = read(file);
    if (text !== null && /^(<<<<<<< |>>>>>>> )/m.test(text))
      problems.push(`${file}: an unfinished merge (conflict marker)`);
  }
  for (const [file, [pattern]] of Object.entries(ALLOWED)) {
    const text = read(file);
    if (text === null || text.match(pattern) === null)
      problems.push(`${file}: no longer needs its allow-list entry`);
  }
  const markers = new Set(
    (read("scripts/tessaya/private-markers.txt") ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{64}$/.test(l)),
  );
  if (markers.size > 0) {
    const own = [
      "docs/baton/",
      "packages/tessaya-",
      "apps/desktop/src/baton/",
      "apps/server/src/baton/",
      "scripts/tessaya/",
      "vendor-patches/",
    ];
    for (const file of files.filter(
      (f) => own.some((p) => f.startsWith(p)) && !f.endsWith("private-markers.txt"),
    )) {
      const text = read(file);
      if (text !== null && phraseHits(text, markers))
        problems.push(`${file}: a private pack phrase`);
    }
  }
  return problems;
};

if (process.argv[1] === import.meta.filename) {
  const problems = run();
  if (problems.length > 0) {
    console.error(
      `guard-private: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log("guard-private: ok");
}
