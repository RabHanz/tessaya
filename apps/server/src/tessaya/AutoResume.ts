/**
 * The auto-resume watchdog's rules, pure: what the end of a transcript says about the last turn, and when a session
 * whose process died may be resumed by itself. A session that finished, that he stopped on purpose, or that is a
 * background run stays stopped; a turn that was cut off is picked up again, at most three times an hour.
 */
export const RESTART_NOTICE =
  "You were restarted after your process stopped; continue where you left off.";

export type TailVerdict = "unfinished" | "finished" | "unknown";

const INTERRUPTED = /\[Request interrupted by user/;
const LEFT_ON_PURPOSE = /<command-name>\s*\/(exit|quit)\b/;

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
};

/**
 * `unfinished`: the last conversation entry leaves something owed (a message nobody answered, a tool call or result
 * nobody followed up, an assistant cut off mid-turn). `finished`: a clean end of turn, or he interrupted or left.
 * `unknown`: nothing readable, or a format that does not say (never guessed at).
 */
export const classifyTranscriptTail = (tail: string): TailVerdict => {
  const lines = tail.split("\n").filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry: { type?: unknown; message?: { content?: unknown; stop_reason?: unknown } };
    try {
      entry = JSON.parse(lines[i]!) as typeof entry;
    } catch {
      continue; // the first line of a tail slice can be cut off
    }
    if (entry.type === "user") {
      const text = textOfContent(entry.message?.content);
      if (INTERRUPTED.test(text) || LEFT_ON_PURPOSE.test(text)) return "finished";
      return "unfinished";
    }
    if (entry.type === "assistant") {
      const content = entry.message?.content;
      if (
        Array.isArray(content) &&
        content.some((p) => (p as { type?: unknown }).type === "tool_use")
      )
        return "unfinished";
      const stop = entry.message?.stop_reason;
      if (stop === undefined) return "unknown";
      return stop === "end_turn" || stop === "stop_sequence" ? "finished" : "unfinished";
    }
  }
  return "unknown";
};

export interface AutoResumeState {
  /** Sessions he stopped on purpose (by Stop or by an order): the watchdog leaves them stopped. */
  readonly stopped: ReadonlyArray<string>;
  /** When each session was last resumed by the watchdog, newest last, for the hourly cap. */
  readonly resumes: Readonly<Record<string, ReadonlyArray<number>>>;
  /** When each session was last seen running: only sessions that were live are ever resumed by themselves. */
  readonly seenLive: Readonly<Record<string, number>>;
  /** The Auto-resume switch as the user set it; absent means the default for this machine. */
  readonly enabled?: boolean;
}

export const emptyAutoResumeState: AutoResumeState = { stopped: [], resumes: {}, seenLive: {} };

export const noteLive = (
  state: AutoResumeState,
  ids: ReadonlyArray<string>,
  now: number,
): AutoResumeState => ({
  ...state,
  seenLive: {
    ...Object.fromEntries(
      Object.entries(state.seenLive).filter(([, at]) => now - at < 24 * HOUR_MS),
    ),
    ...Object.fromEntries(ids.map((id) => [id, now])),
  },
});

/** A kill from outside looks like a crash, so a fresh stop waits this long: time to mark a deliberate one first. */
export const DEFAULT_GRACE_MS = 120_000;
/** How long after it was last seen live a session still counts as one that was running. */
export const LIVE_MEMORY_MS = 6 * 3_600_000;
/** At most this many sessions are brought back in one pass, so a box is never flooded. */
export const MAX_AT_ONCE = 2;

export const HOUR_MS = 3_600_000;
export const MAX_PER_HOUR = 3;

export const markStoppedOnPurpose = (state: AutoResumeState, sessionId: string): AutoResumeState =>
  state.stopped.includes(sessionId) ? state : { ...state, stopped: [...state.stopped, sessionId] };

export const recordAutoResume = (
  state: AutoResumeState,
  sessionId: string,
  now: number,
): AutoResumeState => ({
  ...state,
  resumes: {
    ...state.resumes,
    [sessionId]: [...(state.resumes[sessionId] ?? []).filter((t) => now - t < HOUR_MS), now],
  },
});

export const autoResumedWithin = (
  state: AutoResumeState,
  sessionId: string,
  now: number,
  ms: number,
): boolean => (state.resumes[sessionId] ?? []).some((t) => now - t < ms);

/** One already reported that has run since (resumed by hand) and stopped again: a new death to report. */
export const diedAgain = (
  was: { readonly at: number } | undefined,
  lastActivityAt: string,
): boolean => was !== undefined && Date.parse(lastActivityAt) > was.at;

export const autoResumeAllowed = (input: {
  readonly sessionId: string;
  readonly verdict: TailVerdict;
  readonly background: boolean;
  /** The switch: off by default on a person's own computer, on for a server. */
  readonly enabled: boolean;
  /** Its process is alive (or a resume is already under way). */
  readonly running: boolean;
  readonly state: AutoResumeState;
  readonly now: number;
  /** How long ago its transcript was last written; a very fresh stop is still inside the grace. */
  readonly idleMs?: number;
  readonly graceMs?: number;
}): { readonly resume: boolean; readonly why: string; readonly capped?: true } => {
  if (!input.enabled) return { resume: false, why: "auto-resume is off here" };
  if (input.verdict !== "unfinished")
    return { resume: false, why: "its last turn finished or cannot be read" };
  if (input.background) return { resume: false, why: "a background run" };
  if (input.running) return { resume: false, why: "it is running" };
  if (input.state.stopped.includes(input.sessionId))
    return { resume: false, why: "he stopped it on purpose" };
  const seen = input.state.seenLive[input.sessionId];
  if (seen === undefined || input.now - seen > LIVE_MEMORY_MS)
    return { resume: false, why: "it was not a live session, only listed" };
  if ((input.idleMs ?? Number.POSITIVE_INFINITY) < (input.graceMs ?? DEFAULT_GRACE_MS))
    return { resume: false, why: "it just stopped: a deliberate stop can still be marked" };
  const recent = (input.state.resumes[input.sessionId] ?? []).filter(
    (t) => input.now - t < HOUR_MS,
  ).length;
  if (recent >= MAX_PER_HOUR)
    return { resume: false, why: "already resumed three times this hour", capped: true };
  return { resume: true, why: "its last turn was cut off" };
};
