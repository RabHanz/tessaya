/**
 * Every Claude session on a machine, running or stopped, in any folder and under any account, and the
 * actions that bring one back: resume in Herdr, send (which resumes first), start a new one. One set of
 * methods per environment; the client asks each connected environment and adds its name. Plain JSON.
 */
import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "@t3tools/contracts";

export const BATON_SESSIONS_WS_METHODS = {
  list: "baton.sessions.list",
  folders: "baton.sessions.folders",
  resume: "baton.sessions.resume",
  create: "baton.sessions.create",
  send: "baton.sessions.send",
  cleanup: "baton.sessions.cleanup",
  autoResume: "baton.sessions.autoresume",
  retireHandoff: "baton.sessions.retirehandoff",
  reattach: "baton.sessions.reattach",
  moveIntoTessaya: "baton.sessions.moveintotessaya",
  openInTerminal: "baton.sessions.openinterminal",
  mainSession: "baton.sessions.mainsession",
  sessionDefaults: "baton.sessions.defaults",
  kept: "baton.sessions.kept",
  waiting: "baton.sessions.waiting",
  across: "baton.sessions.across",
  inFlight: "baton.sessions.inflight",
} as const;

/** One live session as Baton's own window lists it (D138), built from the sidebar's project rows (tessaya-shared). */
export const TessayaSessionSummary = Schema.Struct({
  key: Schema.String,
  project: Schema.String,
  session: Schema.String,
  /** What a person calls the login; the window masks it until clicked. */
  account: Schema.NullOr(Schema.String),
  state: Schema.Literals(["working", "waiting", "idle"]),
  /** Needs him: a question or an approval. */
  urgent: Schema.Boolean,
  box: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  /** The T3 thread to open, when this session has one. */
  thread: Schema.NullOr(Schema.Struct({ environmentId: Schema.String, threadId: Schema.String })),
  /** The terminal pane text can be typed into, when it has one. */
  pane: Schema.NullOr(Schema.Struct({ environmentId: Schema.String, pane: Schema.String })),
  /** The access of the link it was listed over; null on the listing server itself, absent from the sidebar's push. */
  access: Schema.optionalKey(Schema.NullOr(AuthMcpClientAccess)),
});
export type TessayaSessionSummary = typeof TessayaSessionSummary.Type;

export const TessayaSessionsAcrossInput = Schema.Struct({
  /** This server's own sessions only: cheap and fresh, for the desktop's quick refresh and its check before typing. */
  hereOnly: Schema.optionalKey(Schema.Boolean),
});
export const TessayaSessionsAcrossResult = Schema.Struct({
  /** The listing server itself, so a client tells this computer's sessions and actions from another's. */
  here: Schema.Struct({ environmentId: Schema.String, label: Schema.String }),
  sessions: Schema.Array(TessayaSessionSummary),
  /** Linked environments that did not answer, so their sessions are missing rather than gone. */
  unreachable: Schema.Array(Schema.Struct({ environmentId: Schema.String, label: Schema.String })),
});
export type TessayaSessionsAcrossResult = typeof TessayaSessionsAcrossResult.Type;

export const TessayaCatalogState = Schema.Literals(["running", "stopped", "resuming", "failed"]);
export type TessayaCatalogState = typeof TessayaCatalogState.Type;

export const TessayaCatalogSession = Schema.Struct({
  /** The Claude session id. */
  id: Schema.String,
  /** The machine's own name; the client shows the environment's label. */
  machine: Schema.String,
  project: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  title: Schema.String,
  lastActivityAt: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  state: TessayaCatalogState,
  /** Running now, a transcript on this machine, or only found in the history index. */
  source: Schema.Literals(["live", "transcript", "history"]),
  canResume: Schema.Boolean,
  /** Plain words: why it cannot be resumed, or why it failed. */
  detail: Schema.NullOr(Schema.String),
  /** Messages waiting for it to be ready. */
  waiting: Schema.Number,
  /** On a machine with no Herdr: the thread it was brought back as, once it exists. */
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Set while a turn runs in the thread a resume brought back, so it can be stopped. */
  turnRunning: Schema.optionalKey(Schema.Boolean),
  /** The Herdr pane a running session is in (`<herdr session>~<pane>`), if any. */
  pane: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The provider instance answering this session's live thread; not `baton-live` means a handoff session. */
  answeredBy: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Stopped because it died mid-turn and was not brought back; `detail` says why not. */
  crashed: Schema.optionalKey(Schema.Boolean),
});
export type TessayaCatalogSession = typeof TessayaCatalogSession.Type;

