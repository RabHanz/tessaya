// @effect-diagnostics globalDate:off
/**
 * What Tessaya did, read from `voice-turns.ndjson` (D120) and said in plain words for Home and History.
 * Dictations and spoken turns come from History's own store; this file only adds the commands and the
 * assistant's actions, and never shows a tool's name.
 */
import { tessayaToolName, isOwnTool } from "@t3tools/tessaya-shared/operator";

import type { HistoryTurn } from "../voice/history.ts";
import { rowText } from "../voice/historyRetry.ts";
import type { HomeActivity } from "./tessayaHome.ts";

export type LogKind = "command" | "assistant";

export interface LogEntry {
  readonly id: string;
  readonly at: string;
  readonly kind: LogKind;
  readonly text: string;
  readonly detail: string | null;
}

interface Line {
  readonly at?: unknown;
  readonly kind?: unknown;
  readonly tool?: unknown;
  readonly action?: unknown;
  readonly outcome?: unknown;
  readonly transcript?: unknown;
}

const line = (raw: string): Line | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Line) : null;
  } catch {
    return null;
  }
};

const clip = (text: string, max = 80): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

type Say = (what: string | null) => string;
const cmd = (say: Say | string) => ({ kind: "command" as const, say });
const asst = (say: Say | string) => ({ kind: "assistant" as const, say });

/** Tessaya's own tools, by name without the server prefix. Commands are the ones he asks for directly. */
const OWN: Readonly<Record<string, { readonly kind: LogKind; readonly say: Say | string }>> = {
  window_focus: cmd((w) => (w === null ? "Brought a window forward" : `Focused ${w}`)),
  dictation_start: cmd("Started dictation"),
  dictation_stop: cmd("Stopped dictation"),
  notices_stop: cmd("Paused notices"),
  notices_resume: cmd("Turned notices back on"),
  permission_off: cmd("Turned a permission off"),
  text_undo: cmd("Undid the last text change"),
  text_transform: cmd("Rewrote the selected text"),
  text_command: cmd("Edited the text for you"),
  needs_me: asst("Asked you to look at a session"),
  type_text: asst("Typed for you"),
  press_keys: asst((w) => (w === null ? "Pressed keys for you" : `Pressed ${w}`)),
  click: asst("Clicked for you"),
  click_element: asst((w) => (w === null ? "Clicked for you" : `Clicked ${w}`)),
  scroll: asst("Scrolled the page"),
  drag: asst("Dragged for you"),
  act_batch: asst("Did a few steps on screen"),
  screen_capture: asst("Looked at your screen"),
  ui_tree: asst("Read what is on your screen"),
  point_at: asst("Pointed at something on screen"),
  teach_start: asst("Started a lesson"),
  plan_show: asst("Showed you a plan"),
  sessions_list: asst("Looked through your sessions"),
  sessions_find: asst("Looked through your sessions"),
  session_show: asst("Looked at a session"),
  session_resume: asst("Opened a session"),
  session_new: asst("Started a new session"),
  session_send: asst("Sent a message to a session"),
  weave_send: asst("Passed work between sessions"),
  weave_list: asst("Checked linked sessions"),
  jobs_list: asst("Checked your jobs"),
  job_create: asst("Set up a job"),
  job_start: asst("Started a job"),
  job_stop: asst("Stopped a job"),
  job_delete: asst("Deleted a job"),
  memory_search: asst("Searched your memory"),
  memory_history: asst("Searched your memory"),
  memory_used: asst("Checked what it remembered"),
  conversation_search: asst("Searched your conversations"),
  history_search: asst("Searched your history"),
  note_search: asst("Searched your notes"),
  memory_remember: asst("Remembered something you said"),
  note_add: asst("Saved a note"),
  memory_forget: asst("Forgot something you asked it to"),
  memory_pin: asst("Pinned a memory"),
  vault_use: asst("Filled in a saved secret"),
  vault_save_pending: asst("Saved a secret to the vault"),
  vault_list: asst("Checked the vault"),
  fleet_status: asst("Checked how things are going"),
  team_board: asst("Checked how things are going"),
  activity_today: asst("Checked what happened today"),
  what_happened: asst("Checked what happened"),
  morning_brief: asst("Put together your morning brief"),
  approvals_list: asst("Checked what is waiting for you"),
  trust_show: asst("Showed what it may do"),
  browser_route: asst("Opened a page"),
  open_page: asst("Opened a page"),
  skill_draft: asst("Drafted a skill"),
  rule_create: asst("Made a rule"),
  commit_add: asst("Noted a commitment"),
  commit_done: asst("Ticked off a commitment"),
  commit_list: asst("Checked your commitments"),
  remember_target: asst("Remembered where to type"),
  assistant_model: asst("Changed the model it uses"),
  watch_report: asst("Reported on something it watched"),
};

/** Tools that only wait or look up a name: a row for them says nothing. */
const QUIET = new Set(["wait", "wait_for", "browser_accessibility_on"]);

