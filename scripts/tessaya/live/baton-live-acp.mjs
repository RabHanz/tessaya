#!/usr/bin/env node
/* oxlint-disable t3code/no-low-value-comments -- Baton file (D82) */
/**
 * Baton live-session agent (D83): an ACP agent that T3 runs through its own "ACP Registry → Local
 * command" provider, so a message typed into T3's ordinary composer reaches a Claude Code session
 * that is already running in a terminal.
 *
 * It does not run a model. `session/resume <claude session id>` binds to the live session found
 * in Claude Code's own `~/.claude/sessions/<pid>.json`; `session/prompt` types the text into that
 * session's Herdr pane (moving an idle plain-terminal session into Herdr first, the same
 * `baton --resume` adoption as D74) and ends the turn once Herdr has delivered the text (D85).
 * The reply reaches the thread through Baton's transcript mirror, so there is one writer of the
 * conversation and nothing is shown twice.
 *
 * Node built-ins only: T3 spawns it with whichever Node the box has.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { CARD_REF, herdrBin, parsePanePrompt, parseWaitingScreen } from "./pane-prompt.mjs";

const HERDR = herdrBin();
const localBin = (name) => NodePath.join(NodeOS.homedir(), ".local", "bin", name);
// A box whose launchers predate the rename has only `baton`.
const BATON =
  process.env.TESSAYA_BIN ??
  process.env.BATON_BIN ??
  (NodeFS.existsSync(localBin("tessaya")) ? localBin("tessaya") : localBin("baton"));
const ATTACHMENT_ENTER_MS = Number(process.env.BATON_LIVE_ATTACHMENT_ENTER_MS ?? 1_500);
const PROMPT_CLEAR_TRIES = Number(process.env.BATON_LIVE_PROMPT_CLEAR_TRIES ?? 30);
const UNBOUND = "baton-unbound";

// ---------------------------------------------------------------------------------------------
// Pure parts (tested in baton-live-acp.test.ts)

/** The user's words from T3's prompt blocks: T3's own instruction wrappers are not for Claude. */
export function promptText(blocks) {
  const texts = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .filter((text) => !text.trimStart().startsWith("<runtime_info>"));
  const first = texts.join("\n\n");
  const wrapped = /<user_request>\n?([\s\S]*?)\n?<\/user_request>/.exec(first);
  const text = wrapped === null ? first : wrapped[1];
  // T3 prefixes a context handoff (and restart notes) as "<context>\n\nUser message:\n<text>".
  // The live session already holds its own history, so only the user's words go through.
  const marker = "\n\nUser message:\n";
  const at = text.lastIndexOf(marker);
  return (at < 0 ? text : text.slice(at + marker.length)).trim();
}

/** The efforts `/effort` takes; the same list as LIVE_EFFORT_CHOICES in baton-shared's liveModel.ts (the test pins it). */
export const LIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_AS_IS = "session";

/**
 * What T3 shows as this session's model: the agent in the terminal, which keeps its own model (the slug stays `live`,
 * the thread's model in LiveSessionMirror). Picking another Claude model in T3 types /model into the session.
 */
export const LIVE_MODELS = {
  availableModels: [
    {
      modelId: "live",
      name: "Claude Code",
      description: "The model is the session's own; pick one to change it there.",
    },
  ],
  currentModelId: "live",
};

/** The effort control T3's own composer shows for a live thread; the session itself keeps the real value. */
export const effortConfigOption = (current = EFFORT_AS_IS) => ({
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: current,
  options: [
    { value: EFFORT_AS_IS, name: "Current" },
    ...LIVE_EFFORTS.map((effort) => ({ value: effort, name: effort })),
  ],
});

/** The explicit request to move a plain-terminal session into Herdr. */
export const isAdoptRequest = (text) => /(?:^|\n)\s*bring (it )?into herdr\s*\.?\s*$/i.test(text);

/** The answer to the "waiting on something I cannot read" question when he will deal with it in the terminal. */
export const ANSWER_IN_TERMINAL = "I'll answer it in the terminal";
export const isAnswerInTerminal = (text) => text.trim().endsWith(ANSWER_IN_TERMINAL);

/** What a send to a plain-terminal session says instead of being delivered. */
export const notSentNote = (live) =>
  [
    "Not sent. This session runs in a plain terminal" +
      (live.remoteControl ? " with Remote Control on" : "") +
      ", and Tessaya can only type into sessions inside Herdr.",
    "Moving it into Herdr restarts it with the same conversation" +
      (live.remoteControl
        ? " (Remote Control on claude.ai disconnects until you turn it on again)"
        : "") +
      (live.status === "busy" ? ", and it is working right now, so wait until it is idle." : "."),
    "To move it, send exactly: bring into Herdr",
  ].join("\n\n");

/** T3's own restart continuation: not the user's words, so never typed into the session. */
export const isAppContinuation = (text) => text.trim() === "Continue where you left off.";

/**
 * A live thread's id names the Claude session it mirrors (`baton-live4:<session id>`), and T3 starts this bridge with
 * that id in `T3CODE_THREAD_ID`. T3 opens a restarted bridge with session/new, not session/resume, so session/new binds
 * to that session again instead of answering unbound.
 */
export const sessionOfLiveThread = (threadId) => {
  const m = /^baton-live4:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    threadId ?? "",
  );
  return m === null ? null : m[1];
};

/**
 * The bridge is plumbing, not an agent, but T3 starts it through AgentScope, which raises oom_score_adj to 800 so
 * earlyoom kills it first and every live thread detaches. Lowering it back is allowed down to what was inherited; a
 * refusal is only warned about (on stderr: stdout is the ACP stream).
 */
