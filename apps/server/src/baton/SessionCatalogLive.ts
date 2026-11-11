// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalTimers:off
/** The real machine behind the session catalog: Claude's transcripts, the history index, `baton`, Herdr. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { askHistory } from "@t3tools/baton-shared/historyIndex";
import * as Effect from "effect/Effect";

import {
  accountOfConfigDir,
  claudeConfigDirs,
  readAllProfileLiveSessions,
} from "./ClaudeLiveSessions.ts";
import type { CatalogPorts, TranscriptInfo } from "./SessionCatalog.ts";
import { isBackgroundRun, parseHistoryHits, readTranscriptHead } from "./SessionCatalogParse.ts";

const HEAD_BYTES = 48 * 1024;

interface ScanFolder {
  readonly mtime: number;
  readonly account: string | null;
  /** Transcript file name -> its mtime when last looked at. */
  readonly files: ReadonlyMap<string, number>;
}
export interface TranscriptScan {
  readonly at: number;
  readonly folders: ReadonlyMap<string, ScanFolder>;
}

const FULL_SCAN_MS = 10 * 60_000;
const ACTIVE_MS = 24 * 60 * 60_000;

/**
 * Every transcript's mtime without stat'ing them all each time (a box holds 130,000; a full pass blocks the event
 * loop for seconds). A project folder is listed again only when its own mtime moved (a file came or went), and a file
 * is looked at again only when it was written in the last day or its session runs now. Everything every 10 minutes.
 * shortcut: a day-old transcript written to by a session that has since ended is seen at the next full pass, not sooner.
 */
export const scanTranscriptTimes = (
  configDirs: ReadonlyArray<string>,
  liveIds: ReadonlySet<string>,
  before: TranscriptScan | null,
  now: number,
): TranscriptScan => {
  const full = before === null || now - before.at >= FULL_SCAN_MS;
  const folders = new Map<string, ScanFolder>();
  for (const dir of configDirs) {
    const root = NodePath.join(dir, "projects");
    let slugs: string[] = [];
    try {
      slugs = NodeFS.readdirSync(root);
    } catch {
      continue;
    }
    const account = accountOfConfigDir(dir);
    for (const slug of slugs) {
      const folder = NodePath.join(root, slug);
      let mtime: number;
      try {
        mtime = NodeFS.statSync(folder).mtimeMs;
      } catch {
        continue;
      }
      const prior = full ? undefined : before.folders.get(folder);
      let names: ReadonlyArray<string>;
      if (prior !== undefined && prior.mtime === mtime) names = [...prior.files.keys()];
      else {
        try {
          names = NodeFS.readdirSync(folder).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n));
        } catch {
          continue;
        }
      }
      const files = new Map<string, number>();
      for (const name of names) {
        const seen = prior?.files.get(name);
        if (seen !== undefined && now - seen > ACTIVE_MS && !liveIds.has(name.slice(0, -6))) {
          files.set(name, seen);
          continue;
        }
        try {
          files.set(name, NodeFS.statSync(NodePath.join(folder, name)).mtimeMs);
        } catch {
          // gone between listing and reading
        }
      }
      folders.set(folder, { mtime, account, files });
    }
  }
  return { at: full ? now : before.at, folders };
};

let scanned: TranscriptScan | null = null;

const scanTranscripts = (
  limit: number,
  liveIds: ReadonlySet<string>,
): ReadonlyArray<TranscriptInfo> => {
  scanned = scanTranscriptTimes(claudeConfigDirs(), liveIds, scanned, Date.now());
  const found: Array<{ file: string; id: string; mtime: number; account: string | null }> = [];
  for (const [folder, { account, files }] of scanned.folders)
    for (const [name, mtime] of files)
      found.push({ file: NodePath.join(folder, name), id: name.slice(0, -6), mtime, account });
  const out: TranscriptInfo[] = [];
  const seen = new Set<string>();
  for (const f of found.toSorted((a, b) => b.mtime - a.mtime)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (out.length >= limit) break;
    let head = "";
    try {
      const fd = NodeFS.openSync(f.file, "r");
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, NodeFS.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
      NodeFS.closeSync(fd);
    } catch {
      continue;
    }
    const { cwd, title, entrypoint } = readTranscriptHead(head);
    out.push({
      sessionId: f.id,
      cwd,
      title,
      lastActivityAt: new Date(f.mtime).toISOString(),
      account: f.account,
      file: f.file,
      background: isBackgroundRun({ cwd, entrypoint, title }),
    });
  }
  return out;
};