export const TessayaCatalogListInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  limit: Schema.optionalKey(Schema.Number),
  /** Rows older than this ISO time: the next page. */
  before: Schema.optionalKey(Schema.String),
  /** Include background runs (non-interactive, SDK and Tessaya's own helpers); off by default. */
  background: Schema.optionalKey(Schema.Boolean),
  /** False: `query` matches titles and folders only, never the history index's transcripts. */
  history: Schema.optionalKey(Schema.Boolean),
});
export const TessayaCatalogListResult = Schema.Struct({
  machine: Schema.String,
  sessions: Schema.Array(TessayaCatalogSession),
  more: Schema.Boolean,
});

export const TessayaCatalogFoldersInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const TessayaCatalogFoldersResult = Schema.Struct({
  folders: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      project: Schema.String,
      lastActivityAt: Schema.NullOr(Schema.String),
    }),
  ),
});

export const TessayaCatalogResumeInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(80)),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export const TessayaCatalogResumeResult = Schema.Struct({
  state: TessayaCatalogState,
  pane: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  /** Set when the session came back as a T3 thread (a machine with no Herdr, such as Windows). */
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const TessayaCatalogCreateInput = Schema.Struct({
  cwd: Schema.String.check(Schema.isMaxLength(500)),
  agent: Schema.optionalKey(Schema.Literal("claude")),
  /** A family ("opus", "sonnet") or a model id; used where the session is a T3 thread (no Herdr). */
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  /** Reasoning effort: low, medium, high, xhigh or max. */
  effort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20))),
  /** The first message, sent once the thread is up. */
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65_536))),
});
export const TessayaCatalogCreateResult = Schema.Struct({
  state: TessayaCatalogState,
  sessionId: Schema.NullOr(Schema.String),
  pane: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  /** The T3 thread that was started, on a machine with no Herdr. */
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const TessayaCatalogSendInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(80)),
  text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export const TessayaCatalogSendResult = Schema.Struct({
  /** "running" when it was delivered; "resuming" while it comes back; "failed" with the reason (the message is kept). */
  state: TessayaCatalogState,
  delivered: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
});

/** The messages a session keeps until it can take them; `discard` drops one, named by place and text so a send in between cannot drop the wrong one. */
export const TessayaCatalogWaitingInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(80)),
  discard: Schema.optionalKey(
    Schema.Struct({ index: Schema.Number, text: Schema.String.check(Schema.isMaxLength(65_536)) }),
  ),
});
export const TessayaCatalogWaitingResult = Schema.Struct({
  messages: Schema.Array(Schema.String),
  /** They are being sent right now, so nothing can be discarded until that ends. */
  sending: Schema.Boolean,
});

/** What an update, an install or a restart of this machine would cut off mid-turn (SESS-SURVIVE). */
export const TessayaTurnsInFlightResult = Schema.Struct({
  threads: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
  live: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      name: Schema.NullOr(Schema.String),
      cwd: Schema.String,
    }),
  ),
});

/** Archives (reversibly) the threads that only mirror Tessaya's own helper sessions; without `apply` it only lists them. */
export const TessayaCatalogCleanupInput = Schema.Struct({ apply: Schema.Boolean });
export const TessayaCatalogCleanupResult = Schema.Struct({
  /** What it would archive (or did). */
  found: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      project: Schema.String,
      reason: Schema.String,
    }),
  ),
  /** The ids archived by this call; empty unless `apply`. */
  archived: Schema.Array(Schema.String),
  /** Looked like helper threads but were left alone, and why. */
  left: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, reason: Schema.String }),
  ),
});

