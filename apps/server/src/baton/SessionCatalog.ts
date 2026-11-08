// @effect-diagnostics globalTimers:off
/**
 * The session catalog's logic, with every outside thing passed in (the running sessions, the transcripts on
 * disk, the history index, the `baton` program, typing into a pane, the clock), so the stopped -> resume ->
 * ready -> deliver path is tested without Herdr or Claude. The Effect service and the RPC door sit on this.
 */
import type {
  BatonCatalogSession,
  BatonCatalogState,
  ClaudeLiveSession,
} from "@t3tools/baton-contracts";

export interface TranscriptInfo {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly title: string;
  /** ISO time of the last write. */
  readonly lastActivityAt: string;
  readonly account: string | null;
  /** A non-interactive or helper run: hidden from the list unless asked for. */
  readonly background?: boolean;
  /** The transcript file, so the end of it can be read. */
  readonly file?: string;
}

export interface HistoryHit {
  readonly sessionId: string;
  readonly project: string;
  readonly at: string | null;
}

/** `blocked`: it waits on a question; `refused`: nothing was typed for another reason (no pane, no Herdr). */
export type SendOutcome = "sent" | "blocked" | "refused" | "unsure";

/**
 * What a Herdr send's answer means for a kept message: only a definite refusal keeps it; anything else may have been
 * typed. Matches the wording of HerdrAdapterLive's agent_blocked answer and HerdrSend's no-pane and no-Herdr answers.
 */
export const sendOutcome = (result: {
  readonly delivered: boolean;
  readonly detail: string;
}): SendOutcome =>
  result.delivered
    ? "sent"
    : /is waiting on a question or an approval in its terminal, so nothing was sent/.test(
          result.detail,
        )
      ? "blocked"
      : /^(No Herdr pane \S+ is running here now|Herdr is not available here)/.test(result.detail)
        ? "refused"
        : "unsure";