let cached: { at: number; limit: number; rows: ReadonlyArray<TranscriptInfo> } | null = null;

const localBin = (name: string) => NodePath.join(NodeOS.homedir(), ".local", "bin", name);
// A box whose launchers predate the rename has only `baton`.
export const TESSAYA_CLI =
  process.env["TESSAYA_BIN"] ??
  process.env["BATON_BIN"] ??
  (NodeFS.existsSync(localBin("tessaya")) ? localBin("tessaya") : localBin("baton"));

export const realCatalogPorts = (type: CatalogPorts["type"]): CatalogPorts => ({
  machine: NodeOS.hostname(),
  live: () => Effect.runPromise(readAllProfileLiveSessions()),
  // A box can hold tens of thousands of transcripts: one scan serves every call for a few seconds.
  transcripts: async (limit) => {
    const now = Date.now();
    if (cached !== null && now - cached.at < 15_000 && cached.limit >= limit)
      return cached.rows.slice(0, limit);
    const live = await Effect.runPromise(readAllProfileLiveSessions());
    const rows = scanTranscripts(Math.max(limit, 600), new Set(live.map((s) => s.sessionId)));
    cached = { at: now, limit: Math.max(limit, 600), rows };
    return rows.slice(0, limit);
  },
  history: async (query) => {
    const answer = await askHistory(process.env, { query });
    return answer.ok ? parseHistoryHits(answer.text) : [];
  },
  readTail: async (file) => {
    const fd = NodeFS.openSync(file, "r");
    try {
      const size = NodeFS.fstatSync(fd).size;
      const length = Math.min(size, 96 * 1024);
      const buf = Buffer.alloc(length);
      NodeFS.readSync(fd, buf, 0, length, size - length);
      return buf.toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  },
  dirExists: (dir) => {
    try {
      return NodeFS.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  baton: (args) =>
    new Promise((resolve) =>
      NodeChildProcess.execFile(
        TESSAYA_CLI,
        [...args],
        {
          timeout: 45_000,
          env: {
            ...process.env,
            PATH: `${NodePath.dirname(TESSAYA_CLI)}:${process.env["PATH"] ?? ""}`,
          },
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({ ok: error === null, out: `${stdout}${stderr}`.trim() }),
      ),
    ),
  hasTranscript: (sessionId) => {
    scanned ??= scanTranscriptTimes(claudeConfigDirs(), new Set(), null, Date.now());
    for (const { files } of scanned.folders.values())
      if (files.has(`${sessionId}.jsonl`)) return true;
    return false;
  },
  type,
  screen: (session, pane) =>
    new Promise((resolve) =>
      NodeChildProcess.execFile(
        "herdr",
        ["--session", session, "agent", "read", pane, "--source", "visible", "--lines", "25"],
        { timeout: 8_000, windowsHide: true },
        (_e, stdout) => resolve(stdout),
      ),
    ),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

/**
 * The kept-messages file: `{ sessionId: [text, ...] }`. Missing is empty. Anything unreadable or of another shape is
 * moved aside (never silently replaced, since it holds his words) and reported, and the catalog starts empty.
 */
export const readKeptFile = (
  file: string,
): { readonly kept: Record<string, ReadonlyArray<string>>; readonly problem: string | null } => {
  let raw: string | null = null;
  try {
    raw = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kept: {}, problem: null };
  }
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every(
        (texts) => Array.isArray(texts) && texts.every((text) => typeof text === "string"),
      )
    )
      return { kept: parsed as Record<string, ReadonlyArray<string>>, problem: null };
  } catch {}
  const aside = `${file}.bad-${Date.now()}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  try {
    NodeFS.renameSync(file, aside);
  } catch {}
  return {
    kept: {},
    problem: `${file} ${raw === null ? "could not be read" : "was not a kept-messages file"}; moved to ${aside}`,
  };
};
