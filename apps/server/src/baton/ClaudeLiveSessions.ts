/* oxlint-disable t3code/prefer-effect-fn -- Baton file (D82) */
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off globalDate:off
/**
 * Live Claude Code sessions on this machine, read from Claude Code's own
 * per-process descriptors (D68). Read-only: the `.key` files beside them are
 * never opened.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeLiveSession } from "@t3tools/baton-contracts";
import * as Effect from "effect/Effect";

const DEFAULT_SESSIONS_DIR = NodePath.join(NodeOS.homedir(), ".claude", "sessions");

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** Herdr panes carry `HERDR_SESSION` + `HERDR_PANE_ID`; the default session needs no prefix. */
export const herdrPaneRef = (env: ReadonlyMap<string, string>): string | null => {
  const pane = env.get("HERDR_PANE_ID");
  if (pane === undefined || pane.length === 0) return null;
  const session = env.get("HERDR_SESSION");
  return session === undefined || session === "" || session === "default"
    ? pane
    : `${session}~${pane}`;
};

/** One descriptor, or null when it is not a live interactive session. */
export const parseClaudeSessionDescriptor = (
  json: string,
  input: {
    readonly alive: (pid: number) => boolean;
    readonly env: (pid: number) => ReadonlyMap<string, string>;
    readonly account: string | null;
  },
): ClaudeLiveSession | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const d = parsed as Record<string, unknown>;
  const pid = d["pid"];
  const sessionId = str(d["sessionId"]);
  const cwd = str(d["cwd"]);
  if (typeof pid !== "number" || sessionId === null || cwd === null) return null;
  // `claude -p` workers are not sessions anyone talks to.
  if (str(d["kind"]) !== "interactive") return null;
  // SDK-driven sessions belong to the program that runs them (T3 threads, automation);
  // nobody types into them and adopting one would kill its owner's work.
  if ((str(d["entrypoint"]) ?? "").startsWith("sdk")) return null;
  if (!input.alive(pid)) return null;
  const updated = d["updatedAt"];
  return {
    pid,
    sessionId,
    cwd,
    name: str(d["name"]),
    ...(str(d["nameSource"]) === null ? {} : { nameSource: str(d["nameSource"])! }),
    status: str(d["status"]),
    entrypoint: str(d["entrypoint"]),
    herdrPane: herdrPaneRef(input.env(pid)),
    tmux: str(d["tmux"]),
    account: input.account,
    updatedAt: typeof updated === "number" ? new Date(updated).toISOString() : null,
  };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const environOf = (pid: number): ReadonlyMap<string, string> => {
  try {
    const raw = NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8");
    const map = new Map<string, string>();
    for (const entry of raw.split("\0")) {
      const at = entry.indexOf("=");
      // Only Herdr's routing variables are kept; nothing else leaves /proc.
      if (at > 0 && entry.startsWith("HERDR_")) map.set(entry.slice(0, at), entry.slice(at + 1));
    }
    return map;
  } catch {
    return new Map();
  }
};

/**
 * Every Claude config directory a session can run under (D83): `~/.claude`, each claude-swap
 * account profile (`cswap run`), any `~/.claude-*` with a sessions folder, and
 * `BATON_CLAUDE_CONFIG_DIRS` (colon-separated).
 */
export const claudeConfigDirs = (): ReadonlyArray<string> => {
  const home = NodeOS.homedir();
  const dirs = [NodePath.join(home, ".claude")];
  const add = (parent: string, filter: (name: string) => boolean) => {
    try {
      for (const name of NodeFS.readdirSync(parent)) {
        if (filter(name)) dirs.push(NodePath.join(parent, name));
      }
    } catch {}
  };
  add(NodePath.join(home, ".local", "share", "claude-swap", "sessions"), () => true);
  add(home, (name) => name.startsWith(".claude-"));
  for (const extra of (process.env.BATON_CLAUDE_CONFIG_DIRS ?? "").split(NodePath.delimiter)) {
    if (extra.length > 0) dirs.push(extra);
  }
  // A profile with transcripts but no live-session folder (nothing running yet, or a fresh machine) still counts.
  return [...new Set(dirs)].filter(
    (dir) =>
      NodeFS.existsSync(NodePath.join(dir, "sessions")) ||
      NodeFS.existsSync(NodePath.join(dir, "projects")),
  );
};

/** The signed-in account of a config directory: its `oauthAccount` address, before the `@`. */
export const accountOfConfigDir = (dir: string): string | null => {
  const home = NodeOS.homedir();
  // Claude Code keeps the default profile's identity in ~/.claude.json, a custom one's inside it.
  const file =
    dir === NodePath.join(home, ".claude")
      ? NodePath.join(home, ".claude.json")
      : NodePath.join(dir, ".claude.json");
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const email = parsed.oauthAccount?.emailAddress;
    return typeof email === "string" && email.includes("@") ? email.split("@")[0]! : null;
  } catch {
    return null;
  }
};

