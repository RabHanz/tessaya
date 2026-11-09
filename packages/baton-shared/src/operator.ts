/**
 * What the operator may do (D127). The operator is Claude or Codex with its own tools, so it can do
 * anything he could at this keyboard. Each tool call comes here before it runs, whichever harness
 * made it, and code decides. A model's reply can never widen this.
 */
import { highRiskSubject } from "./intentParser.ts";
import { dangerousCommand, sensitiveAction } from "./screenCompanion.ts";
import { isChromeTool, judgeChrome } from "./webPolicy.ts";

export interface ToolCall {
  /** The harness's own name: "Bash", "Write", "commandExecution". */
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type ToolVerdict =
  | { readonly verdict: "allow" }
  /** `risky`: needs his explicit yes, no timeout counts as one, and no setting covers it. */
  | { readonly verdict: "ask"; readonly why: string; readonly risky?: true }
  /** Never done, asked or not: money movement, and a social site while social is off. */
  | { readonly verdict: "deny"; readonly why: string };

/** Only looks. */
const READING = new Set(["Read", "Glob", "Grep", "LS"]);
/** Does something ordinary. "Act without asking" can cover these. */
const ROUTINE = new Set([
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "commandExecution",
  "fileChange",
  "WebSearch",
]);

/** The parts that say what happens. A file's contents can say "delete everything" and do nothing. */
const actionText = ({ input }: ToolCall): string =>
  [
    "command",
    "file_path",
    "path",
    "notebook_path",
    "url",
    "cwd",
    "query",
    "text",
    "value",
    "action",
    "ref",
    "why",
    "keys",
    "target",
    "session",
    "label",
    "goal",
    "instruction",
    "task",
  ]
    .flatMap((key) => {
      const value = input[key];
      return typeof value === "string" ? [value] : Array.isArray(value) ? value.map(String) : [];
    })
    .join(" ");

/** One short line for a box, the spoken question and the log. Never a file's contents. */
export const describeToolCall = (call: ToolCall): string => {
  const what = actionText(call);
  return (what.length > 0 ? what : call.tool).slice(0, 200);
};

export interface JudgeContext {
  readonly actWithoutAsking: boolean;
  /** This turn has read something, so what it does next may be that content's idea. */
  readonly tainted: boolean;
  /** An earlier weave to this session in this job was approved: later ones are routine (D149). */
  readonly weaveStanding?: boolean;
  /** The window that has the keyboard is a command line, or cannot be told apart from one. */
  readonly focusedShell?: boolean;
  /** The click lands on a text box (from the accessibility tree): it only moves the cursor there. */
  readonly pointerField?: boolean;
  /** The text is his own words or Baton's own earlier reply, found in the conversation. */
  readonly textIsHis?: boolean;
  /** His own Chrome (Claude in Chrome): what the gate knows about the page and the accounts. */
  readonly chrome?: {
    readonly socialOn: boolean;
    readonly pageHost: string | null;
    readonly recentSocial: number;
  };
}

/** Baton's own tools, served to the one assistant (D143). Claude names them `mcp__baton__<name>`. */
export const BATON_TOOL_PREFIX = "mcp__baton__";
// Rename R1: the server is still registered as baton, and the next build's tessaya name is read as the same tools.
const OWN_TOOL_PREFIXES = [BATON_TOOL_PREFIX, "mcp__tessaya__"];
const ownPrefix = (tool: string) => OWN_TOOL_PREFIXES.find((prefix) => tool.startsWith(prefix));
export const isOwnTool = (tool: string): boolean => ownPrefix(tool) !== undefined;
export const batonToolName = (tool: string): string => tool.slice(ownPrefix(tool)?.length ?? 0);

/** Look at state, or reversible and local: nothing leaves, nothing is changed. */
const BATON_QUIET = new Set([
  "sessions_list",
  "sessions_find",
  "session_resume",
  "session_show",
  "fleet_status",
  "team_board",
  "memory_search",
  "conversation_search",
  "memory_used",
  "memory_history",
  "vault_list",
  "history_search",
  "browser_route",
  "memory_pin",
  "remember_target",
  "wait",
  "wait_for",
  // Remote hands (REMOTE_HANDS.md): the Director's baton:hands grant on that session is the yes for these; they exist only in the remote table.
  "window_capture",
  "app_version",
  "log_tail",
  "process_list",
  "process_stop",
  "app_update",
  "open_page",
  "dictation_start",
  "dictation_stop",
  // His own standing job (KIRO-1): job_create saves only on its own card's yes; a device's call only proposes one.
  "job_create",
  // His own choice of model for chat turns: local, and "back to normal" undoes it.
  "assistant_model",
  "screen_capture",
  "ui_tree",
  // Brings his own open window forward: local, and he can switch back.
  "window_focus",
  // Drawing on the screen, a lesson, and a plan's card: each asks for its own consent where it runs (capture, Go ahead).
  "point_at",
  "teach_start",
  "plan_show",
  "jobs_list",
  "watch_report",
  "what_happened",
  "morning_brief",
  "needs_me",
  "commit_list",
  "notices_resume",
  "trust_show",
  "cloud_status",
  "cloud_list",
  "cloud_usage",
  "activity_today",
  "permission_off",
  "weave_list",
  "note_search",
  "approvals_list",
  "job_revoke",
  "job_stop",
]);
/** Tools only a remote hands session has; the assistant's own table never holds them. */
export const REMOTE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "window_capture",
  "app_version",
  "log_tail",
  "process_list",
  "process_stop",
  "app_update",
  "open_page",
]);
const BATON_POINTER = new Set(["click", "click_element", "scroll"]);
export const BATON_TOOLS: ReadonlySet<string> = new Set([
  ...BATON_QUIET,
  ...BATON_POINTER,
  "act_batch",
  "drag",
  "type_text",
  "press_keys",
  "session_send",
  "session_new",
  "job_start",
  "job_split",
  "job_refine",
  "job_agree",
  "rule_create",
  "job_grant",
  "job_schedule",
  "memory_remember",
  "memory_forget",
  "vault_use",
  "vault_save_pending",
  "browser_accessibility_on",
  "commit_add",
  "commit_done",
  "notices_stop",
  "weave_send",
  "job_retry",
  "job_handoff",
  "thread_move_into_tessaya",
  "job_update",
  "job_delete",
  "skill_draft",
  "text_transform",
  "text_undo",
  "text_command",
  "note_add",
  "cloud_dispatch",
  "cloud_cancel",
  "cloud_approve",
]);
/** What leaves the machine's own state and, run, taints what follows. */
export const READS_OUTSIDE = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Bash",
  "WebFetch",
  "WebSearch",
  "commandExecution",
  "screen_capture",
  "ui_tree",
  "window_capture",
  "log_tail",
  "session_show",
  "history_search",
  // Another session's reply is data from outside, whatever it says.
  "weave_list",
]);