export interface CatalogPorts {
  readonly machine: string;
  readonly live: () => Promise<ReadonlyArray<ClaudeLiveSession>>;
  /** Newest first, up to `limit`. */
  readonly transcripts: (limit: number) => Promise<ReadonlyArray<TranscriptInfo>>;
  /** The history index, searched for the words; empty when it is not set up. */
  readonly history: (query: string) => Promise<ReadonlyArray<HistoryHit>>;
  readonly dirExists: (dir: string) => boolean;
  /** `baton <args>`; the program's own output (it says which Herdr session and pane it used). */
  readonly baton: (
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly ok: boolean; readonly out: string }>;
  /** Types the text into a Herdr pane and submits it. `refused`: definitely not typed (a question is up, or no pane). */
  readonly type: (pane: string, text: string) => Promise<SendOutcome>;
  /** Machines with no Herdr: brings the session back as a T3 thread resuming that id, sending nothing. */
  readonly thread?: (
    sessionId: string,
    cwd: string,
  ) => Promise<{ readonly threadId: string } | { readonly detail: string }>;
  /** Machines with no Herdr: sends a message into the thread a resume brought back; false if it was not taken. */
  readonly threadSend?: (threadId: string, text: string) => Promise<boolean>;
  /** Machines with no Herdr: a resumed thread is gone once archived or deleted, working while a turn runs. */
  readonly threadState?: (threadId: string) => Promise<"gone" | "idle" | "working">;
  /** Machines with no Herdr: starts a new session in a folder as a T3 thread, with a model, an effort and a first message. */
  readonly launch?: (input: {
    readonly cwd: string;
    readonly model?: string;
    readonly effort?: string;
    readonly message?: string;
  }) => Promise<{ readonly threadId: string } | { readonly detail: string }>;
  /** The last part of a transcript file, for the auto-resume watchdog. */
  readonly readTail?: (file: string) => Promise<string>;
  /** Resumed by the watchdog in the last two hours: shown on the row. */
  readonly autoResumed?: (sessionId: string) => boolean;
  /** Died mid-turn and the watchdog did not bring it back: why not, and when it saw the death; null otherwise. */
  readonly died?: (sessionId: string) => { readonly why: string; readonly at: number } | null;
  /** How long a resume holds the caller before answering "resuming" (machines with no Herdr); tests shorten it. */
  readonly resumeWaitMs?: number;
  /** Where messages kept for a stopped session are stored, so a restart does not lose them. */
  readonly kept?: {
    readonly read: () => Record<string, ReadonlyArray<string>>;
    readonly write: (all: Record<string, ReadonlyArray<string>>) => void;
  };
  /** Whether the session's transcript is still on this machine; kept messages for one that is gone are dropped. */
  readonly hasTranscript?: (sessionId: string) => boolean;
  /** What the Herdr pane shows now (the last lines), to explain a session that never became ready. */
  readonly screen?: (session: string, pane: string) => Promise<string>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** Shown on a session the watchdog brought back, in the list; the thread shows the restart message itself. */
export const IMPORTING = "Importing the conversation's history...";
export const AUTO_RESUMED = "Resumed automatically after a crash";
export const CRASHED = "Died mid-turn and was not resumed";

export const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 500;
const TRUST =
  /Is this a project you created or one you trust|trust this folder|Do you trust the files/i;

/** The sentence for a session that did not become ready: Claude's folder-trust question gets named, because it waits for a person. */
export const notReadyReason = (screen: string, where: string): string =>
  TRUST.test(screen)
    ? `Claude Code is asking whether to trust this folder, and waits for you to choose in Herdr (${where}). Choose, then resume again.`
    : "It was started in Herdr but did not become ready within 45 seconds. Your messages are kept; try Resume again.";

const basename = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

const ready = (s: ClaudeLiveSession | undefined): boolean =>
  s !== undefined && s.herdrPane !== null && s.status !== "busy";

export interface ResumeResult {
  readonly state: BatonCatalogState;
  readonly pane: string | null;
  readonly detail: string | null;
  readonly threadId?: string;
}

export const createSessionCatalog = (ports: CatalogPorts) => {
  /** Resumes in flight and messages waiting on them: kept so nothing is dropped and a second tap changes nothing. */
  const resuming = new Map<string, Promise<ResumeResult>>();
  const waiting = new Map<string, ReadonlyArray<string>>(Object.entries(ports.kept?.read() ?? {}));
  const keep = (sessionId: string, texts: ReadonlyArray<string>) => {
    if (texts.length === 0) waiting.delete(sessionId);
    else waiting.set(sessionId, texts);
    ports.kept?.write(Object.fromEntries(waiting));
  };
  const failed = new Map<string, string>();
  /** Sends in progress per session, so a second caller only appends and the one loop sends it, in order. */
  const flushing = new Set<string>();
  /** Messages the last flush could not confirm, per session: dropped, never sent again, and reported once. */
  const unsure = new Map<string, number>();
  /** Resumes that should send what is kept once up: a user's Resume or send, never the watchdog alone. */
  const deliverOnResume = new Set<string>();
  /** Why the last flush stopped with messages still kept, for the reply to a send that waited on a resume. */
  const stoppedBy = new Map<string, "blocked" | "refused">();
  /**
   * Sends what waits for a session, oldest first, one at a time, until nothing new has arrived. A definite refusal
   * keeps it and everything after it; an unsure send drops that one. Each sent message leaves the kept file at once,
   * so delivery is at-least-once: a crash between typing and that write sends it again after a restart.
   */
  const flush = async (
    sessionId: string,
    put: (text: string) => Promise<SendOutcome>,
  ): Promise<"done" | "blocked" | "refused"> => {
    if (waiting.has(sessionId)) unsure.delete(sessionId);
    flushing.add(sessionId);
    try {
      for (;;) {
        const head = waiting.get(sessionId)?.[0];
        if (head === undefined) return "done";
        const outcome = await put(head);
        if (outcome === "blocked" || outcome === "refused") {
          stoppedBy.set(sessionId, outcome);
          return outcome;
        }
        if (outcome === "unsure") unsure.set(sessionId, (unsure.get(sessionId) ?? 0) + 1);
        keep(sessionId, (waiting.get(sessionId) ?? []).slice(1));
      }
    } finally {
      flushing.delete(sessionId);
    }
  };

  const liveRow = (s: ClaudeLiveSession): BatonCatalogSession => ({
    id: s.sessionId,
    machine: ports.machine,
    project: basename(s.cwd),
    cwd: s.cwd,
    title: s.name ?? basename(s.cwd),
    lastActivityAt: s.updatedAt,
    account: s.account,
    state: "running",
    source: "live",
    canResume: false,
    detail:
      s.herdrPane === null
        ? "It is running in a plain terminal. Bring it into Herdr to send to it from here."
        : ports.autoResumed?.(s.sessionId) === true
          ? AUTO_RESUMED
          : null,
    waiting: waiting.get(s.sessionId)?.length ?? 0,
    pane: s.herdrPane,
  });

  const stoppedRow = (t: TranscriptInfo, working: boolean): BatonCatalogSession => {
    const state: BatonCatalogState = resuming.has(t.sessionId)
      ? "resuming"
      : failed.has(t.sessionId)
        ? "failed"
        : resumedThreads.has(t.sessionId)
          ? "running"
          : "stopped";
    const cwdOk = t.cwd !== null && ports.dirExists(t.cwd);
    const died = state === "stopped" ? (ports.died?.(t.sessionId) ?? null) : null;
    // Run again by hand since the death: no longer crashed.
    const crashed = died === null || Date.parse(t.lastActivityAt ?? "") > died.at ? null : died.why;
    const detail =
      failed.get(t.sessionId) ??
      (state === "resuming"
        ? IMPORTING
        : cwdOk
          ? ports.autoResumed?.(t.sessionId) === true
            ? AUTO_RESUMED
            : null
          : "Its folder is not on this machine, so it cannot be resumed here.");
    return {
      id: t.sessionId,
      machine: ports.machine,
      project: t.cwd === null ? "unknown folder" : basename(t.cwd),
      cwd: t.cwd,
      title: t.title,
      lastActivityAt: t.lastActivityAt,
      account: t.account,
      state,
      source: "transcript",
      canResume: cwdOk,
      detail:
        crashed === null
          ? detail
          : `${CRASHED}: ${crashed.replace(/\.+$/, "")}.${detail === null ? "" : ` ${detail}`}`,
      waiting: waiting.get(t.sessionId)?.length ?? 0,
      ...(crashed === null ? {} : { crashed: true }),
      ...(resumedThreads.has(t.sessionId) ? { threadId: resumedThreads.get(t.sessionId)! } : {}),
      ...(working ? { turnRunning: true } : {}),
    };
  };

  const list = async (input: {
    query?: string;
    limit?: number;
    before?: string;
    background?: boolean;
    history?: boolean;
  }) => {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const liveSessions = await ports.live();
    const transcripts = await ports.transcripts(600);
    if (ports.hasTranscript !== undefined)
      for (const id of waiting.keys())
        if (
          !resuming.has(id) &&
          !liveSessions.some((s) => s.sessionId === id) &&
          !ports.hasTranscript(id)
        )
          keep(id, []);
    const working = new Set<string>();
    if (ports.threadState !== undefined)
      for (const [id, threadId] of resumedThreads) {
        const now = await ports.threadState(threadId).catch(() => "idle" as const);
        if (now === "gone") resumedThreads.delete(id);
        else if (now === "working") working.add(id);
      }
    const byId = new Map<string, BatonCatalogSession>();
    for (const t of transcripts)
      if (t.background !== true || input.background === true)
        byId.set(t.sessionId, stoppedRow(t, working.has(t.sessionId)));
    for (const s of liveSessions)
      byId.set(s.sessionId, {
        ...liveRow(s),
        ...(byId.get(s.sessionId) === undefined ? {} : { title: byId.get(s.sessionId)!.title }),
      });
    const q = (input.query ?? "").trim().toLowerCase();
    // Older sessions live in the history index; it is only searched when words are given.
    const hits = new Set<string>();
    if (q !== "" && input.history !== false) {
      for (const hit of await ports.history(q)) {
        hits.add(hit.sessionId);
        if (byId.has(hit.sessionId)) continue;
        byId.set(hit.sessionId, {
          id: hit.sessionId,
          machine: ports.machine,
          project: hit.project.replace(/^-+/, "").split("-").slice(-2).join("-") || hit.project,
          cwd: null,
          title: "Found in the history index",
          lastActivityAt: hit.at,
          account: null,
          state: "stopped",
          source: "history",
          canResume: false,
          detail:
            "Its transcript is no longer on this machine, so it can be read in the history but not resumed.",
          waiting: 0,
        });
      }
    }
    let rows = [...byId.values()].filter(
      (r) =>
        q === "" ||
        `${r.id} ${r.title} ${r.project} ${r.cwd ?? ""} ${r.account ?? ""}`
          .toLowerCase()
          .includes(q) ||
        hits.has(r.id),
    );
    rows.sort(
      (a, b) => Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? "") || 0,
    );
    if (input.before !== undefined)
      rows = rows.filter((r) => r.lastActivityAt !== null && r.lastActivityAt < input.before!);
    return { machine: ports.machine, sessions: rows.slice(0, limit), more: rows.length > limit };
  };

