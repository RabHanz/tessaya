/**
 * The main session: the one thread (Settings `mainThreadId`) kept pinned wherever its session runs, and kept when that
 * session is restarted under a new id in the same Herdr pane.
 */

/**
 * What to do about the pin this tick. A thread just made main is pinned once; after that the pin is his. Unpinning it
 * means it is no longer the main one, so the mark is cleared rather than the pin put back.
 */
export const decideMainPin = (input: {
  readonly main: string | null;
  /** The main thread the last tick saw; at start, the one in the settings (so a restart pins nothing). */
  readonly seenMain: string | null;
  readonly pinned: boolean;
  readonly wasPinned: boolean;
}): "pin" | "clear" | "none" => {
  if (input.main === null) return "none";
  if (input.main !== input.seenMain) return input.pinned ? "none" : "pin";
  return input.wasPinned && !input.pinned ? "clear" : "none";
};

/**
 * A new session carries the main thread on: the main thread's own session is no longer running, and this one runs in
 * the Herdr pane that session last ran in. A session elsewhere is never guessed to be the main one.
 */
export const carriesMain = (input: {
  /** The session the main thread is on now, or null. */
  readonly mainSessionId: string | null;
  /** The Herdr pane that session was last seen in. */
  readonly mainPane: string | null;
  readonly liveSessionIds: ReadonlySet<string>;
  readonly session: { readonly sessionId: string; readonly herdrPane: string | null };
}): boolean =>
  input.mainSessionId !== null &&
  input.mainSessionId !== input.session.sessionId &&
  !input.liveSessionIds.has(input.mainSessionId) &&
  input.mainPane !== null &&
  input.session.herdrPane === input.mainPane;
