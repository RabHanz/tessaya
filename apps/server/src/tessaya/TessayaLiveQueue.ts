// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off
/**
 * The live-queue folder (`liveQueueDir()`) shared with `scripts/tessaya/live/baton-live-acp.mjs`. Text waiting to be
 * typed lives in the weave table (TessayaWeaveService); here are the bridge's side of it: `inbound.ndjson`, which it
 * appends to, the per-session files it shows `note` items from, and the old per-session text the server takes over.
 * shortcut: notes are read-modify-write without a lock, so one can lose to a drain that rewrites at the same instant.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { stateSubdir } from "@t3tools/tessaya-shared/stateDir";
import { envOf } from "@t3tools/tessaya-shared/envOf";

export const liveQueueDir = (): string =>
  envOf("LIVE_QUEUE_DIR") ?? stateSubdir(NodeOS.homedir(), "live-queue");

const safe = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
const queueFile = (dir: string, sessionId: string): string =>
  NodePath.join(dir, `${safe(sessionId)}.json`);

/** Adds one item at the end of a session's queue; returns how many are waiting. */
export const appendLiveQueue = (
  dir: string,
  sessionId: string,
  item: { readonly text: string; readonly shown: string; readonly kind?: "note" },
): number => {
  const file = queueFile(dir, sessionId);
  let items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) items = parsed;
  } catch {}
  items.push({ tries: 0, at: new Date().toISOString(), ...item });
  NodeFS.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(items), { mode: 0o600 });
  NodeFS.renameSync(temp, file);
  return items.length;
};

const INBOUND_FILE = "inbound.ndjson";
const OWNED_SUFFIX = ".server";

/** A message the bridge could not type at once, appended to `inbound.ndjson` for the server to queue. */
export interface InboundLine {
  readonly id: string;
  /** Epoch ms. */
  readonly at: number;
  readonly sessionId: string;
  /** A thread with no session bound: the text waits until it binds, then goes through the thread. */
  readonly unbound: boolean;
  readonly threadId: string | null;
  readonly label: string | null;
  readonly text: string;
}

const toInbound = (raw: unknown): InboundLine | null => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof r[key] === "string" ? (r[key] as string) : null);
  const id = str("id");
  const sessionId = str("sessionId");
  const text = str("text");
  if (id === null || sessionId === null || text === null || text.trim() === "") return null;
  return {
    id,
    at: typeof r["at"] === "number" ? r["at"] : 0,
    sessionId,
    unbound: r["unbound"] === true,
    threadId: str("threadId"),
    label: str("label"),
    text: text.trim(),
  };
};

/**
 * The complete lines after byte `offset`, and the offset after the last of them; a line still being written is left
 * for the next read. A file shorter than `offset` was replaced, so it is read from the start (ids keep that safe).
 */
export const readInbound = (
  dir: string,
  offset: number,
): { readonly lines: ReadonlyArray<InboundLine>; readonly next: number } => {
  let fd: number;
  try {
    fd = NodeFS.openSync(NodePath.join(dir, INBOUND_FILE), "r");
  } catch {
    return { lines: [], next: 0 };
  }
  try {
    const size = NodeFS.fstatSync(fd).size;
    const from = size < offset ? 0 : offset;
    if (size === from) return { lines: [], next: from };
    const bytes = Buffer.alloc(size - from);
    NodeFS.readSync(fd, bytes, 0, bytes.length, from);
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], next: from };
    const lines = bytes
      .subarray(0, end)
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const parsed = line.trim() === "" ? null : toInbound(JSON.parse(line));
          return parsed === null ? [] : [parsed];
        } catch {
          return [];
        }
      });
    return { lines, next: from + end + 1 };
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * The bridge's `.drain.lock` (`takeDrainLock` in baton-live-acp.mjs), so no bridge is mid-send while the server takes
 * a queue file over. One whose process is gone is taken over. Returns the release, or null when a drain is running.
 */
export const takeQueueLock = (dir: string): (() => void) | null => {
  const lock = NodePath.join(dir, ".drain.lock");
  const take = () => {
    try {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    let pid = 0;
    try {
      pid = Number(NodeFS.readFileSync(lock, "utf8"));
    } catch {}
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) return null;
    NodeFS.rmSync(lock, { force: true });
    if (!take()) return null;
  }
  return () => NodeFS.rmSync(lock, { force: true });
};

export interface QueueFile {
  readonly sessionId: string;
  readonly file: string;
  readonly texts: ReadonlyArray<{ readonly text: string; readonly at: string }>;
  readonly notes: ReadonlyArray<unknown>;
}

/** The per-session queue files that still hold text to type. Call with the lock held. */
export const readQueueFiles = (dir: string): ReadonlyArray<QueueFile> => {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = NodePath.join(dir, name);
    let items: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      return [];
    }
    const texts = items.flatMap((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return r["kind"] !== "note" && typeof r["text"] === "string" && r["text"].trim() !== ""
        ? [{ text: r["text"].trim(), at: typeof r["at"] === "string" ? r["at"] : "" }]
        : [];
    });
    if (texts.length === 0) return [];
    const notes = items.filter((raw) => (raw as { kind?: unknown } | null)?.kind === "note");
    return [{ sessionId: name.slice(0, -".json".length), file, texts, notes }];
  });
};

