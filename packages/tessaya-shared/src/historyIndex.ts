// @effect-diagnostics nodeBuiltinImport:off
/**
 * Asking the history index (D150, cross-venture learnings): the one searchable record of past work lives
 * elsewhere, and this only reads it through the script the maintainer's box provides. Tessaya keeps no second
 * history store, never copies a transcript, and never writes to the index. Node-only.
 */
import * as NodeChildProcess from "node:child_process";

export const HISTORY_ENV = "BATON_HISTORY_SEARCH";
const OUTPUT_MAX = 6_000;
const SESSION = /^[0-9a-fA-F][0-9a-fA-F-]{5,63}$/;
const TIMEOUT_MS = 15_000;
/** For another server's ask: under that server's wait for this one's answer. */
export const PEER_ASK_TIMEOUT_MS = 8_000;

type Runner = (file: string, args: ReadonlyArray<string>) => Promise<string>;

/** The script run with no shell, a time limit and a size limit. */
export const historyRunner =
  (timeoutMs = TIMEOUT_MS): Runner =>
  (file, args) =>
    new Promise((resolve, reject) =>
      NodeChildProcess.execFile(
        "bash",
        [file, ...args],
        { timeout: timeoutMs, maxBuffer: OUTPUT_MAX * 8, windowsHide: true },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      ),
    );

export type HistoryAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

export const NOT_HERE =
  "The history index is not set up on this computer, so there is nothing to search. (Set BATON_HISTORY_SEARCH to the history search script.)";

/** Runs `script words...` or `script show <session>`. */
export const askHistory = (
  env: Readonly<Record<string, string | undefined>>,
  ask: { readonly query?: string; readonly session?: string },
  run: Runner = historyRunner(),
): Promise<HistoryAnswer> => {
  let args: string[];
  if (ask.session !== undefined) {
    if (!SESSION.test(ask.session))
      return Promise.resolve({ ok: false, why: "That is not a session id." });
    args = ["show", ask.session];
  } else {
    const words = (ask.query ?? "")
      .split(/\s+/)
      .filter((w) => w !== "" && !w.startsWith("-"))
      .slice(0, 12);
    if (words.length === 0) return Promise.resolve({ ok: false, why: "Say what to search for." });
    args = words;
  }
  // Checked after the words, so a bad ask is refused here rather than passed to another server.
  const script = env["TESSAYA_HISTORY_SEARCH"] ?? env[HISTORY_ENV];
  if (script === undefined || script.trim() === "")
    return Promise.resolve({ ok: false, why: NOT_HERE });
  return run(script, args).then(
    (out) => ({ ok: true as const, text: out.slice(0, OUTPUT_MAX) }),
    () => ({ ok: false as const, why: "The history search did not answer." }),
  );
};

export interface FoundLearning {
  readonly sessionId: string;
  /** A short quote from the hit, never a transcript. */
  readonly quote: string;
  readonly venture: string | null;
}

const ID = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})\b/i;
const QUOTE_MAX = 300;

// The index prints `2026-10-04T13:55  <role>  <project>  <session> [agent <id>]`, then the hit indented on the next line.
const HEADER =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d\s+(\S+)\s+(\S+)\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\s+agent\s+\S+)?\s*$/i;
// Tool output and thinking are file dumps, not lessons.
const NOISE_ROLES = new Set(["tool_result", "tool_use", "thinking", "system", "meta"]);

/** The folder a session ran in, after the machine's path prefix and before any shape check: what a wall is judged on. */
const folderOf = (project: string): string =>
  project
    // A scratchpad folder (`-tmp-claude-<uid>-`, or one on a mounted volume) names the path it was made for next.
    .replace(/^-mnt-.*?-tmp-(?:lanes-)?claude-\d+-/, "")
    .replace(/^-tmp-claude-\d+-/, "")
    .replace(/^-home-[^-]+-/, "")
    // A mounted volume's path, up to its code folder (`-mnt-<volume>-dev-<project>`).
    .replace(/^-mnt-.*?-(?:dev|src|code|projects|work)-/, "")
    // A code folder in his home (`-home-<user>-dev-<project>`).
    .replace(/^(?:dev|src|code|projects|work)-/, "")
    .replace(/^-+/, "")
    .toLowerCase();

/** `-home-user-shop` is the project the session ran in; the tail after the machine's path prefix is the venture. */
const ventureOf = (project: string): string | null => {
  const name = folderOf(project);
  return /^[a-z0-9][a-z0-9_-]{1,39}$/.test(name) && name !== "prompts" ? name : null;
};

const tidy = (text: string): string =>
  text
    .replace(/^\s*\[[a-z_]+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|\-–]+/, "")
    .trim()
    .slice(0, QUOTE_MAX);

/** The output without the hits `drop` refuses, each header-led block judged whole by its folder and its text. */
export const keepHistory = (
  output: string,
  drop: (folder: string | null, text: string) => boolean,
): string => {
  const out: string[] = [];
  let block: string[] = [];
  let folder: string | null = null;
  const flush = () => {
    if (block.length > 0 && !drop(folder, block.join("\n"))) out.push(...block);
    block = [];
  };
  for (const line of output.split(/\r?\n/)) {
    const head = HEADER.exec(line);
    if (head !== null) {
      flush();
      folder = folderOf(head[2]!);
    }
    block.push(line);
  }
  flush();
  return out.join("\n");
};

/** One finding per hit. Reads the index's header-then-snippet blocks; any other line that names a session is taken whole. */
export const parseLearnings = (output: string, max = 20): ReadonlyArray<FoundLearning> => {
  const seen = new Set<string>();
  const out: FoundLearning[] = [];
  const add = (id: string, quote: string, venture: string | null): void => {
    if (quote.length < 12) return;
    const key = `${id.toLowerCase()}|${quote}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sessionId: id.toLowerCase(), quote, venture });
  };
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i]!;
    const head = HEADER.exec(line);
    if (head !== null) {
      if (NOISE_ROLES.has(head[1]!)) continue;
      const snippet = /^\s+\S/.test(lines[i + 1] ?? "") ? lines[i + 1]! : "";
      add(head[3]!, tidy(snippet), ventureOf(head[2]!));
      continue;
    }
    if (/^\s/.test(line) && i > 0 && HEADER.test(lines[i - 1]!)) continue;
    const id = ID.exec(line)?.[1];
    if (id === undefined) continue;
    add(
      id,
      tidy(line.replace(ID, "")),
      /venture[:=\s]+([A-Za-z0-9_-]{2,40})/i.exec(line)?.[1]?.toLowerCase() ?? null,
    );
  }
  return out;
};