const SENDS = /\b(enter|return)\b/i;

const NAV_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "tab",
  "home",
  "end",
  "pageup",
  "pagedown",
  "backspace",
  "delete",
  "escape",
  "esc",
]);
const EDIT_LETTERS = new Set(["a", "c", "x", "v", "z", "y", "f"]);

/**
 * Keys that carry nothing out and open nothing: navigation, Backspace, Delete, Escape, and Ctrl+A, C, X,
 * V, Z, Y, F, each with Shift or Ctrl only. Anything else asks after a read (a Win+R or Alt+F4 is how
 * an injection would start). Unknown is ask.
 */
export const keyIsNavigation = (keys: ReadonlyArray<string>): boolean => {
  const parts = keys.map((k) => k.toLowerCase().trim());
  const isMod = (k: string) => k === "ctrl" || k === "control" || k === "shift";
  const mods = new Set<string>(parts.filter(isMod));
  const rest = parts.filter((k) => !isMod(k));
  if (rest.length !== 1) return false;
  const main = rest[0]!;
  const ctrl = mods.has("ctrl") || mods.has("control");
  const shift = mods.has("shift");
  if (NAV_KEYS.has(main)) {
    if (main === "escape" || main === "esc") return !(ctrl && shift);
    if ((main === "delete" || main === "backspace") && ctrl && shift) return false;
    return true;
  }
  return EDIT_LETTERS.has(main) && ctrl;
};