  const folders = async (input: { query?: string }) => {
    const seen = new Map<string, { cwd: string; project: string; lastActivityAt: string | null }>();
    for (const s of await ports.live())
      seen.set(s.cwd, { cwd: s.cwd, project: basename(s.cwd), lastActivityAt: s.updatedAt });
    for (const t of await ports.transcripts(600)) {
      if (t.cwd === null || seen.has(t.cwd)) continue;
      seen.set(t.cwd, { cwd: t.cwd, project: basename(t.cwd), lastActivityAt: t.lastActivityAt });
    }
    const q = (input.query ?? "").trim().toLowerCase();
    return {
      folders: [...seen.values()]
        .filter((f) => ports.dirExists(f.cwd) && (q === "" || f.cwd.toLowerCase().includes(q)))
        .sort(
          (a, b) => Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? "") || 0,
        )
        .slice(0, 60),
    };
  };

  const whereOf = (out: string): { session: string; pane: string } | null => {
    const m = /running in (\S+) pane (\S+)/.exec(out);
    return m === null ? null : { session: m[1]!, pane: m[2]! };
  };
  const whyNot = async (out: string): Promise<string> => {
    const at = whereOf(out);
    const screen =
      at === null || ports.screen === undefined
        ? ""
        : await ports.screen(at.session, at.pane).catch(() => "");
    return notReadyReason(screen, at === null ? "its pane" : `herdr --session ${at.session}`);
  };

  /** Polls until the session is in a Herdr pane and not mid-turn, or says why not. */
  const untilReady = async (
    sessionId: string,
    timeoutMs: number,
  ): Promise<ClaudeLiveSession | null> => {
    const started = ports.now();
    for (;;) {
      const found = (await ports.live()).find((s) => s.sessionId === sessionId);
      if (found !== undefined && ready(found)) return found;
      if (ports.now() - started >= timeoutMs) return null;
      await ports.sleep(POLL_MS);
    }
  };

  const cwdOf = async (sessionId: string, given?: string): Promise<string | null> =>
    given ?? (await ports.transcripts(600)).find((t) => t.sessionId === sessionId)?.cwd ?? null;

  const doResume = async (sessionId: string, given?: string): Promise<ResumeResult> => {
    const live = (await ports.live()).find((s) => s.sessionId === sessionId);
    if (live !== undefined) {
      return live.herdrPane !== null
        ? { state: "running" as const, pane: live.herdrPane, detail: null }
        : {
            state: "failed" as const,
            pane: null,
            detail:
              "It is running in a plain terminal. Bring it into Herdr to send to it from here.",
          };
    }
    const cwd = await cwdOf(sessionId, given);
    if (cwd === null)
      return {
        state: "failed" as const,
        pane: null,
        detail:
          "I do not know which folder this conversation was in, and its transcript is not on this machine.",
      };
    if (!ports.dirExists(cwd))
      return {
        state: "failed" as const,
        pane: null,
        detail: `The folder ${cwd} is not on this machine.`,
      };
    if (ports.thread !== undefined) {
      const opened = await ports.thread(sessionId, cwd);
      return "threadId" in opened
        ? { state: "running" as const, pane: null, detail: null, threadId: opened.threadId }
        : { state: "failed" as const, pane: null, detail: opened.detail };
    }
    const out = await ports.baton(["--resume", sessionId, cwd]);
    if (!/running in (\S+) pane (\S+)/.test(out.out)) {
      return {
        state: "failed" as const,
        pane: null,
        detail: `Herdr would not start it: ${out.out.replace(/\s+/g, " ").slice(0, 160) || "no answer"}.`,
      };
    }
    const up = await untilReady(sessionId, READY_TIMEOUT_MS);
    return up === null
      ? { state: "failed" as const, pane: null, detail: await whyNot(out.out) }
      : { state: "running" as const, pane: up.herdrPane, detail: null };
  };

  /** Idempotent: a resume already running is the one the caller waits on. */
  /** Threads a resume brought back (machines with no Herdr), so the row can say where it is once it exists. */
  const resumedThreads = new Map<string, string>();
  const RESUME_WAIT_MS = ports.resumeWaitMs ?? 8_000;
  /** `deliver: false` (the watchdog) brings it back and leaves kept messages kept unless a user joins the resume. */
  const resume = (input: {
    sessionId: string;
    cwd?: string;
    deliver?: boolean;
  }): Promise<ResumeResult> => {
    if (input.deliver !== false) deliverOnResume.add(input.sessionId);
    const existing = resuming.get(input.sessionId);
    if (existing !== undefined)
      return Promise.resolve({ state: "resuming" as const, pane: null, detail: IMPORTING });
    const job = (async () => {
      try {
        const r = await doResume(input.sessionId, input.cwd);
        if (r.threadId !== undefined) resumedThreads.set(input.sessionId, r.threadId);
        if (r.state === "failed")
          failed.set(input.sessionId, r.detail ?? "It could not be resumed.");
        else failed.delete(input.sessionId);
        // What waited goes now, in order, once; `resuming` stays set until it has, so a second tap cannot type it twice.
        if (r.state === "running" && r.pane !== null && deliverOnResume.has(input.sessionId)) {
          const pane = r.pane;
          await flush(input.sessionId, (text) => ports.type(pane, text));
        }
        // No Herdr: the session came back as a thread, so what waited goes there. Anything not taken stays kept.
        if (r.state === "running" && r.pane === null && deliverOnResume.has(input.sessionId))
          await flush(input.sessionId, async (text) =>
            r.threadId !== undefined &&
            ports.threadSend !== undefined &&
            (await ports.threadSend(r.threadId, text).catch(() => false))
              ? "sent"
              : "refused",
          );
        return r;
      } finally {
        resuming.delete(input.sessionId);
        deliverOnResume.delete(input.sessionId);
      }
    })();
    resuming.set(input.sessionId, job);
    // Bringing a long conversation in as a thread can take minutes (a 70 MB transcript): answer "resuming" after a few
    // seconds and let the import finish on its own; the list says when it has a thread, or why it failed.
    if (ports.thread === undefined) return job;
    return Promise.race([
      job,
      new Promise<ResumeResult>((resolve) =>
        setTimeout(
          () => resolve({ state: "resuming", pane: null, detail: IMPORTING }),
          RESUME_WAIT_MS,
        ),
      ),
    ]);
  };

  const QUEUED_BEHIND =
    "Earlier messages to it are still being sent; this one goes after them, in order.";
  const afterFlush = (sessionId: string, outcome: "done" | "blocked" | "refused") => {
    const maybe = unsure.get(sessionId) ?? 0;
    unsure.delete(sessionId);
    if (outcome === "blocked")
      return {
        delivered: false,
        detail:
          "It is waiting on a question in its terminal. Your message is kept; answer the question, then send again and it goes first.",
      };
    if (outcome === "refused")
      return {
        delivered: false,
        detail:
          "Its Herdr pane did not take the message, so nothing was typed. Your message is kept and goes first on the next send or Resume.",
      };
    return maybe === 0
      ? { delivered: true, detail: null }
      : {
          delivered: false,
          detail: `Herdr did not answer in time for ${maybe} message${maybe === 1 ? "" : "s"}, so ${maybe === 1 ? "it" : "they"} may already be in the session; not sent again in case.`,
        };
  };

  const send = async (input: { sessionId: string; text: string; cwd?: string }) => {
    const live = (await ports.live()).find((s) => s.sessionId === input.sessionId);
    if (live !== undefined && live.herdrPane !== null) {
      // Anything kept from before goes first, then this one; a send already under way takes it in order.
      keep(input.sessionId, [...(waiting.get(input.sessionId) ?? []), input.text]);
      if (flushing.has(input.sessionId))
        return { state: "running" as const, delivered: false, detail: QUEUED_BEHIND };
      // A resume still settling may fail before sending anything, so wait for it and send from here.
      await resuming.get(input.sessionId)?.catch(() => undefined);
      if (flushing.has(input.sessionId))
        return { state: "running" as const, delivered: false, detail: QUEUED_BEHIND };
      const pane = live.herdrPane;
      const outcome = await flush(input.sessionId, (text) => ports.type(pane, text));
      return { state: "running" as const, ...afterFlush(input.sessionId, outcome) };
    }
    if (live !== undefined)
      return {
        state: "failed" as const,
        delivered: false,
        detail: "It is running in a plain terminal. Bring it into Herdr to send to it from here.",
      };
    // Stopped: keep the message, bring it back, and let the resume deliver it.
    keep(input.sessionId, [...(waiting.get(input.sessionId) ?? []), input.text]);
    const result = await resume({
      sessionId: input.sessionId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
    if (result.state === "running" && result.pane === null) {
      const kept = waiting.has(input.sessionId);
      return {
        state: "running" as const,
        delivered: !kept,
        detail: kept
          ? "It is open as a thread here, but your message did not go in. It is kept; send it in that thread."
          : "Sent in its thread here.",
      };
    }
    if (result.state === "running")
      return {
        state: "running" as const,
        ...afterFlush(
          input.sessionId,
          waiting.has(input.sessionId) ? (stoppedBy.get(input.sessionId) ?? "blocked") : "done",
        ),
      };
    if (result.state === "resuming")
      return {
        state: "resuming" as const,
        delivered: false,
        detail: "It is resuming; your message is kept and goes when it is ready.",
      };
    return {
      state: "failed" as const,
      delivered: false,
      detail: `${result.detail ?? "It could not be resumed."} Your message is kept.`,
    };
  };

  const create = async (input: {
    cwd: string;
    model?: string;
    effort?: string;
    message?: string;
  }) => {
    if (!ports.dirExists(input.cwd))
      return {
        state: "failed" as const,
        sessionId: null,
        pane: null,
        detail: `The folder ${input.cwd} is not on this machine.`,
      };
    if (ports.launch !== undefined) {
      const launched = await ports.launch(input);
      return "threadId" in launched
        ? {
            state: "running" as const,
            sessionId: null,
            pane: null,
            detail: null,
            threadId: launched.threadId,
          }
        : { state: "failed" as const, sessionId: null, pane: null, detail: launched.detail };
    }
    const before = new Set((await ports.live()).map((s) => s.sessionId));
    const out = await ports.baton([input.cwd, "claude"]);
    if (!/running in (\S+) pane (\S+)/.test(out.out)) {
      return {
        state: "failed" as const,
        sessionId: null,
        pane: null,
        detail: `Herdr would not start it: ${out.out.replace(/\s+/g, " ").slice(0, 160) || "no answer"}.`,
      };
    }
    const started = ports.now();
    for (;;) {
      const fresh = (await ports.live()).find(
        (s) => !before.has(s.sessionId) && s.cwd === input.cwd && s.herdrPane !== null,
      );
      if (fresh !== undefined)
        return {
          state: "running" as const,
          sessionId: fresh.sessionId,
          pane: fresh.herdrPane,
          detail: null,
        };
      if (ports.now() - started >= READY_TIMEOUT_MS) {
        return {
          state: "failed" as const,
          sessionId: null,
          pane: null,
          detail: await whyNot(out.out),
        };
      }
      await ports.sleep(POLL_MS);
    }
  };

  /** What a session keeps, and a way to drop one; refused mid-send, since the loop removes its head by position. */
  const waitingFor = (sessionId: string, discard?: { index: number; text: string }) => {
    const sending = flushing.has(sessionId) || resuming.has(sessionId);
    const messages = waiting.get(sessionId) ?? [];
    if (discard !== undefined && !sending && messages[discard.index] === discard.text)
      keep(
        sessionId,
        messages.filter((_, i) => i !== discard.index),
      );
    return { messages: [...(waiting.get(sessionId) ?? [])], sending };
  };

  /** Stop on a session resumed as a thread: its row is stopped again; the thread it was, if any. */
  const forgetResumed = (sessionId: string): string | undefined => {
    const threadId = resumedThreads.get(sessionId);
    resumedThreads.delete(sessionId);
    return threadId;
  };

  return { list, folders, resume, send, create, waitingFor, forgetResumed };
};
export type SessionCatalog = ReturnType<typeof createSessionCatalog>;
