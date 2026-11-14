/** The provider instance live threads run on: the ACP bridge to a Claude Code session already running in a terminal. */
export const BATON_LIVE_INSTANCE = "baton-live";

/** That session holds its own context, so a turn there never carries or injects a T3 context handoff. */
export const takesNoContextHandoff = (providerInstanceId: string): boolean =>
  providerInstanceId === BATON_LIVE_INSTANCE;

/**
 * Why messages cannot reach terminal sessions on this computer, in words for him; null when they can. Typing into a
 * session goes through Herdr (none on Windows) and the agent script, run by a Node (the desktop's own Electron).
 */
export const liveSendingUnavailable = (input: {
  readonly platform: string;
  readonly herdr: boolean;
  readonly script: boolean;
  readonly node: boolean;
}): string | null =>
  input.platform === "win32"
    ? "Herdr, which carries messages into terminal sessions, does not run on Windows"
    : !input.herdr
      ? "Herdr, which carries messages into terminal sessions, is not installed here"
      : !input.script
        ? "the terminal-session agent is not installed with this server"
        : !input.node
          ? "there is no Node.js here to run the terminal-session agent"
          : null;

/** What a turn on a terminal session says when sending is not available here. */
export const liveSendingRefusal = (reason: string | null): string =>
  `Sending isn't available for terminal sessions on this computer yet: ${reason ?? "the terminal-session agent is not set up"}.`;

let unavailable: string | null = null;
/** Set by the live-thread mirror when it sets the instance up; read where a turn there is refused. */
export const noteLiveSendingUnavailable = (reason: string | null): void => {
  unavailable = reason;
};
export const liveSendingUnavailableReason = (): string | null => unavailable;