const judgeBatonTool = (name: string, call: ToolCall, context: JudgeContext): ToolVerdict => {
  // Screen capture asks for its own consent where it runs; looking is not the risk.
  if (BATON_QUIET.has(name)) return { verdict: "allow" };
  const text = actionText(call);
  const subject = highRiskSubject(text);
  if (subject !== null) return { verdict: "ask", why: `This is ${subject}.`, risky: true };
  if (dangerousCommand(text))
    return { verdict: "ask", why: "This is a destructive command.", risky: true };
  if (BATON_POINTER.has(name)) {
    return sensitiveAction(text) && context.pointerField !== true
      ? { verdict: "ask", why: "It deletes, sends, pays or publishes." }
      : { verdict: "allow" };
  }
  const outgoing = context.tainted && context.textIsHis !== true;
  switch (name) {
    case "drag":
      return { verdict: "ask", why: "It wants to drag something." };
    case "type_text":
      // Plain text into a box he named is routine and needs no Run it. A command line, or words
      // that came from something it read, is not.
      if (context.focusedShell === true) {
        return {
          verdict: "ask",
          why: "It would type into a command line, where nobody reads it first.",
        };
      }
      return outgoing
        ? { verdict: "ask", why: "It follows something it read." }
        : { verdict: "allow" };
    case "press_keys":
      // A command line runs what reaches it: he is asked here, not refused later as the keys are sent.
      if (context.focusedShell === true)
        return { verdict: "ask", why: "It would press keys in a command line." };
      if (SENDS.test(Array.isArray(call.input["keys"]) ? call.input["keys"].join(" ") : "")) {
        return { verdict: "ask", why: "That may send what is typed." };
      }
      if (sensitiveAction(text))
        return { verdict: "ask", why: "It deletes, sends, pays or publishes." };
      // After a read, only navigation and editing keys are free (`keyIsNavigation`); the rest ask.
      return context.tainted &&
        !keyIsNavigation(Array.isArray(call.input["keys"]) ? call.input["keys"].map(String) : [])
        ? { verdict: "ask", why: "It follows something it read." }
        : { verdict: "allow" };
    case "job_start":
    case "job_split":
    case "job_refine":
    case "job_retry":
    case "job_agree":
    case "rule_create":
      // A job's words are his own or they came from something it read; only the second asks.
      // Starting work is his agreement, not the model's: after a read it always asks.
      return outgoing || ((name === "job_agree" || name === "rule_create") && context.tainted)
        ? { verdict: "ask", why: "It follows something it read." }
        : { verdict: "allow" };
    case "text_transform":
    case "text_command":
    case "text_undo":
      // It rewrites what he selected, in the app he is in; a command line or a read-then-act turn asks.
      if (name === "text_undo") return { verdict: "allow" };
      if (context.focusedShell === true) {
        return { verdict: "ask", why: "It would rewrite text in a command line." };
      }
      return context.tainted
        ? { verdict: "ask", why: "It follows something it read." }
        : { verdict: "allow" };
    case "weave_send": {
      // A secret in the text is caught by the tool itself, which offers the vault and sends nothing.
      if (outgoing) return { verdict: "ask", why: "It follows something it read." };
      return context.weaveStanding === true
        ? { verdict: "allow" }
        : {
            verdict: "ask",
            why: "It would message another session; the first one in a job needs your yes.",
          };
    }
    case "cloud_dispatch":
      // Routine: it only makes a request that waits for him. A brief built from something it read must say so.
      return outgoing && call.input["from_web_or_file"] !== true
        ? { verdict: "ask", why: "It follows something it read, and the brief does not say so." }
        : { verdict: "allow" };
    case "cloud_cancel":
    case "cloud_approve":
      // Withdrawing is harmless; approving shows its own dialog that only he can press.
      return { verdict: "allow" };
    case "notices_stop":
    case "commit_add":
    case "commit_done":
    case "note_add":
      // A note outlasts the conversation: words that came from something it read are not kept unasked.
      return outgoing
        ? { verdict: "ask", why: "It would keep something it read as a note." }
        : { verdict: "allow" };
    case "memory_remember":
      // A note outlasts the conversation, so words that came from something it read are not kept unasked.
      return outgoing
        ? { verdict: "ask", why: "It would keep something it read as a note or a commitment." }
        : { verdict: "allow" };
    case "vault_use":
      // The vault asks for itself, by the secret's policy and with the name, purpose and target (never the value);
      // a turn that read something is always asked there.
      return { verdict: "allow" };
    case "vault_save_pending":
      return { verdict: "ask", why: "It would keep the secret you just told it in your vault." };
    case "browser_accessibility_on":
      // It closes and reopens his Chrome: always asked, whatever he allowed before.
      return { verdict: "ask", why: "It would restart Chrome with accessibility on.", risky: true };
    case "memory_forget":
      return { verdict: "ask", why: "It would delete one of your notes." };
    case "skill_draft":
      // It writes a file in Tessaya's own drafts folder from a job; the text came from the job, not from a read.
      return outgoing
        ? { verdict: "ask", why: "It follows something it read." }
        : { verdict: "allow" };
    case "job_handoff":
      // The same work on another provider or account spends another subscription: it asks every time.
      return { verdict: "ask", why: "It would move a job to another worker or account." };
    case "thread_move_into_tessaya":
      // It ends a terminal session and changes which provider answers the thread: his yes, every time.
      return {
        verdict: "ask",
        why: "It would end a terminal session and continue it in Tessaya.",
        risky: true,
      };
    case "job_update":
    case "job_delete":
      // Changing or removing one of his own jobs is his to say, every time: read text could otherwise rewrite one.
      return { verdict: "ask", why: "It would change or remove one of your standing jobs." };
    case "job_schedule":
      // A repeating run is unattended spending, so it asks every time.
      return { verdict: "ask", why: "It would make a job run again on a schedule." };
    case "job_grant":
      // A standing permission is explicit and his alone: it asks every time.
      return { verdict: "ask", why: "It would give a job a standing permission.", risky: true };
    case "session_send":
      // The intent layer applies the same gates as typing it; a secret carried out is the risk here.
      return outgoing
        ? { verdict: "ask", why: "It follows something it read." }
        : { verdict: "allow" };
    default:
      return { verdict: "ask", why: `It wants to use ${call.tool}.` };
  }
};

