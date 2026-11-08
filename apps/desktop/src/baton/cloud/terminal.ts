/**
 * Opens a sign-in command in a terminal window the person can see and type into. The command is one of
 * a fixed few the app supplies (never text from a task or a page), and each system opens its own kind of
 * terminal. Returns what to start, so the choice is testable without opening anything.
 */
export const SIGN_IN_COMMANDS: ReadonlySet<string> = new Set(["claude auth login", "codex login"]);

export interface TerminalPlan {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

export const terminalPlan = (platform: string, command: string): TerminalPlan | null => {
  if (!SIGN_IN_COMMANDS.has(command)) return null;
  switch (platform) {
    case "win32":
      // start opens a new window; cmd /k keeps it open after the command ends so the result can be read.
      return { file: "cmd.exe", args: ["/d", "/c", "start", "", "cmd.exe", "/d", "/k", command] };
    case "darwin":
      return {
        file: "osascript",
        args: [
          "-e",
          `tell application "Terminal" to do script "${command}"`,
          "-e",
          'tell application "Terminal" to activate',
        ],
      };
    default:
      return {
        file: "x-terminal-emulator",
        args: ["-e", "sh", "-c", `${command}; echo; echo Press Enter to close; read _`],
      };
  }
};