/** Where tessaya-claude keeps each conversation's own config dir (LIVE-ACCOUNT). */
export const THREAD_DIRS_ROOT =
  process.env.TESSAYA_CLAUDE_THREADS ??
  NodePath.join(NodeOS.homedir(), ".local", "share", "tessaya", "claude-threads");

/** A conversation's own config dir: one tessaya-claude made, so its login can be switched while it runs. */
export const isThreadConfigDir = (dir: string | null | undefined): dir is string =>
  dir !== null && dir !== undefined && dir.startsWith(`${THREAD_DIRS_ROOT}${NodePath.sep}`);

/** The thread dirs, each once (the `s-<id>` names that link to a dir are skipped). */
const threadConfigDirs = (): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(THREAD_DIRS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => NodePath.join(THREAD_DIRS_ROOT, entry.name));
  } catch {
    return [];
  }
};

const CSWAP_SEQUENCE = NodePath.join(
  NodeOS.homedir(),
  ".local",
  "share",
  "claude-swap",
  "sequence.json",
);

/** The cswap slot a thread dir holds (written by tessaya-claude), or null when it is not known. */
export const threadDirSlot = (dir: string): string | null => {
  try {
    const slot = NodeFS.readFileSync(NodePath.join(dir, ".tessaya-account"), "utf8").trim();
    return /^\d{1,4}$/.test(slot) ? slot : null;
  } catch {
    return null;
  }
};

/** A thread dir's account: its slot's address before the `@`, from cswap's registry. */
const threadDirAccount = (dir: string): string | null => {
  const slot = threadDirSlot(dir);
  if (slot === null) return accountOfConfigDir(dir);
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(CSWAP_SEQUENCE, "utf8")) as {
      accounts?: Record<string, { email?: unknown }>;
    };
    const email = parsed.accounts?.[slot]?.email;
    return typeof email === "string" && email.includes("@") ? email.split("@")[0]! : null;
  } catch {
    return null;
  }
};

/** A resume of `sessionId` finds the dir that hosted it (tessaya-claude looks for `s-<id>`). */
const linkSessionDir = (dir: string, sessionId: string): void => {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sessionId)) return;
  const link = NodePath.join(THREAD_DIRS_ROOT, `s-${sessionId}`);
  if (NodePath.resolve(dir) === link) return;
  try {
    NodeFS.symlinkSync(dir, link);
  } catch {}
};

/**
 * Tessaya's own helper sessions (the assistant, rewrites, an account's login) run Claude in a folder under the app's
 * data directory (.t3). They are not the user's work: they must not become threads or catalog rows.
 */
export const isTessayaOwnFolder = (cwd: string | null | undefined): boolean =>
  cwd !== null && cwd !== undefined && /(^|\/)\.t3(\/|$)/i.test(cwd.replace(/\\/g, "/"));

/** Sessions under every config directory, each with its own account (the live-thread mirror). */
export const readAllProfileLiveSessions = (): Effect.Effect<ReadonlyArray<ClaudeLiveSession>> =>
  Effect.gen(function* () {
    const home = NodePath.join(NodeOS.homedir(), ".claude");
    const all: Array<ClaudeLiveSession> = [];
    for (const dir of [...claudeConfigDirs(), ...threadConfigDirs()]) {
      const thread = isThreadConfigDir(dir);
      const found = yield* readClaudeLiveSessions({
        account: thread ? threadDirAccount(dir) : accountOfConfigDir(dir),
        dir: NodePath.join(dir, "sessions"),
      });
      for (const session of found) {
        if (isTessayaOwnFolder(session.cwd)) continue;
        if (thread) linkSessionDir(dir, session.sessionId);
        all.push(dir === home ? session : { ...session, configDir: dir });
      }
    }
    return all;
  });

export const readClaudeLiveSessions = (input: {
  readonly account: string | null;
  readonly dir?: string;
}): Effect.Effect<ReadonlyArray<ClaudeLiveSession>> =>
  Effect.sync(() => {
    const dir = input.dir ?? DEFAULT_SESSIONS_DIR;
    let names: Array<string>;
    try {
      names = NodeFS.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
    } catch {
      return [];
    }
    const sessions: Array<ClaudeLiveSession> = [];
    for (const name of names) {
      let json: string;
      try {
        json = NodeFS.readFileSync(NodePath.join(dir, name), "utf8");
      } catch {
        continue;
      }
      const session = parseClaudeSessionDescriptor(json, {
        alive,
        env: environOf,
        account: input.account,
      });
      if (session !== null) sessions.push(session);
    }
    return sessions.toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  });
