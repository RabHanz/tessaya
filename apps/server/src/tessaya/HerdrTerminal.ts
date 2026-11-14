/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton (D61): a T3 terminal can be a client of a named Herdr session instead of owning its
 * shell, so the shell and everything under it outlive a T3 restart, a deploy or an OOM. The PTY
 * T3 holds is only `herdr --session <name>`; reopening the terminal re-attaches.
 *
 * Two hooks in upstream's `terminal/Manager.ts` call this (0003-herdr-terminal.patch). It is not a
 * `PtyAdapter`: v2's adapter is handed a shell and an environment but not which thread and
 * terminal it serves, and the session name has to be stable per terminal to re-attach (D81).
 *
 * shortcut: chosen by an environment variable rather than a setting, because it is a per-machine
 * fact (is Herdr installed here); upgrade to a settings toggle when a client exposes it.
 */

// Legacy name (D71): set by fabric-terminal-herdr.conf on the boxes, so it keeps "FABRIC".
export const BATON_TERMINAL_RUNTIME_ENV = "T3CODE_FABRIC_TERMINAL_RUNTIME";

/** Herdr session names are directory names; keep them short and portable. */
export function herdrTerminalSessionName(threadId: string, terminalId: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `t3-${clean(threadId).slice(0, 40)}-${clean(terminalId).slice(0, 20)}`;
}

/**
 * The spawn candidates for a terminal. With Herdr on, Herdr first and the ordinary shells after
 * it, so a machine without the binary still gets a terminal rather than an error.
 */
/** The shape of upstream's `ShellCandidate` in `terminal/Manager.ts`. */
export interface HerdrShellCandidate {
  shell: string;
  args?: string[];
}

export function terminalShellCandidates<C extends HerdrShellCandidate>(input: {
  readonly runtime: string | undefined;
  readonly threadId: string;
  readonly terminalId: string;
  readonly shells: ReadonlyArray<C>;
}): Array<C | HerdrShellCandidate> {
  if (input.runtime !== "herdr") return [...input.shells];
  return [
    {
      shell: "herdr",
      args: ["--session", herdrTerminalSessionName(input.threadId, input.terminalId)],
    },
    ...input.shells,
  ];
}

/**
 * The commands that end a terminal's Herdr session when the user closes the terminal (not on a
 * restart, which is the whole point). Empty when Herdr is off.
 */
export function herdrTerminalCloseCommands(input: {
  readonly runtime: string | undefined;
  readonly threadId: string;
  readonly terminalId: string;
}): Array<{ command: string; args: Array<string>; timeout: "10 seconds" }> {
  if (input.runtime !== "herdr") return [];
  const name = herdrTerminalSessionName(input.threadId, input.terminalId);
  return ["stop", "delete"].map((verb) => ({
    command: "herdr",
    args: ["session", verb, name],
    timeout: "10 seconds" as const,
  }));
}