/** The steps `act_batch` may carry: named controls and keys inside one window, never a raw point or a drag. */
export const BATCH_STEP_TOOLS: ReadonlySet<string> = new Set([
  "click_element",
  "type_text",
  "press_keys",
  "wait_for",
]);
export const MAX_BATCH_STEPS = 6;

export interface BatchStep {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** The steps of an `act_batch` call, or null when the call is not a well-formed batch. */
export const batchSteps = (
  input: Readonly<Record<string, unknown>>,
): ReadonlyArray<BatchStep> | null => {
  const raw = input["steps"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH_STEPS) return null;
  const steps: BatchStep[] = [];
  for (const item of raw) {
    const step = item as { tool?: unknown; args?: unknown } | null;
    if (typeof step?.tool !== "string" || !BATCH_STEP_TOOLS.has(step.tool)) return null;
    const args = step.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
    steps.push({ tool: step.tool, input: args as Record<string, unknown> });
  }
  return steps;
};

/** A batch is judged step by step as if each were made alone; the strictest verdict stands. */
const judgeBatch = (call: ToolCall, context: JudgeContext): ToolVerdict => {
  const steps = batchSteps(call.input);
  if (steps === null) {
    return {
      verdict: "deny",
      why: "A batch is one to six steps of click_element, type_text, press_keys or wait_for.",
    };
  }
  let worst: ToolVerdict = { verdict: "allow" };
  const rank = (v: ToolVerdict) =>
    v.verdict === "deny" ? 3 : v.verdict === "ask" ? (v.risky === true ? 2 : 1) : 0;
  for (const step of steps) {
    const one = judgeToolCall(
      { tool: `${BATON_TOOL_PREFIX}${step.tool}`, input: step.input },
      context,
    );
    if (rank(one) > rank(worst)) worst = one;
  }
  return worst;
};

/**
 * A command that looks like it drives a window itself. It asks rather than refuses: the same words appear in ordinary
 * commands (a grep, a lock screen), and the hands tools are the way the prompt teaches.
 */
const DRIVES_APPS =
  /\b(uiautomation\w*|sendkeys|user32(\.dll)?|sendinput|keybd_event|mouse_event|setcursorpos|xdotool)\b/i;

export const judgeToolCall = (call: ToolCall, context: JudgeContext): ToolVerdict => {
  const baton = batonToolName(call.tool);
  if (
    (call.tool === "Bash" || call.tool === "PowerShell" || call.tool === "commandExecution") &&
    DRIVES_APPS.test(String(call.input["command"] ?? ""))
  )
    return {
      verdict: "ask",
      why: "It would drive an app through a command; the hands tools (ui_tree, click_element, type_text, press_keys) do that without one.",
    };
  if (baton === "act_batch" && isOwnTool(call.tool)) return judgeBatch(call, context);
  if (isChromeTool(call.tool)) {
    return judgeChrome(call.tool, call.input, {
      tainted: context.tainted,
      textIsHis: context.textIsHis === true,
      socialOn: context.chrome?.socialOn ?? false,
      pageHost: context.chrome?.pageHost ?? null,
      recentSocial: context.chrome?.recentSocial ?? 0,
    });
  }
  if (BATON_TOOLS.has(baton)) return judgeBatonTool(baton, call, context);
  if (READING.has(call.tool)) return { verdict: "allow" };
  const text = actionText(call);
  const subject = highRiskSubject(text);
  if (subject !== null) return { verdict: "ask", why: `This is ${subject}.`, risky: true };
  if (dangerousCommand(text))
    return { verdict: "ask", why: "This is a destructive command.", risky: true };
  // Codex sends no file name Baton can judge, so an edit is never waved through.
  if (call.tool === "fileChange") return { verdict: "ask", why: "It wants to change files." };
  if (call.tool === "commandExecution" && !String(call.input["command"] ?? "").trim())
    return { verdict: "ask", why: "Tessaya cannot see what this command is." };
  if (!ROUTINE.has(call.tool)) return { verdict: "ask", why: `It wants to use ${call.tool}.` };
  if (sensitiveAction(text))
    return { verdict: "ask", why: "It deletes, sends, pays or publishes." };
  if (context.tainted) return { verdict: "ask", why: "It follows something it read." };
  // A search query is outgoing text, so a tainted turn could be carrying a secret out in it.
  if (call.tool === "WebSearch" && !context.tainted) return { verdict: "allow" };
  return context.actWithoutAsking
    ? { verdict: "allow" }
    : { verdict: "ask", why: "Act without asking is off." };
};

/**
 * A call is announced before its own request reaches the gate. It follows something this turn read
 * or ran when any earlier call was not a web search; a search reads nothing private, so searching
 * again (a follow-up fact) stays untainted.
 */
export const announceTool = (ran: number, tool: string) => ({
  tainted: ran > 0,
  ran: tool === "WebSearch" ? ran : ran + 1,
});

/** What the gate says out loud and shows, naming who asks and for which project. A risky call's question that runs out is a no. */
export const gatePrompt = (
  judged: Extract<ToolVerdict, { verdict: "ask" }>,
  action: string,
  who: { readonly agent?: string; readonly project?: string } = {},
) => {
  const agent = who.agent ?? "Tessaya";
  const asks = `${agent} wants to do this${who.project === undefined ? "" : ` in ${JSON.stringify(who.project.slice(0, 60))}`}`;
  return {
    title: judged.risky ? "This one is risky" : `${agent} wants to do this`,
    detail: `${asks}: ${action}\n\n${judged.why}`,
    spoken:
      judged.risky === true
        ? `${asks}. ${judged.why} Do you want it done? Say yes or no.`
        : `${asks}. ${judged.why} Go ahead? Yes or no.`,
    noOnExpiry: judged.risky === true,
  };
};

/** What a spoken answer decides: the button index, or null to go on waiting for the box. */
export const spokenOutcome = (
  said: "yes" | "no" | "expired",
  option: { readonly yes: number; readonly cancel: number; readonly noOnExpiry: boolean },
): number | null =>
  said === "expired" && !option.noOnExpiry ? null : said === "yes" ? option.yes : option.cancel;