export const BRIDGE_OOM_SCORE_ADJ = 100;
export function lowerOomScore({
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Node built-ins only, no Effect runtime here
  platform = NodeOS.platform(),
  write = (value) => NodeFS.writeFileSync("/proc/self/oom_score_adj", value),
  warn = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (platform !== "linux") return false;
  try {
    write(String(BRIDGE_OOM_SCORE_ADJ));
    return true;
  } catch (error) {
    warn(
      `baton-live-acp: could not lower oom_score_adj to ${BRIDGE_OOM_SCORE_ADJ}: ${error.message}`,
    );
    return false;
  }
}

/** Every Claude config directory's sessions folder (same list as ClaudeLiveSessions.ts). */
export function sessionsDirs() {
  if (process.env.BATON_CLAUDE_SESSIONS_DIR) return [process.env.BATON_CLAUDE_SESSIONS_DIR];
  const home = NodeOS.homedir();
  const dirs = [NodePath.join(home, ".claude")];
  const add = (parent, filter) => {
    try {
      for (const name of NodeFS.readdirSync(parent))
        if (filter(name)) dirs.push(NodePath.join(parent, name));
    } catch {}
  };
  add(NodePath.join(home, ".local", "share", "claude-swap", "sessions"), () => true);
  add(home, (name) => name.startsWith(".claude-"));
  for (const extra of (process.env.BATON_CLAUDE_CONFIG_DIRS ?? "").split(":"))
    if (extra) dirs.push(extra);
  return [...new Set(dirs)].map((dir) => NodePath.join(dir, "sessions"));
}

/** T3 lists each attachment as `[Attached <type> "<name>" is saved at: <path>...]`. */
export function splitAttachments(text) {
  const paths = [];
  const kept = text.replace(
    /\[Attached [^\]"]* "[^"]*" is saved at: ([^\]\s]+)(?: \(text extracted to: [^)]*\))?\]/g,
    (_match, path) => {
      paths.push(path);
      return "";
    },
  );
  return { text: kept.replace(/\n{3,}/g, "\n\n").trim(), paths };
}

/** A file name that cannot leave the inbox or hide (same rule as LiveActions.safeInboxName). */
export function safeInboxName(fileName, stamp) {
  const base = NodePath.basename(fileName)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  return `${stamp}-${base.length === 0 ? "file" : base.slice(0, 120)}`;
}

/**
 * The pane Herdr shows a Claude session in now, from `herdr agent list`: found by the session's own id, so it still
 * matches after a Herdr restart renumbers the panes (the pane id in the process environment never changes).
 */
export function paneFromAgentList(json, sessionId) {
  try {
    const agents = JSON.parse(json)?.result?.agents;
    const agent = Array.isArray(agents)
      ? agents.find((a) => a?.agent_session?.value === sessionId)
      : undefined;
    return typeof agent?.pane_id === "string" ? agent.pane_id : null;
  } catch {
    return null;
  }
}

function currentPaneRef(env, sessionId) {
  const session = env.get("HERDR_SESSION");
  const named = !session || session === "default" ? [] : ["--session", session];
  let listed = "";
  try {
    listed = NodeChildProcess.execFileSync(HERDR, [...named, "agent", "list"], {
      timeout: 5_000,
      encoding: "utf8",
    });
  } catch {}
  const pane = paneFromAgentList(listed, sessionId);
  if (pane === null) return herdrPaneRef(env);
  return named.length === 0 ? pane : `${session}~${pane}`;
}

export function herdrPaneRef(env) {
  const pane = env.get("HERDR_PANE_ID");
  if (!pane) return null;
  const session = env.get("HERDR_SESSION");
  return !session || session === "default" ? pane : `${session}~${pane}`;
}

/** The keys that answer `prompt` with `answer` (an option's label or number, or free text). */
export function answerKeys(prompt, answer) {
  const wanted = String(answer ?? "").trim();
  // A choice is the answer's first line: T3 appends a pasted picture's note below it.
  const chosen = wanted.split("\n")[0].trim();
  const byLabel = prompt.options.find((o) => o.label.toLowerCase() === chosen.toLowerCase());
  const byNumber = /^\d+$/.test(chosen)
    ? prompt.options.find((o) => o.index === Number(chosen) - 1)
    : undefined;
  const option = byLabel ?? byNumber;
  if (option?.keys !== undefined) return { keys: option.keys, text: null };
  const target = option?.index ?? (wanted.length > 0 ? prompt.customIndex : null);
  if (target === null || target === undefined) return null;
  const delta = target - prompt.selected;
  const arrows = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "down" : "up"));
  return option === undefined
    ? { keys: arrows, text: wanted }
    : { keys: [...arrows, "enter"], text: null };
}

/** What T3 sends back for an answered question: "<question>\n<answer>". */
const squash = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
/** True when `text` is what the question card sends: the question, a line break, then the answer. */
export function isCardAnswer(text, prompt) {
  const body = String(text ?? "").trim();
  const asked = squash(prompt.question);
  if (asked === "") return false;
  for (let at = body.indexOf("\n"); at > 0; at = body.indexOf("\n", at + 1))
    if (squash(body.slice(0, at)).endsWith(asked)) return true;
  return false;
}

export const questionWaitingNote = (question, count) =>
  `A question is waiting${question ? ` (${squash(question).slice(0, 160)})` : ""}. Answer it on its card; this message is not an answer, so it is kept (${count} waiting) and goes after the question is answered.`;

export function answerFrom(text, prompt) {
  const body = String(text ?? "").trim();
  const asked = prompt.question;
  const at = body.indexOf("\n");
  if (at > 0 && body.slice(0, at).trim().endsWith(asked)) return body.slice(at + 1).trim();
  return body;
}

// ---------------------------------------------------------------------------------------------
// The live session

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const herdrEnvOf = (pid) => {
  const map = new Map();
  try {
    for (const entry of NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const at = entry.indexOf("=");
      if (at > 0 && entry.startsWith("HERDR_")) map.set(entry.slice(0, at), entry.slice(at + 1));
    }
  } catch {}
  return map;
};

/** The running interactive process for a Claude conversation id, or null. */
export function findLiveSession(sessionId) {
  for (const dir of sessionsDirs()) {
    const found = findIn(sessionId, dir);
    if (found !== null) return found;
  }
  return null;
}