/** The auto-resume watchdog: run it once, read its switch, or mark a session as stopped on purpose so it stays stopped. */
export const TessayaCatalogAutoResumeInput = Schema.Struct({
  /** stop: end it and keep it stopped; mark: it was stopped from outside, keep it stopped; on / off: the Auto-resume switch. */
  action: Schema.Literals(["run", "status", "stop", "mark", "on", "off"]),
  sessionId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
export const TessayaCatalogAutoResumeResult = Schema.Struct({
  enabled: Schema.Boolean,
  resumed: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.Struct({ id: Schema.String, why: Schema.String })),
});

/** Put a live thread back on its own session and remove the twin a provider switch started. */
export const TessayaRetireHandoffInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isMaxLength(120)),
  twinThreadId: Schema.String.check(Schema.isMaxLength(120)),
  /** Must be `retire-handoff:<threadId>`. */
  confirm: Schema.String.check(Schema.isMaxLength(200)),
  /** The live session has caught up on what the twin did. */
  caughtUp: Schema.Boolean,
  /** The main thread is already back on its live session: remove only the twin's mirror thread. */
  twinOnly: Schema.optionalKey(Schema.Boolean),
});
export const TessayaRetireHandoffResult = Schema.Struct({
  state: Schema.Literals(["retired", "refused", "incomplete"]),
  detail: Schema.String,
  undoFile: Schema.NullOr(Schema.String),
  archived: Schema.optionalKey(Schema.Literals(["already", "done", "failed"])),
  deleted: Schema.optionalKey(Schema.Literals(["done", "refused"])),
});

/** Bind a session's live thread to its running session again (what the 30 s heal does), on request. */
export const TessayaReattachInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(80)),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  /** The pane the person confirmed, when no session has this id and one other runs in the folder. */
  confirmPane: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const TessayaReattachResult = Schema.Struct({
  /** confirm: ask the person "Reattach to <pane>?" and call again with `confirmPane`. */
  state: Schema.Literals(["reattached", "already-bound", "confirm", "not-running", "busy"]),
  pane: Schema.NullOr(Schema.String),
  detail: Schema.String,
});

/** End a Terminal thread's session in its terminal and continue the same session id in Tessaya (claudeAgent). */
export const BatonMoveIntoTessayaInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isMaxLength(120)),
  /** The person confirmed moving to another provider (the same flag as message.dispatch's). */
  providerChangeApproved: Schema.optionalKey(Schema.Boolean),
});
export const BatonMoveIntoTessayaResult = Schema.Struct({
  state: Schema.Literals(["moved", "refused", "busy"]),
  detail: Schema.String,
  instanceId: Schema.NullOr(Schema.String),
});

/** Open a Tessaya (claudeAgent) thread's session in a Herdr pane; the thread follows it there until it closes. */
export const TessayaOpenInTerminalInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isMaxLength(120)),
});
export const TessayaOpenInTerminalResult = Schema.Struct({
  state: Schema.Literals(["opened", "refused", "busy"]),
  pane: Schema.NullOr(Schema.String),
  detail: Schema.String,
});

/** Make a thread the main session (kept pinned, and kept across a restart in its pane), or stop it being that. */
export const TessayaMainSessionInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isMaxLength(120)),
  main: Schema.Boolean,
});
/** Where new sessions run and which thread is the main session, read only. */
export const TessayaSessionDefaultsResult = Schema.Struct({
  newSessionsRun: Schema.Literals(["tessaya", "terminal"]),
  mainThreadId: Schema.NullOr(Schema.String),
});

/** The messages a thread kept because it had no session, and a Retry that sends one (or the oldest) back through it. */
export const TessayaKeptInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isMaxLength(120)),
  retryId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
export const TessayaKeptResult = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, at: Schema.String, text: Schema.String }),
  ),
  /** With `retryId`: sent into the thread, or why not. */
  retry: Schema.NullOr(Schema.Literals(["sent", "busy", "none"])),
});
