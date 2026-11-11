// @effect-diagnostics nodeBuiltinImport:off
/**
 * Back up and restore Tessaya's own data for moving machines: settings, vocabulary, snippets, notes, transforms,
 * style, commitments, the pack, the memory notes and the private stores (ciphertext only). Never the vault (it has
 * its own encrypted export), sign-ins, recordings, logs, or a file holding a secret. A restore is previewed first
 * and replaces a file only after keeping it as .bak.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { detectSecret, type MemoryChange, type MemoryItem } from "@t3tools/baton-shared/memory";

import { makeZip, readZip, type ZipEntry } from "./zip.ts";

const FILES = [
  "fabric-voice.json",
  "voice/dictionary.json",
  "snippets.json",
  "scratchpad.json",
  "transforms.json",
  "writing-style.json",
  "commitments.json",
  "initiative.json",
  "playbooks.json",
  "standing-jobs.json",
  "baton-conversation.ndjson",
  "baton-conversation.ndjson.1",
];
/** A backup from before P2 holds the one shared conversation: it restores as the lead's, as the first start moves it. */
const MOVED: Readonly<Record<string, string>> = {
  "baton-conversation.ndjson": "conversation/executive.ndjson",
  "baton-conversation.ndjson.1": "conversation/executive.ndjson.1",
};
const DIRS: ReadonlyArray<{ readonly dir: string; readonly ext: RegExp }> = [
  { dir: "memory", ext: /\.md$/ },
  { dir: "conversation", ext: /\.ndjson(\.1)?$/ },
  { dir: "operating-system", ext: /\.(md|json)$/ },
  { dir: "operating-system/roles", ext: /\.md$/ },
];
/** The server's memory items as JSON, written into the zip alongside the files; restore hands them back to the server. */
export const SERVER_MEMORY_NAME = "memory-server.json";
/** The private memory stores as the server's own dump: ciphertext and wrapped keys, opened by each store's recovery code. */
export const PRIVATE_MEMORY_NAME = "private-memory.json";
/** Older backups carried a lossy markdown export; it still restores as a plain file. */
const LEGACY_SERVER_MEMORY_NAME = "memory-server.md";
const NEVER = /^(vault|\.|.*token|.*secret|.*auth)/i;

export interface BackupPlan {
  readonly entries: ReadonlyArray<ZipEntry>;
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly why: string }>;
}

const read = (file: string): Buffer | null => {
  try {
    return NodeFS.readFileSync(file);
  } catch {
    return null;
  }
};

export const planBackup = (
  stateDir: string,
  serverMemory: ReadonlyArray<MemoryItem> | null,
  privateDump: string | null = null,
): BackupPlan => {
  const names = [
    ...FILES,
    ...DIRS.flatMap(({ dir, ext }) => {
      try {
        return NodeFS.readdirSync(NodePath.join(stateDir, dir))
          .filter((n) => ext.test(n) && !NEVER.test(n))
          .map((n) => `${dir}/${n}`);
      } catch {
        return [];
      }
    }),
  ];
  const entries: ZipEntry[] = [];
  const skipped: Array<{ name: string; why: string }> = [];
  for (const name of names) {
    const data = read(NodePath.join(stateDir, ...name.split("/")));
    if (data === null) continue;
    const secret = detectSecret(data.toString("utf8"));
    if (secret !== null) skipped.push({ name, why: `it looks like it holds ${secret}` });
    else entries.push({ name, data });
  }
  if (serverMemory !== null && serverMemory.length > 0) {
    const text = JSON.stringify(serverMemory);
    const secret = detectSecret(text);
    if (secret === null) {
      entries.push({ name: SERVER_MEMORY_NAME, data: Buffer.from(text, "utf8") });
    } else skipped.push({ name: SERVER_MEMORY_NAME, why: `it looks like it holds ${secret}` });
  }
  // Ciphertext only, so it is not searched for secrets: random bytes would look like one.
  if (privateDump !== null)
    entries.push({ name: PRIVATE_MEMORY_NAME, data: Buffer.from(privateDump, "utf8") });
  return { entries, skipped };
};

export const writeBackup = (file: string, plan: BackupPlan): number => {
  const zip = makeZip(plan.entries);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, zip);
  return plan.entries.length;
};

/** Only a name this module could have written: relative, no climbing, on the allow list. */
export const allowedName = (name: string): boolean =>
  // Windows reads `\` as a separator and `c:` as a drive, so `memory/..\..\x.md` would climb out.
  !/[\\:\0]/.test(name) &&
  !name.split("/").includes("..") &&
  (name === SERVER_MEMORY_NAME ||
    name === PRIVATE_MEMORY_NAME ||
    name === LEGACY_SERVER_MEMORY_NAME ||
    FILES.includes(name) ||
    DIRS.some(
      ({ dir, ext }) =>
        name.startsWith(`${dir}/`) &&
        !name.slice(dir.length + 1).includes("/") &&
        ext.test(name) &&
        !NEVER.test(NodePath.basename(name)),
    ));

export interface RestoreRow {
  readonly name: string;
  /** The name in the zip, when it restores under another (`MOVED`). */
  readonly from?: string;
  readonly action: "new" | "replaces" | "same" | "refused";
}

export interface RestorePreview {
  readonly entries: ReadonlyArray<ZipEntry>;
  readonly rows: ReadonlyArray<RestoreRow>;
}

/** What a restore would do, touching nothing. An Error when the zip cannot be read. */
export const previewRestore = (zipBytes: Buffer, stateDir: string): RestorePreview | Error => {
  const entries = readZip(zipBytes);
  if (entries instanceof Error) return entries;
  const rows = entries.map((e): RestoreRow => {
    if (!allowedName(e.name)) return { name: e.name, action: "refused" };
    const name = MOVED[e.name] ?? e.name;
    const have = read(NodePath.join(stateDir, ...name.split("/")));
    return {
      name,
      ...(name === e.name ? {} : { from: e.name }),
      action: have === null ? "new" : have.equals(e.data) ? "same" : "replaces",
    };
  });
  return { entries, rows };
};

/** Writes what the preview listed. A replaced file is kept as `<name>.bak` first. */
export const applyRestore = (preview: RestorePreview, stateDir: string): number => {
  let written = 0;
  for (const row of preview.rows) {
    if (row.action === "refused" || row.action === "same") continue;
    const data = preview.entries.find((e) => e.name === (row.from ?? row.name))!.data;
    const target = NodePath.join(stateDir, ...row.name.split("/"));
    if (!NodePath.resolve(target).startsWith(NodePath.resolve(stateDir) + NodePath.sep)) continue;
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    if (row.action === "replaces") NodeFS.copyFileSync(target, `${target}.bak`);
    NodeFS.writeFileSync(target, data);
    written += 1;
  }
  return written;
};

/**
 * The backup's memory items as a sync push from a "backup" peer, so ids, his source, pins and
 * history come back as they were, and every item passes the server's door again. Null when the file
 * is not a list of items.
 */
export const memoryRestore = (
  data: Buffer,
  nowIso: string,
): {
  readonly from: string;
  readonly changes: ReadonlyArray<MemoryChange>;
  readonly upTo: string;
} | null => {
  try {
    const items = JSON.parse(data.toString("utf8")) as unknown;
    if (!Array.isArray(items)) return null;
    const changes = items
      .filter(
        (i): i is MemoryItem =>
          typeof i === "object" && i !== null && typeof (i as MemoryItem).id === "string",
      )
      .map((item) => ({ item, tombstone: null, writer: "backup" }));
    return { from: "backup", changes, upTo: nowIso };
  } catch {
    return null;
  }
};
