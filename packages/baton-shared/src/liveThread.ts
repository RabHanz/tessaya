/**
 * A thread mirrored from a running terminal session (instance `baton-live`) is answered only by that session.
 * A turn that names another provider instance would start a new session with a summary of the thread, a twin
 * that answers while the real session keeps running. That is refused here; the way back to the live instance is
 * always allowed.
 */
export const LIVE_THREAD_PREFIX = "baton-live";
export const LIVE_INSTANCE = "baton-live";

/** What an error calls a provider instance: the live one by its display name, never its internal id. */
export const instanceLabel = (instanceId: string): string =>
  instanceId === LIVE_INSTANCE ? "Terminal session" : instanceId;

/** The Claude session id of a live thread (any `baton-live<n>:` namespace), or null for any other thread. */
export const liveSessionIdOf = (threadId: string): string | null =>
  /^baton-live\d*:/.test(threadId) ? threadId.replace(/^baton-live\d*:/, "") : null;

/**
 * A live thread's title as shown: the session's name without the " · <account> · <box>" the mirror stores for T3's
 * own lists (liveThreadTitle). Display only; the stored title is left as it is.
 */
export const displayThreadTitle = (threadId: string, title: string): string =>
  isLiveThreadId(threadId) && title.includes(" · ") ? title.split(" · ")[0]! : title;

export const isLiveThreadId = (threadId: string): boolean =>
  threadId.startsWith(LIVE_THREAD_PREFIX);

/** `<environment>:<claude session id>` for a live thread (any `baton-live<n>:` namespace), or null for any other thread. */
export const liveSessionKey = (environmentId: string, threadId: string): string | null => {
  const match = /^baton-live\d*:(.+)$/.exec(threadId);
  return match === null ? null : `${environmentId}:${match[1]}`;
};

/**
 * The live sessions running now, keyed like liveSessionKey. A live thread whose session ended or was handed on keeps its
 * id, so "Live" is read from what each computer reports running, never from the id alone.
 */
export const runningLiveSessionKeys = (
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
  }>,
): ReadonlySet<string> =>
  new Set(environments.flatMap((e) => e.sessions.map((s) => `${e.environmentId}:${s.sessionId}`)));

/**
 * The reason a turn on this thread may not run: a live thread answers only on the live instance, so a turn that names
 * another one is refused whether the thread is still on the live instance or was already moved off it (a handoff
 * session is never started or woken again; Retire handoff session puts the thread back).
 */
export const liveThreadSwitchRefusal = (input: {
  readonly threadId: string;
  readonly currentInstance: string;
  readonly targetInstance: string;
}): string | null =>
  isLiveThreadId(input.threadId) && input.targetInstance !== LIVE_INSTANCE
    ? input.currentInstance === LIVE_INSTANCE
      ? "This thread belongs to a running terminal session and is answered only by it. Tessaya will not start a new session with a summary here. Continue in a new thread if you want that."
      : "This thread is answered by a handoff session, which Tessaya will not wake. Retire the handoff session, or switch the thread back to its live session."
    : null;

/**
 * What a model pick does on a live thread. Still on its session: a Claude model on the session's own login changes
 * its model (/model); a Claude login the machine knows moves the session there while it runs (LIVE-ACCOUNT); the
 * Terminal session entry keeps it; anything else continues in a new thread. Handed off, the thread is ordinary, except
 * that the Terminal session entry takes it back.
 */
export const livePick = (input: {
  readonly pickedInstance: string;
  readonly pickedDriver: string | null;
  readonly currentInstance: string;
  /** How the picked instance's login relates to the session's: the same, another known slot, or not known. */
  readonly account: "same" | "other" | "unknown";
}): "session-model" | "session-account" | "unchanged" | "switch-back" | "continue-in" | "normal" =>
  input.currentInstance !== LIVE_INSTANCE
    ? input.pickedInstance === LIVE_INSTANCE
      ? "switch-back"
      : "normal"
    : input.pickedInstance === LIVE_INSTANCE
      ? "unchanged"
      : input.pickedDriver !== "claudeAgent" || input.account === "unknown"
        ? "continue-in"
        : input.account === "same"
          ? "session-model"
          : "session-account";

/** The header line for a reply the session says a safety classifier stopped; null for any other text. */
export const classifierStopReason = (lastReply: string | null): string | null =>
  lastReply !== null && /stopped by a safety classifier/i.test(lastReply)
    ? "Stopped by a safety classifier: rephrase or switch model for this session"
    : null;

/**
 * A turn on a live thread still on its session goes to that session, whatever the composer remembered: another model
 * would restart it as a "live -> live" handoff, and another instance is a stale picker, never a handoff the user chose
 * (that is `provider.switch`, still refused). Model changes go into the session itself.
 */
export const pinnedLiveSelection = <S extends { readonly instanceId: string }>(
  threadId: string,
  requested: S,
  current: S,
): S => (isLiveThreadId(threadId) && current.instanceId === LIVE_INSTANCE ? current : requested);

/**
 * The banner for a live thread whose session is not running: `null` while it runs or its state is unknown, "missing"
 * when the catalog does not list it at all. Resume brings the same session id back; the thread follows it.
 */
export const bindingBanner = (
  row: { readonly state: string; readonly source: string } | "missing" | null,
): { readonly text: string; readonly actions: ReadonlyArray<"resume"> } | null => {
  if (row === null) return null;
  if (row !== "missing" && row.state === "running" && row.source === "live") return null;
  if (row !== "missing" && row.state === "resuming") return null;
  return { text: "Not connected to its session.", actions: ["resume"] };
};

/**
 * What a live thread is really bound to, from the catalog row of its session id: its Herdr pane, a handoff session
 * T3 hosts (another provider answers), a plain terminal, or nothing running. Reattach is offered unless it is the pane.
 */
export const bindingOf = (
  row:
    | {
        readonly state: string;
        readonly source: string;
        readonly pane?: string | null | undefined;
        readonly answeredBy?: string | null | undefined;
      }
    | "missing"
    | null,
): { readonly kind: "pane" | "terminal" | "handoff" | "stopped"; readonly text: string } | null => {
  if (row === null) return null;
  if (row === "missing" || row.state !== "running" || row.source !== "live")
    return row !== "missing" && row.state === "resuming"
      ? null
      : { kind: "stopped", text: "Stopped" };
  if (row.answeredBy !== undefined && row.answeredBy !== null && row.answeredBy !== LIVE_INSTANCE)
    return { kind: "handoff", text: "T3-hosted handoff session" };
  return row.pane
    ? { kind: "pane", text: `Herdr pane ${row.pane}` }
    : { kind: "terminal", text: "Plain terminal (no Herdr pane)" };
};
