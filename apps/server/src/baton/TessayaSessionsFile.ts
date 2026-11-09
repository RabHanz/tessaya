// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Which Claude session each Tessaya thread holds, in a small file beside the state database, so `tessaya resume
 * <thread>` can open a thread's session in a terminal with the server down (never by opening the live database).
 * The server rewrites it when it changes; the file is a convenience copy, the database stays the record.
 */
import * as NodeFS from "node:fs";

export interface SessionHome {
  readonly threadId: string;
  readonly title: string;
  readonly sessionId: string;
  readonly cwd: string;
  /** The Claude config dir of the thread's account: a terminal resume runs on that login. */
  readonly configDir: string;
  /** The Tessaya instance and model the thread returns to when its terminal closes. */
  readonly instanceId: string;
  readonly model: string;
  /** Open in a terminal now: the thread follows the terminal session until it ends. */
  readonly inTerminal: boolean;
  /** When it was opened in a terminal (ms); 0 when it is not. */
  readonly openedAt: number;
}

export const SESSIONS_FILE = "tessaya-sessions.json";

export const renderSessionsFile = (homes: Iterable<SessionHome>): string =>
  `${JSON.stringify(
    {
      version: 1,
      threads: [...homes].toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
    },
    null,
    1,
  )}\n`;

export const parseSessionsFile = (text: string): ReadonlyArray<SessionHome> => {
  try {
    const parsed = JSON.parse(text) as { threads?: unknown };
    return Array.isArray(parsed.threads)
      ? (parsed.threads as Array<SessionHome>).filter(
          (home) =>
            typeof home?.threadId === "string" &&
            typeof home.sessionId === "string" &&
            typeof home.cwd === "string" &&
            typeof home.configDir === "string" &&
            typeof home.instanceId === "string",
        )
      : [];
  } catch {
    return [];
  }
};

export const readSessionsFile = (path: string): ReadonlyArray<SessionHome> => {
  try {
    return parseSessionsFile(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return [];
  }
};

/** Writes only when the content changed, through a rename so a reader never sees half a file. */
export const writeSessionsFile = (path: string, homes: Iterable<SessionHome>): boolean => {
  const text = renderSessionsFile(homes);
  try {
    if (NodeFS.readFileSync(path, "utf8") === text) return false;
  } catch {}
  const tmp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, text, { mode: 0o600 });
  NodeFS.renameSync(tmp, path);
  return true;
};

/** A terminal that never showed up within this long after opening counts as closed. */
export const OPEN_GRACE_MS = 90_000;
/** And a running one must be gone from every read for this long before the thread goes back. */
export const CLOSED_GRACE_MS = 10_000;

/**
 * Whether a thread open in a terminal goes back to Tessaya now: its terminal session was seen and has been gone for
 * CLOSED_GRACE_MS, or it never started within OPEN_GRACE_MS.
 */
export const handBackDue = (input: {
  readonly home: SessionHome;
  readonly running: boolean;
  /** When the session was first seen missing since it last ran, or null. */
  readonly missingSince: number | null;
  readonly seenRunning: boolean;
  readonly nowMs: number;
}): boolean =>
  input.home.inTerminal &&
  !input.running &&
  (input.seenRunning
    ? input.missingSince !== null && input.nowMs - input.missingSince >= CLOSED_GRACE_MS
    : input.nowMs - input.home.openedAt >= OPEN_GRACE_MS);
