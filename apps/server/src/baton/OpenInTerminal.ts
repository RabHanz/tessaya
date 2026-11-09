/**
 * Open in terminal: a Tessaya (claudeAgent) thread's session resumed in a Herdr pane on the thread's own login. The
 * server lets go of the session first (its SDK process is detached and must be gone), so two processes never write
 * one conversation. The mirror then sees the session running and keeps the thread on it (SessionHomes).
 */
import * as Effect from "effect/Effect";

export interface OpenPorts {
  readonly shell: (threadId: string) => Effect.Effect<{ readonly running: boolean } | null>;
  /** The thread's Claude session and where it runs, or null when it has none (not Claude, or no turn yet). */
  readonly home: (threadId: string) => Effect.Effect<{
    readonly sessionId: string;
    readonly cwd: string;
    readonly configDir: string;
  } | null>;
  readonly detach: (threadId: string) => Effect.Effect<void, unknown>;
  /** True once no process holds the session. */
  readonly released: (sessionId: string) => Effect.Effect<boolean>;
  readonly launch: (home: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly configDir: string;
  }) => Effect.Effect<{ readonly pane: string | null; readonly detail: string }>;
}

export interface OpenResult {
  readonly state: "opened" | "refused" | "busy";
  readonly pane: string | null;
  readonly detail: string;
}

export const openInTerminal = Effect.fn("OpenInTerminal.open")(function* (
  ports: OpenPorts,
  input: { readonly threadId: string },
) {
  const shell = yield* ports.shell(input.threadId);
  if (shell === null)
    return { state: "refused", pane: null, detail: "No such thread." } satisfies OpenResult;
  if (shell.running)
    return {
      state: "busy",
      pane: null,
      detail: "A turn is running. Open it in a terminal when it ends.",
    } satisfies OpenResult;
  const home = yield* ports.home(input.threadId);
  if (home === null)
    return {
      state: "refused",
      pane: null,
      detail: "Only a Claude thread that has started its session can open in a terminal.",
    } satisfies OpenResult;
  yield* ports.detach(input.threadId);
  if (!(yield* ports.released(home.sessionId)))
    return {
      state: "refused",
      pane: null,
      detail: "Tessaya is still holding the session. Try again in a moment.",
    } satisfies OpenResult;
  const launched = yield* ports.launch(home);
  return {
    state: launched.pane === null ? "refused" : "opened",
    ...launched,
  } satisfies OpenResult;
});