/** Moves a store the server has taken over aside, never deleting his words. */
export const moveAside = (file: string, now: number): void => {
  try {
    NodeFS.renameSync(file, `${file}.migrated-${now}`);
  } catch {}
};

/** A queue file taken over: moved aside, with its notes (shown, never typed) left for the bridge to show. */
export const takeOverQueueFile = (q: QueueFile, now: number): void => {
  moveAside(q.file, now);
  if (q.notes.length === 0) return;
  const temp = `${q.file}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(q.notes), { mode: 0o600 });
  NodeFS.renameSync(temp, q.file);
};

/**
 * The ownership marker: `<sessionId>.server` names a session whose waiting messages the server owns. The bridge's
 * drainer never types for such a session, and the bridge queues a new message behind them instead of typing it.
 */
/** The ownership markers there now; read before counting, so one written meanwhile is never removed. */
export const listOwned = (dir: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(dir).filter((name) => name.endsWith(OWNED_SUFFIX));
  } catch {
    return [];
  }
};

export const writeOwned = (
  dir: string,
  waiting: ReadonlyMap<string, number>,
  names: ReadonlyArray<string>,
): void => {
  const keep = new Set([...waiting.keys()].map(safe));
  for (const name of names) {
    if (!keep.has(name.slice(0, -OWNED_SUFFIX.length)))
      NodeFS.rmSync(NodePath.join(dir, name), { force: true });
  }
  if (waiting.size > 0) NodeFS.mkdirSync(dir, { recursive: true });
  for (const [sessionId, count] of waiting) {
    const file = NodePath.join(dir, `${safe(sessionId)}${OWNED_SUFFIX}`);
    NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify({ waiting: count }), { mode: 0o600 });
    NodeFS.renameSync(`${file}.tmp`, file);
  }
};

const SERVER_LOCK = ".server.lock";
/** A server lock not touched for this long belongs to a server that stopped, whatever its pid says now. */
export const SERVER_LOCK_STALE_MS = 30_000;

const readLock = (file: string): { pid: number; token: string; mtimeMs: number } | null => {
  try {
    const raw = JSON.parse(NodeFS.readFileSync(file, "utf8")) as { pid?: unknown; token?: unknown };
    return {
      pid: typeof raw.pid === "number" ? raw.pid : 0,
      token: typeof raw.token === "string" ? raw.token : "",
      mtimeMs: NodeFS.statSync(file).mtimeMs,
    };
  } catch {
    return null;
  }
};

/** Only a pid the system says does not exist is dead: EPERM (someone else's process) counts as alive. */
const pidGone = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/**
 * The live-queue folder's owner, by heartbeat: the owner touches `<dir>/.server.lock` (its pid and a random token) on
 * every pass, and a lock untouched for 30 s, or whose pid is gone, is stale. A stale lock is renamed to a name only
 * this caller uses (one rename wins), then the lock is created with O_EXCL; a fresh lock taken by mistake is linked
 * back. Ownership lasts only while the file holds this token. Works the same on Windows (no /proc).
 */
export const holdServerLock = (
  dir: string,
  token: string,
  now: number = Date.now(),
): { readonly owned: boolean; readonly holder: number | null } => {
  const file = NodePath.join(dir, SERVER_LOCK);
  const create = (): boolean => {
    try {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
      NodeFS.utimesSync(file, new Date(now), new Date(now));
      return readLock(file)?.token === token;
    } catch {
      return false;
    }
  };
  const held = readLock(file);
  if (held?.token === token) {
    try {
      NodeFS.utimesSync(file, new Date(now), new Date(now));
    } catch {}
    return { owned: true, holder: process.pid };
  }
  if (held === null)
    return create()
      ? { owned: true, holder: process.pid }
      : { owned: false, holder: readLock(file)?.pid ?? null };
  if (now - held.mtimeMs <= SERVER_LOCK_STALE_MS && !pidGone(held.pid))
    return { owned: false, holder: held.pid };
  const aside = `${file}.stale-${token}`;
  try {
    NodeFS.renameSync(file, aside);
  } catch {
    return { owned: false, holder: readLock(file)?.pid ?? null };
  }
  const taken = readLock(aside);
  if (taken?.token !== held.token) {
    // Another server took the stale lock first and this rename moved its fresh one: give it back.
    try {
      NodeFS.linkSync(aside, file);
    } catch {}
    NodeFS.rmSync(aside, { force: true });
    return { owned: false, holder: taken?.pid ?? null };
  }
  NodeFS.rmSync(aside, { force: true });
  return create()
    ? { owned: true, holder: process.pid }
    : { owned: false, holder: readLock(file)?.pid ?? null };
};

/** Lets the lock go, only when it is still this token's. */
export const releaseServerLock = (dir: string, token: string): void => {
  const file = NodePath.join(dir, SERVER_LOCK);
  if (readLock(file)?.token === token) NodeFS.rmSync(file, { force: true });
};
