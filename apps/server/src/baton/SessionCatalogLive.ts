// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalTimers:off
/** The real machine behind the session catalog: Claude's transcripts, the history index, `baton`, Herdr. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { askHistory } from "@t3tools/tessaya-shared/historyIndex";
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
const FOLDERS_AT_ONCE = 16;

/**
 * Every transcript's mtime (a box holds 130,000): a folder is listed again only when its mtime moved, a file looked at
 * only when written in the last day or running now, everything every 10 minutes. Asynchronous: done synchronously the
 * full pass blocked the event loop 3 to 4 s every 10 minutes (14 Nov). shortcut: a day-old transcript of an ended
 * session is seen at the next full pass.
 */
export const scanTranscriptTimes = async (
  configDirs: ReadonlyArray<string>,
  liveIds: ReadonlySet<string>,
  before: TranscriptScan | null,
  now: number,
): Promise<TranscriptScan> => {
  const full = before === null || now - before.at >= FULL_SCAN_MS;
  const fs = NodeFS.promises;
  const scanFolder = async (
    folder: string,
    account: string | null,
  ): Promise<readonly [string, ScanFolder] | null> => {
    const mtime = await fs.stat(folder).then(
      (s) => s.mtimeMs,
      () => null,
    );
    if (mtime === null) return null;
    const prior = full ? undefined : before.folders.get(folder);
    const names =
      prior !== undefined && prior.mtime === mtime
        ? [...prior.files.keys()]
        : await fs.readdir(folder).then(
            (all) => all.filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n)),
            () => null,
          );
    if (names === null) return null;
    const files = new Map<string, number>();
    await Promise.all(
      names.map(async (name) => {
        const seen = prior?.files.get(name);
        if (seen !== undefined && now - seen > ACTIVE_MS && !liveIds.has(name.slice(0, -6))) {
          files.set(name, seen);
          return;
        }
        // Gone between listing and reading: left out.
        await fs.stat(NodePath.join(folder, name)).then(
          (s) => void files.set(name, s.mtimeMs),
          () => undefined,
        );
      }),
    );
    return [folder, { mtime, account, files }];
  };
  const folders = new Map<string, ScanFolder>();
  for (const dir of configDirs) {
    const root = NodePath.join(dir, "projects");
    const slugs = await fs.readdir(root).catch(() => null);
    if (slugs === null) continue;
    const account = accountOfConfigDir(dir);
    for (let i = 0; i < slugs.length; i += FOLDERS_AT_ONCE) {
      const done = await Promise.all(
        slugs
          .slice(i, i + FOLDERS_AT_ONCE)
          .map((slug) => scanFolder(NodePath.join(root, slug), account)),
      );
      for (const entry of done) if (entry !== null) folders.set(entry[0], entry[1]);
    }
  }
  return { at: full ? now : before.at, folders };
};

let scanned: TranscriptScan | null = null;
let scanning: Promise<ReadonlyArray<TranscriptInfo>> | null = null;

const scanTranscripts = async (
  limit: number,
  liveIds: ReadonlySet<string>,
): Promise<ReadonlyArray<TranscriptInfo>> => {
  scanned = await scanTranscriptTimes(claudeConfigDirs(), liveIds, scanned, Date.now());
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
    // Calls that arrive while a scan runs share it.
    scanning ??= (async () => {
      const live = await Effect.runPromise(readAllProfileLiveSessions());
      const rows = await scanTranscripts(
        Math.max(limit, 600),
        new Set(live.map((s) => s.sessionId)),
      );
      cached = { at: now, limit: Math.max(limit, 600), rows };
      return rows;
    })().finally(() => {
      scanning = null;
    });
    return (await scanning).slice(0, limit);
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
    // Always after `transcripts`, which scans; before any scan nothing is taken to be gone.
    if (scanned === null) return true;
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