function findIn(sessionId, dir) {
  let names = [];
  try {
    names = NodeFS.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return null;
  }
  for (const name of names) {
    let d;
    try {
      d = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (d?.sessionId !== sessionId || d.kind !== "interactive" || typeof d.pid !== "number")
      continue;
    if (!alive(d.pid)) continue;
    const env = herdrEnvOf(d.pid);
    const pane = process.env.BATON_TEST_HERDR_PANE ?? currentPaneRef(env, sessionId);
    return {
      pid: d.pid,
      cwd: d.cwd,
      status: d.status ?? null,
      pane,
      remoteControl: typeof d.bridgeSessionId === "string" && d.bridgeSessionId.length > 0,
    };
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const run = (file, args, timeout = 15_000) =>
  new Promise((resolve) =>
    NodeChildProcess.execFile(file, args, { timeout }, (error, stdout, stderr) =>
      resolve({
        ok: error === null,
        timedOut: error?.killed === true,
        out: `${stdout}${stderr}`.trim(),
      }),
    ),
  );

/** `herdr [--session S] agent <verb> <pane> ...` for a `<session>~<pane>` ref. */
const herdrArgs = (paneRef, verb, rest) => {
  const at = paneRef.indexOf("~");
  return at < 0
    ? ["agent", verb, paneRef, ...rest]
    : ["--session", paneRef.slice(0, at), "agent", verb, paneRef.slice(at + 1), ...rest];
};

const BLOCKED_NOTE =
  "Claude Code is waiting on a question or an approval in its terminal; answer it there first.";
/** Herdr did not answer in time: the text may already be in the pane, so it is never typed again. */
export const UNSURE_NOTE = "Herdr did not answer in time.";

// ---------------------------------------------------------------------------------------------
// The message queue. A message that cannot be delivered now is appended to `inbound.ndjson` in the live-queue folder
// (`liveQueueDir`); the server takes each line into its one queue (the weave table) and types it when the pane takes
// input, so a restart of either side does not lose it. The turn never waits for it (T3 would queue every later send
// behind it). The per-session files below are what the server writes for the thread to show (`note` items), and the
// old queue the drainer still types from, except for a session the server owns (`<id>.server`).

/** The server's `stateSubdir` rule (packages/baton-shared/src/stateDir.ts), so both sides use one folder. */
export const liveQueueDir = (home) => {
  const next = NodePath.join(home, ".t3", "tessaya", "live-queue");
  const legacy = NodePath.join(home, ".t3", "baton", "live-queue");
  return !NodeFS.existsSync(next) && NodeFS.existsSync(legacy) ? legacy : next;
};
const QUEUE_DIR = process.env.BATON_LIVE_QUEUE_DIR ?? liveQueueDir(NodeOS.homedir());
const QUEUE_TRIES = Number(process.env.BATON_LIVE_QUEUE_TRIES ?? 6);
const QUEUE_EVERY_MS = Number(process.env.BATON_LIVE_QUEUE_EVERY_MS ?? 3_000);
/** A session gone this long with messages waiting is not coming back soon: they are handed back. */
const QUEUE_GONE_TRIES = Number(process.env.BATON_LIVE_QUEUE_GONE_TRIES ?? 10);

const queueFile = (dir, sessionId) =>
  NodePath.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export function readQueue(dir, sessionId) {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(queueFile(dir, sessionId), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(dir, sessionId, items) {
  const file = queueFile(dir, sessionId);
  if (items.length === 0) return void NodeFS.rmSync(file, { force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(items), { mode: 0o600 });
  NodeFS.renameSync(temp, file);
}

/** Adds one message at the end; returns how many are now waiting. */
export function enqueue(dir, sessionId, item) {
  const items = [...readQueue(dir, sessionId), { tries: 0, ...item }];
  writeQueue(dir, sessionId, items);
  return items.length;
}

/** Hands a message to the server's queue. One line per message, appended, so two bridges never overwrite each other. */
export function appendInbound(dir, entry) {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.appendFileSync(
    NodePath.join(dir, "inbound.ndjson"),
    `${JSON.stringify({ id: NodeCrypto.randomUUID(), at: Date.now(), ...entry })}\n`,
    { mode: 0o600 },
  );
}

const ownedFile = (dir, sessionId) =>
  NodePath.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.server`);

/** How many of the session's messages the server owns and has not typed yet; 0 when it owns none. */
export function serverWaiting(dir, sessionId) {
  try {
    const marker = JSON.parse(NodeFS.readFileSync(ownedFile(dir, sessionId), "utf8"));
    return Number.isInteger(marker?.waiting) && marker.waiting > 0 ? marker.waiting : 1;
  } catch {
    return 0;
  }
}

/** Queues a message for the session behind what already waits; returns how many are now waiting. */
export function queueForServer(dir, sessionId, item) {
  const ahead =
    serverWaiting(dir, sessionId) +
    readQueue(dir, sessionId).filter((i) => i.kind !== "note").length;
  appendInbound(dir, { sessionId, text: item.text, label: item.label ?? null });
  // Owned from now, before the server has read the line, so the next message queues behind it rather than going first.
  const temp = `${ownedFile(dir, sessionId)}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify({ waiting: ahead + 1 }), { mode: 0o600 });
  NodeFS.renameSync(temp, ownedFile(dir, sessionId));
  return ahead + 1;
}

export const queuedSessions = (dir) => {
  try {
    return NodeFS.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
};

const preview = (text) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

export const queuedNote = (reason, count) =>
  `Not delivered yet: ${reason} ${count} message${count === 1 ? "" : "s"} queued; they send ${
    reason.includes("question") ? "when you answer it" : "as soon as it can take them"
  }.`;

export const deliveredNote = (shown) => `Delivered: ${preview(shown)}`;

/** The words are never lost: a message that cannot be delivered comes back, quoted. */
export const lostNote = (reason, shown) => `Not delivered: ${reason} Your message was: "${shown}"`;

/** A send Herdr never answered: it may have arrived, so it is not sent again. */
export const maybeNote = (shown) =>
  `Maybe delivered: Herdr did not answer in time, so it may already be in the session; it is not sent again in case it is. Your message was: "${shown}"`;

/**
 * One pass over one session's queue, oldest first. Stops at the first message that cannot go yet, so
 * the order is kept. `deps` are the live session, the pane and the thread, injected for tests.
 */
/** Messages held back (a resume is under way or failed): kept, in order, never handed back or dropped. */
export function holdQueue(dir, sessionId, reason) {
  const items = readQueue(dir, sessionId);
  if (items.length > 0)
    writeQueue(
      dir,
      sessionId,
      items.map((item) => ({ ...item, held: reason })),
    );
}

export function releaseQueue(dir, sessionId) {
  const items = readQueue(dir, sessionId);
  if (items.some((item) => item.held))
    writeQueue(
      dir,
      sessionId,
      items.map(({ held: _gone, ...item }) => item),
    );
}

/**
 * Replaces the item `head` was with `next` (null drops it) in the queue as it is on disk now, so what
 * was added during an await is kept. Matched by its contents: items carry no id.
 */
function settleHead(dir, sessionId, head, next) {
  const key = JSON.stringify(head);
  const items = readQueue(dir, sessionId);
  const at = items.findIndex((item) => JSON.stringify(item) === key);
  if (at < 0) return;
  const kept = items.flatMap((item, i) => (i !== at ? [item] : next === null ? [] : [next]));
  writeQueue(dir, sessionId, kept);
}

/**
 * One drainer at a time across every live-session process (T3 runs one per thread), or two would type
 * the same head twice. A lock left by a process that died is taken over. Returns the release, or null.
 */
export function takeDrainLock(dir) {
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
    // 0 or a torn write would signal our own process group: only a real pid counts as a holder.
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = error?.code === "EPERM";
      }
    }
    if (alive) return null;
    NodeFS.rmSync(lock, { force: true });
    if (!take()) return null;
  }
  return () => NodeFS.rmSync(lock, { force: true });
}

export async function drainSession(dir, sessionId, deps) {
  const release = takeDrainLock(dir);
  if (release === null) return;
  try {
    await drainLocked(dir, sessionId, deps);
  } finally {
    release();
  }
}

async function drainLocked(dir, sessionId, deps) {
  // A note (weaving: "sent to X") is only shown in this thread; it never waits on the pane.
  const all = readQueue(dir, sessionId);
  if (all.some((item) => item.kind === "note")) {
    for (const item of all) if (item.kind === "note") deps.say(sessionId, String(item.text));
    writeQueue(
      dir,
      sessionId,
      all.filter((item) => item.kind !== "note"),
    );
  }
  const items = readQueue(dir, sessionId);
  if (items.length === 0) return;
  // The server owns what waits for this session: only it types, so nothing is typed twice.
  if (serverWaiting(dir, sessionId) > 0) return;
  const live = deps.findLive(sessionId);
  if (items[0].held) {
    // A failed resume's hold ends once the session is back in a pane by any route; "resuming" ends with its resume.
    if (items[0].held === "resuming" || live === null || live.pane === null) return;
    releaseQueue(dir, sessionId);
    return drainLocked(dir, sessionId, deps);
  }
  // Running in a plain terminal: it is not gone, so what waits is kept until it has a pane.
  if (live !== null && live.pane === null) return;
  if (live === null) {
    const gone = items.map((item) => ({ ...item, gone: (item.gone ?? 0) + 1 }));
    if (gone[0].gone >= QUEUE_GONE_TRIES) {
      for (const item of items) {
        deps.say(sessionId, lostNote("the session is no longer running here.", item.shown));
      }
      return writeQueue(dir, sessionId, []);
    }
    return writeQueue(dir, sessionId, gone);
  }
  if (live.status === "waiting") return;
  while (true) {
    const [head] = readQueue(dir, sessionId);
    if (head === undefined) return;
    const failure = await deps.typeInto(live.pane, head.text);
    if (failure === null) {
      settleHead(dir, sessionId, head, null);
      deps.say(sessionId, deliveredNote(head.shown));
      continue;
    }
    if (failure === BLOCKED_NOTE) return;
    const tries = head.tries + 1;
    if (failure === UNSURE_NOTE) {
      settleHead(dir, sessionId, head, null);
      deps.say(sessionId, maybeNote(head.shown));
      continue;
    }
    if (tries >= QUEUE_TRIES) {
      settleHead(dir, sessionId, head, null);
      deps.say(sessionId, lostNote(failure, head.shown));
      continue;
    }
    return settleHead(dir, sessionId, head, { ...head, tries });
  }
}

/**
 * A send to a stopped session: the message goes to the server's queue at once and the session is resumed; the
 * server types it once the session is up in a pane. A failure says why, and the message still waits there.
 */
export async function sendToStopped(dir, sessionId, item, deps) {
  queueForServer(dir, sessionId, item);
  deps.say(sessionId, resumingNote(item.shown));
  const result = await resumeSession(sessionId, deps);
  if (result.error !== undefined) {
    deps.say(sessionId, resumeFailedNote(result.error, ""));
    return { state: "failed", error: result.error };
  }
  deps.say(sessionId, "Resumed in Herdr with its history. Sending now.");
  return { state: "resumed" };
}

/** The prompt on the pane's screen now, or null. `waiting`: a screen it has no reader for is Enter and Esc. */
export async function readPanePrompt(paneRef, waiting = false) {
  const read = await run(
    HERDR,
    herdrArgs(paneRef, "read", ["--source", "visible", "--lines", "80"]),
  );
  return read.ok ? (waiting ? parseWaitingScreen : parsePanePrompt)(read.out) : null;
}

/**
 * D88: answer the prompt showing in the pane with keystrokes, then wait until it is gone. Returns
 * what to tell the thread, or null when `text` is not an answer to it (nothing was pressed).
 */
const answering = new Map(); // pane -> the answer being pressed there, so two never interleave keys

/** `<id>.answered`: when the bridge last finished with a card's answer; the mirror re-raises a card only after it. */
const answeredFile = (dir, sessionId) =>
  NodePath.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.answered`);

export function answerPrompt(sessionId, paneRef, text) {
  const done = (answering.get(paneRef) ?? Promise.resolve()).then(() =>
    answerNow(sessionId, paneRef, text),
  );
  const tail = done.catch(() => {});
  answering.set(paneRef, tail);
  void tail.then(() => {
    if (answering.get(paneRef) === tail) answering.delete(paneRef);
  });
  return done;
}

/** Said when a card's answer reaches a dialog other than the one it was for. */
export const STALE_ANSWER_NOTE =
  "That answer was for a question that is no longer on the screen, so nothing was pressed. The question showing now has its own card.";

/** True when the text's first line is a card's question, which ends with its prompt's ref. */
export const isRefAnswer = (text) => {
  const body = String(text ?? "").trim();
  const at = body.indexOf("\n");
  return at > 0 && CARD_REF.test(body.slice(0, at).trim());
};

async function answerNow(sessionId, paneRef, text) {
  const shown = await readPanePrompt(paneRef, true);
  const forThis = shown !== null && isCardAnswer(text, shown);
  // A card's answer for another dialog presses nothing and is never typed as a message.
  const stale = !forThis && isRefAnswer(text);
  if (!forThis && !stale) return null;
  try {
    return stale ? STALE_ANSWER_NOTE : await pressAnswer(sessionId, paneRef, text, shown);
  } finally {
    try {
      NodeFS.mkdirSync(QUEUE_DIR, { recursive: true });
      NodeFS.writeFileSync(answeredFile(QUEUE_DIR, sessionId), String(Date.now()));
    } catch {}
  }
}

/** True while the pane still shows the dialog `shown` was read from. */
const stillShows = async (paneRef, shown) =>
  (await readPanePrompt(paneRef, true))?.key === shown.key;

async function pressAnswer(sessionId, paneRef, text, shown) {
  const answer = answerFrom(text, shown);
  const plan = answerKeys(shown, answer);
  if (plan === null) return null;
  // The last key commits: the pane is read again just before it, so a dialog that changed meanwhile is never confirmed.
  const commit = plan.text === null ? plan.keys.slice(-1) : [];
  const moves = plan.text === null ? plan.keys.slice(0, -1) : plan.keys;
  if (moves.length > 0) await run(HERDR, herdrArgs(paneRef, "send-keys", moves));
  if (plan.text !== null) await sleep(300);
  if (!(await stillShows(paneRef, shown))) return STALE_ANSWER_NOTE;
  if (commit.length > 0) await run(HERDR, herdrArgs(paneRef, "send-keys", commit));
  if (plan.text !== null) {
    const at = paneRef.indexOf("~");
    const session = at < 0 ? [] : ["--session", paneRef.slice(0, at)];
    await run(HERDR, [
      ...session,
      "pane",
      "send-text",
      at < 0 ? paneRef : paneRef.slice(at + 1),
      plan.text,
    ]);
    await run(HERDR, herdrArgs(paneRef, "send-keys", ["enter"]));
  }
  // The last question of a form is followed by "Ready to submit your answers?". He already submitted once, so
  // Submit is pressed for him (never Cancel or Go back); a different question is left to be shown as a new card.
  let submitted = false;
  for (let i = 0; i < PROMPT_CLEAR_TRIES; i += 1) {
    await sleep(500);
    const now = await readPanePrompt(paneRef);
    if (now?.review === true && shown.review !== true) {
      const confirm = submitted ? null : answerKeys(now, "Submit answers");
      if (confirm !== null) {
        await run(HERDR, herdrArgs(paneRef, "send-keys", confirm.keys));
        submitted = true;
      }
      continue;
    }
    if (now === null || now.key !== shown.key) {
      const told = `Answered in the terminal: ${plan.text ?? answer}.`;
      if (now !== null) return `${told} The session is asking again now.`;
      if (submitted) return `${told} Your answers were submitted.`;
      const status = findLiveSession(sessionId)?.status ?? "gone";
      return `${told} The session is ${status === "waiting" ? "asking again" : status} now.`;
    }
  }
  return `The answer "${plan.text ?? answer}" was pressed, but the terminal still shows the question.`;
}

/** Herdr's `agent prompt` pastes with the terminal's bracketed-paste mode, then presses Enter. */
async function typeInto(paneRef, text) {
  const sent = await run(HERDR, herdrArgs(paneRef, "prompt", [text]));
  if (sent.ok) {
    // Claude Code reads a pasted @image while the paste's Enter arrives and drops that Enter,
    // so the message sat unsent in its input (D85). A second Enter on an empty input is a no-op.
    if (/^@\//m.test(text)) {
      await sleep(ATTACHMENT_ENTER_MS);
      await run(HERDR, herdrArgs(paneRef, "send-keys", ["enter"]));
    }
    return null;
  }
  return sendFailure(sent);
}

/** Why a `herdr agent prompt` that did not succeed failed: a timeout is unsure, never a refusal. */
export const sendFailure = (sent) =>
  sent.timedOut
    ? UNSURE_NOTE
    : /agent_blocked/.test(sent.out)
      ? BLOCKED_NOTE
      : `Herdr did not take the message: ${sent.out.slice(0, 200)}`;

/** A request to bring a stopped session back without sending anything: just "resume". */
export const isResumeRequest = (text) => /^\s*resume( it| this session)?\s*\.?\s*$/i.test(text);

export const resumingNote = (shown) =>
  `Resuming this session in Herdr. Your message is kept and goes when it is ready: "${shown}"`;

export const resumeFailedNote = (reason, shown) =>
  `Could not resume: ${reason} Your message is kept${shown ? `: "${shown}"` : ""}. Send again, or say "resume", to try again.`;

const READY_MS = Number(process.env.BATON_LIVE_RESUME_READY_MS ?? 45_000);

/**
 * Brings a stopped Claude conversation back in Herdr with its history: `baton --resume <id> <folder>` on this
 * machine (the live agent runs on the thread's own box), then waits until it is in a pane and not mid-turn.
 * Returns the live session, or why not in words for a person. `deps` are the outside world, for tests.
 */
export async function resumeSession(sessionId, deps) {
  const cwd = deps.cwdOf(sessionId);
  if (cwd === null)
    return {
      error:
        "I do not know which folder this conversation was in, and its transcript is not on this machine.",
    };
  if (!deps.dirExists(cwd)) return { error: `The folder ${cwd} is not on this machine.` };
  const out = await deps.baton(["--resume", sessionId, cwd]);
  if (!/running in (\S+) pane (\S+)/.test(out.out))
    return {
      error: `Herdr would not start it: ${out.out.replace(/\s+/g, " ").slice(0, 160) || "no answer"}.`,
    };
  const started = deps.now();
  for (;;) {
    const live = deps.findLive(sessionId);
    if (live !== null && live.pane !== null && live.status !== "busy") return { live };
    if (deps.now() - started >= READY_MS) {
      const at = /running in (\S+) pane (\S+)/.exec(out.out);
      const screen =
        at === null || deps.screenOf === undefined
          ? ""
          : await deps.screenOf(at[1], at[2]).catch(() => "");
      return {
        error:
          /Is this a project you created or one you trust|trust this folder|Do you trust the files/i.test(
            screen,
          )
            ? `Claude Code is asking whether to trust this folder, and waits for you to choose in Herdr (herdr --session ${at[1]}). Choose, then resume again.`
            : "It was started in Herdr but did not become ready within 45 seconds.",
      };
    }
    await deps.sleep(500);
  }
}

/** The folder a stopped conversation ran in, from its transcript in any Claude config folder. */
export function cwdFromTranscript(sessionId) {
  for (const sessions of sessionsDirs()) {
    const projects = NodePath.join(NodePath.dirname(sessions), "projects");
    let slugs = [];
    try {
      slugs = NodeFS.readdirSync(projects);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const file = NodePath.join(projects, slug, `${sessionId}.jsonl`);
      if (!NodeFS.existsSync(file)) continue;
      try {
        const fd = NodeFS.openSync(file, "r");
        const buf = Buffer.alloc(32 * 1024);
        const head = buf.subarray(0, NodeFS.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
        NodeFS.closeSync(fd);
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
        if (m !== null) return JSON.parse(`"${m[1]}"`);
      } catch {}
    }
  }
  return null;
}

/** D74 adoption: an idle plain-terminal session is reopened in Herdr with the same conversation. */
async function adopt(sessionId, live) {
  if (live.status === "busy") {
    return {
      error:
        "It is working in a plain terminal right now. Send again when it is idle and Tessaya will move it into Herdr.",
    };
  }
  process.kill(live.pid, "SIGTERM");
  for (let i = 0; i < 40 && alive(live.pid); i += 1) await sleep(250);
  if (alive(live.pid)) return { error: "It did not exit, so it was left as it was." };
  const out = await run(BATON, ["--resume", sessionId, live.cwd], 30_000);
  if (!/running in (\S+) pane (\S+)/.test(out.out))
    return { error: `tessaya --resume said: ${out.out.slice(0, 200)}` };
  for (let i = 0; i < 60; i += 1) {
    const next = findLiveSession(sessionId);
    if (next?.pane && next.status !== "busy") return { live: next };
    await sleep(500);
  }
  return { error: "It reopened in Herdr but did not report ready in 30 s." };
}

/**
 * A name a person can read: the file's own, or `image-HH-MM.ext` when it is one of T3's generated
 * attachment names (thread id and uuid), plus a short suffix so two of the same name never collide.
 */
export function readableInboxName(fileName, now, suffix) {
  const clean = safeInboxName(fileName, "x").slice(2);
  const generated = /^baton-live|[0-9a-f]{8}-[0-9a-f]{4}-/.test(clean);
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? clean.slice(dot) : "";
  const hhmm = now.toISOString().slice(11, 16).replace(":", "-");
  const base = generated
    ? `${/^\.(png|jpe?g|gif|webp|heic)$/i.test(ext) ? "image" : "file"}-${hhmm}`
    : clean.slice(0, dot > 0 ? dot : clean.length);
  return `${base}-${suffix}${ext}`;
}

function saveToInbox(cwd, name, bytes) {
  const now = new Date();
  const day = NodePath.join(cwd, ".baton", "inbox", now.toISOString().slice(0, 10));
  NodeFS.mkdirSync(day, { recursive: true });
  // Keeps the inbox out of git and the diff panel (same rule as LiveActions).
  const ignore = NodePath.join(cwd, ".baton", ".gitignore");
  if (!NodeFS.existsSync(ignore)) NodeFS.writeFileSync(ignore, "*\n");
  const suffix = Math.random().toString(16).slice(2, 6);
  const path = NodePath.join(day, readableInboxName(name, now, suffix));
  NodeFS.writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/** The text Claude Code receives: the words, then `@path` for every file, copied into its inbox. */
function composeForSession(blocks, cwd) {
  const { text, paths } = splitAttachments(promptText(blocks));
  const refs = [];
  for (const path of paths) {
    try {
      refs.push(saveToInbox(cwd, path, NodeFS.readFileSync(path)));
    } catch {}
  }
  if (paths.length === 0) {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "image" && typeof block.data === "string") {
        const ext = String(block.mimeType ?? "image/png").split("/")[1] ?? "png";
        refs.push(saveToInbox(cwd, `image.${ext}`, Buffer.from(block.data, "base64")));
      }
    }
  }
  // A plain sentence first, so the session (and the thread's echo) reads as a person would.
  const attached = refs.map((ref) => {
    const kind = /\.(png|jpe?g|gif|webp|heic)$/i.test(ref) ? "image" : "file";
    return `He attached ${kind} ${NodePath.basename(ref)}:\n@${ref}`;
  });
  return [text, ...attached].filter((part) => part.length > 0).join("\n");
}

// ---------------------------------------------------------------------------------------------
// ACP over stdio (newline-delimited JSON-RPC 2.0, protocol v1)

const write = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const newSessionCwd = new Map(); // an unbound ACP session id -> the folder T3 asked for
const say = (sessionId, text) =>
  write({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });

/** One kept unbound message. The server stamps the thread (from `sessionId`, the thread's native id) if T3 gave none. */
export const keptEntry = (params, folder, words) => ({
  unbound: true,
  cwd: folder ?? null,
  sessionId: params.sessionId,
  threadId: params._meta?.threadId ?? process.env.T3CODE_THREAD_ID ?? null,
  text: words,
});

const turns = new Map(); // sessionId -> { cancelled: boolean, pane: string | null }

async function prompt(params) {
  const sessionId = params.sessionId;
  if (typeof sessionId === "string" && sessionId.startsWith(UNBOUND)) {
    // Unbound: never guessed, even with one session running in the folder. Kept beside the queues and shown here,
    // so Reattach (which asks first) binds the thread and the mirror then sends it. Attachments go to the folder's inbox.
    const folder = newSessionCwd.get(sessionId);
    const words =
      folder === undefined
        ? promptText(params.prompt).trim()
        : composeForSession(params.prompt, folder);
    try {
      appendInbound(QUEUE_DIR, keptEntry(params, folder, words));
    } catch {}
    say(
      sessionId,
      `This thread is not bound to a running Claude Code session, so nothing was delivered. Your message was kept: "${words}". Reattach the thread and it will be sent.`,
    );
    return { stopReason: "end_turn" };
  }
  if (typeof sessionId !== "string") {
    say(params.sessionId, "This thread is not bound to a running Claude Code session.");
    return { stopReason: "end_turn" };
  }
  if (isAppContinuation(promptText(params.prompt))) return { stopReason: "end_turn" };
  if (isAnswerInTerminal(promptText(params.prompt))) {
    say(sessionId, "Understood. Answer it in the terminal; it carries on from there.");
    return { stopReason: "end_turn" };
  }
  let live = findLiveSession(sessionId);
  if (live === null) {
    // Stopped: it is resumed and the message goes when it is ready. "Not delivered" is for nothing that can be fixed.
    const words = promptText(params.prompt);
    if (resumesInFlight.has(sessionId)) {
      const count = queueForServer(QUEUE_DIR, sessionId, { text: words.trim() });
      say(
        sessionId,
        `Still resuming. ${count} message${count === 1 ? "" : "s"} kept; they go when it is ready.`,
      );
      return { stopReason: "end_turn" };
    }
    const cwd = cwdFromTranscript(sessionId);
    const body = cwd === null ? words.trim() : composeForSession(params.prompt, cwd);
    resumesInFlight.add(sessionId);
    try {
      const wantsOnlyResume = isResumeRequest(words);
      const item = {
        text: body,
        shown: words.replace(/\s+/g, " ").trim().slice(0, 200) || "(resume)",
        at: new Date().toISOString(),
      };
      if (wantsOnlyResume) {
        say(sessionId, "Resuming this session in Herdr.");
        const result = await resumeSession(sessionId, resumeDeps);
        say(
          sessionId,
          result.error ?? "Resumed in Herdr with its history. Messages sent here now reach it.",
        );
      } else {
        await sendToStopped(QUEUE_DIR, sessionId, item, { ...resumeDeps, ...drainDeps });
      }
    } finally {
      resumesInFlight.delete(sessionId);
    }
    return { stopReason: "end_turn" };
  }
  if (live.pane === null) {
    // A plain-terminal session (often one he drives through Remote Control) cannot take typed
    // input from outside, and moving it into Herdr restarts it. That only happens when asked.
    if (!isAdoptRequest(promptText(params.prompt))) {
      say(
        sessionId,
        `${notSentNote(live)}\n\nYour message was: "${promptText(params.prompt).trim()}"`,
      );
      return { stopReason: "end_turn" };
    }
    const adopted = await adopt(sessionId, live);
    say(
      sessionId,
      adopted.error ??
        "Moved into Herdr with the same conversation. Messages sent here now reach it.",
    );
    return { stopReason: "end_turn" };
  }
  const text = composeForSession(params.prompt, live.cwd);
  if (text.length === 0) return { stopReason: "end_turn" };
  const shown = promptText(params.prompt).replace(/\s+/g, " ").trim() || text.slice(0, 60);
  const turn = { cancelled: false, pane: live.pane };
  turns.set(sessionId, turn);
  try {
    // A question or approval on the screen takes the message as its answer (D88); a card's answer is never typed.
    if (live.status === "waiting" || isRefAnswer(promptText(params.prompt))) {
      const answered = await answerPrompt(sessionId, live.pane, promptText(params.prompt));
      if (answered !== null) {
        say(sessionId, answered);
        return { stopReason: "end_turn" };
      }
    }
    // Messages already waiting go first: this one joins the end so the order he typed is kept.
    if (
      live.status === "waiting" ||
      serverWaiting(QUEUE_DIR, sessionId) > 0 ||
      readQueue(QUEUE_DIR, sessionId).some((item) => item.kind !== "note")
    ) {
      const count = queueForServer(QUEUE_DIR, sessionId, {
        text,
        label: NodePath.basename(live.cwd),
      });
      say(
        sessionId,
        live.status === "waiting"
          ? questionWaitingNote((await readPanePrompt(live.pane, true))?.question, count)
          : queuedNote("earlier messages are still waiting.", count),
      );
      return { stopReason: "end_turn" };
    }
    const failure = await typeInto(live.pane, text);
    if (failure === BLOCKED_NOTE) {
      const answered = await answerPrompt(sessionId, live.pane, promptText(params.prompt));
      if (answered !== null) {
        say(sessionId, answered);
        return { stopReason: "end_turn" };
      }
    }
    if (failure === UNSURE_NOTE) {
      say(sessionId, maybeNote(shown));
      return { stopReason: "end_turn" };
    }
    if (failure !== null) {
      const count = queueForServer(QUEUE_DIR, sessionId, {
        text,
        label: NodePath.basename(live.cwd),
      });
      say(
        sessionId,
        failure === BLOCKED_NOTE
          ? questionWaitingNote((await readPanePrompt(live.pane, true))?.question, count)
          : queuedNote("Herdr did not take it yet.", count),
      );
      return { stopReason: "end_turn" };
    }
    // The turn ends once Herdr has delivered the text. Holding it open until Claude Code went idle
    // made T3 queue every later message behind a session that is busy most of the time; Claude
    // Code takes input mid-turn itself. The mirror shows the session working (D85).
    return turn.cancelled ? { stopReason: "cancelled" } : { stopReason: "end_turn" };
  } finally {
    turns.delete(sessionId);
  }
}

/** The last effort typed into each session, so T3 re-applying a saved option on every activation types nothing. */
const efforts = new Map();

/**
 * An effort picked on a client without the web hook (mobile, a keybinding), before its next send. Typed only into an
 * idle session with nothing waiting; otherwise queued behind what waits, in order, as a message would be. A question
 * or approval on screen would take it as its answer. Returns what the control should show; never refuses the send.
 */
async function setEffort(params) {
  const sessionId = params.sessionId;
  const value = String(params.value ?? "");
  if (
    params.configId !== "effort" ||
    !LIVE_EFFORTS.includes(value) ||
    typeof sessionId !== "string"
  ) {
    return efforts.get(sessionId) ?? EFFORT_AS_IS;
  }
  if (efforts.get(sessionId) === value) return value;
  const live = findLiveSession(sessionId);
  if (live === null || live.pane === null) {
    say(
      sessionId,
      `Effort not changed to ${value}: this session is not in Herdr, so it cannot be told.`,
    );
    return efforts.get(sessionId) ?? EFFORT_AS_IS;
  }
  const command = `/effort ${value}`;
  if (
    live.status === "busy" ||
    live.status === "waiting" ||
    serverWaiting(QUEUE_DIR, sessionId) > 0 ||
    readQueue(QUEUE_DIR, sessionId).some((item) => item.kind !== "note")
  ) {
    const count = queueForServer(QUEUE_DIR, sessionId, {
      text: command,
      label: NodePath.basename(live.cwd),
    });
    say(
      sessionId,
      `Effort ${value} goes in once the session is free (${count} waiting, this included).`,
    );
    efforts.set(sessionId, value);
    return value;
  }
  const failure = await typeInto(live.pane, command);
  if (failure !== null) {
    say(sessionId, `Effort not changed to ${value}: ${failure}`);
    return efforts.get(sessionId) ?? EFFORT_AS_IS;
  }
  efforts.set(sessionId, value);
  return value;
}

const resumesInFlight = new Set();
const resumeDeps = {
  cwdOf: cwdFromTranscript,
  dirExists: (dir) => {
    try {
      return NodeFS.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  baton: (args) => run(BATON, args, 45_000).then((r) => ({ ok: r.ok, out: r.out })),
  findLive: findLiveSession,
  screenOf: async (session, pane) =>
    (
      await run(
        "herdr",
        ["--session", session, "agent", "read", pane, "--source", "visible", "--lines", "25"],
        8_000,
      )
    ).out,
  sleep,
  now: () => Date.now(),
};

let drainer = null;
const drainDeps = { findLive: findLiveSession, typeInto, say };
/**
 * Always on: shows the notes the server writes for this thread (delivered, not delivered), and types what an older
 * bridge left in a session's file unless the server owns that session.
 */
function startDrainer() {
  if (drainer !== null) return;
  const tick = async () => {
    for (const name of queuedSessions(QUEUE_DIR)) {
      await drainSession(QUEUE_DIR, name.slice(0, -".json".length), drainDeps).catch(
        () => undefined,
      );
    }
  };
  drainer = setInterval(() => void tick(), QUEUE_EVERY_MS);
  drainer.unref?.();
}

async function handle(message) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentInfo: { name: "baton-live", title: "Tessaya live session", version: "1" },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          sessionCapabilities: { resume: {} },
        },
        authMethods: [],
      };
    case "session/new": {
      const bound = sessionOfLiveThread(process.env.T3CODE_THREAD_ID);
      if (bound !== null)
        return { sessionId: bound, models: LIVE_MODELS, configOptions: [effortConfigOption()] };
      const unbound = `${UNBOUND}-${process.pid}-${id}`;
      if (typeof params.cwd === "string") newSessionCwd.set(unbound, params.cwd);
      return { sessionId: unbound, models: LIVE_MODELS, configOptions: [effortConfigOption()] };
    }
    case "session/resume":
      return { models: LIVE_MODELS, configOptions: [effortConfigOption()] };
    // The model is the session's own: T3 re-selecting "live" changes nothing (a real pick types /model, 0009).
    case "session/set_model":
      return {};
    case "session/set_config_option":
      return { configOptions: [effortConfigOption(await setEffort(params))] };
    case "session/prompt":
      return prompt(params);
    case "session/cancel": {
      // Stop reaches Claude Code as Esc in its pane, during a send or after it.
      const turn = turns.get(params.sessionId);
      if (turn) turn.cancelled = true;
      const pane = turn?.pane ?? findLiveSession(params.sessionId)?.pane ?? null;
      if (pane) await run(HERDR, herdrArgs(pane, "send-keys", ["esc"]));
      return undefined;
    }
    default:
      if (id === undefined) return undefined;
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function main() {
  // A name of its own, so earlyoom's --avoid can match it.
  process.title = "baton-live-acp";
  lowerOomScore();
  startDrainer();
  const lines = NodeReadline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message.method !== "string") return; // responses to us: none expected
    handle(message).then(
      (result) => {
        if (message.id !== undefined) write({ id: message.id, result: result ?? null });
      },
      (error) => {
        if (message.id !== undefined)
          write({
            id: message.id,
            error: { code: error.code ?? -32603, message: String(error.message ?? error) },
          });
      },
    );
  });
  lines.on("close", () => process.exit(0));
}

if (
  process.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  main();
}