const OTHER: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Bash$/, "Ran a command"],
  [/^(Read|NotebookRead)$/, "Read a file"],
  [/^(Edit|MultiEdit|Write|NotebookEdit)$/, "Changed a file"],
  [/^(Glob|Grep|LS)$/, "Searched your files"],
  [/^(WebFetch|WebSearch)$/, "Looked something up online"],
  [/^mcp__claude-in-chrome__(navigate|tabs_create_mcp)$/, "Opened a page in Chrome"],
  [/^mcp__claude-in-chrome__/, "Worked in Chrome"],
];

/** The words for one action line: a sentence, never the tool's name. Null for a line not worth a row. */
export const actionSentence = (entry: {
  readonly tool?: unknown;
  readonly action?: unknown;
  readonly outcome?: unknown;
}): { readonly kind: LogKind; readonly text: string; readonly detail: string | null } | null => {
  if (typeof entry.tool !== "string") return null;
  const tool = entry.tool;
  const name = isOwnTool(tool) ? tessayaToolName(tool) : tool;
  if (QUIET.has(name)) return null;
  // describeToolCall falls back to the tool's name when its input has nothing to say.
  const action = typeof entry.action === "string" ? entry.action.trim() : "";
  const what = action === "" || action === tool || /^mcp__/.test(action) ? null : clip(action, 40);
  const own = isOwnTool(tool)
    ? (OWN[name] ??
      (name.startsWith("job_") ? asst("Updated a job") : undefined) ??
      (name.startsWith("cloud_") ? asst("Worked with a cloud machine") : undefined))
    : undefined;
  const text =
    own === undefined
      ? (OTHER.find(([pattern]) => pattern.test(tool))?.[1] ?? "Did something for you")
      : typeof own.say === "string"
        ? own.say
        : own.say(what);
  const outcome = typeof entry.outcome === "string" ? entry.outcome : "";
  const detail =
    name === "needs_me"
      ? "A session needs an answer"
      : outcome === "refused"
        ? "Not allowed, so it did not"
        : outcome === "he said no"
          ? "You said no, so it did not"
          : outcome === "he said yes"
            ? "You said yes"
            : null;
  return { kind: own?.kind ?? "assistant", text, detail };
};

const toEntry = (l: Line, index: number): LogEntry | null => {
  if (typeof l.at !== "string") return null;
  const id = `log:${l.at}:${index}`;
  if (l.kind === "stop")
    return { id, at: l.at, kind: "command", text: "Stopped: you said stop", detail: null };
  if (l.kind !== "action") return null;
  const said = actionSentence(l);
  return said === null ? null : { id, at: l.at, ...said };
};

/** Newest first, at most `limit`. A line that does not parse is skipped. */
export const parseLogEntries = (raw: string, limit = 200): ReadonlyArray<LogEntry> =>
  raw
    .split("\n")
    .flatMap((text, index) => {
      const parsed = text.trim().length === 0 ? null : line(text);
      const item = parsed === null ? null : toEntry(parsed, index);
      return item === null ? [] : [item];
    })
    .toReversed()
    .slice(0, limit);

/** Spoken turns and dictations since local midnight of `now`. */
export const todayStats = (
  raw: string,
  now: Date,
): { readonly turns: number; readonly dictations: number } => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  let turns = 0;
  let dictations = 0;
  for (const text of raw.split("\n")) {
    const l = text.trim().length === 0 ? null : line(text);
    if (l === null || typeof l.at !== "string" || Date.parse(l.at) < start.getTime()) continue;
    if (l.kind === "turn" && typeof l.transcript === "string" && l.transcript.trim() !== "")
      turns += 1;
    if (l.kind === "dictated") dictations += 1;
  }
  return { turns, dictations };
};

/** History's rows and the log's, newest first; the log's are matched on their words here, as History's are in SQLite. */
export const mergeFeed = <T extends { readonly at: string }, L extends LogEntry>(
  turns: ReadonlyArray<T>,
  log: ReadonlyArray<L>,
  query = "",
): ReadonlyArray<T | L> => {
  const q = query.trim().toLowerCase();
  const shown =
    q === "" ? log : log.filter((e) => `${e.text} ${e.detail ?? ""}`.toLowerCase().includes(q));
  return [...turns, ...shown].toSorted((a, b) => b.at.localeCompare(a.at));
};

/** Home's Today card: the last five things, each as its words or a sentence. */
export const homeActivity = (
  turns: ReadonlyArray<HistoryTurn>,
  log: ReadonlyArray<LogEntry>,
): ReadonlyArray<HomeActivity> =>
  mergeFeed(
    turns.map((t): HomeActivity => ({
      id: t.id,
      at: t.at,
      kind: t.kind,
      text: t.kind === "spoken" ? t.raw : rowText(t),
      detail: t.kind === "spoken" ? t.cleaned : null,
      app: t.app,
      hidden: t.hidden,
    })),
    log,
  ).slice(0, 5);
