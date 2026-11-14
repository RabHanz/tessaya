/**
 * Which Claude login the assistant runs as (D132). Every login lives in a config directory: the
 * default one, a `~/.claude-*` home, or a claude-swap session. Choosing an account means pointing
 * `CLAUDE_CONFIG_DIR` at its directory for the assistant's own `claude` children. Choosing nothing
 * leaves his environment alone. Pure, so the choice is testable without a `claude`.
 */
import { cswapSessionsRoot } from "@t3tools/tessaya-shared/providerAccounts";

export interface AssistantAccount {
  /** The config directory: what the choice is saved as. */
  readonly key: string;
  readonly email: string | null;
  readonly loggedIn: boolean;
}

export const parseAuthStatus = (
  stdout: string,
): { readonly loggedIn: boolean; readonly email: string | null } | null => {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { loggedIn, email } = parsed as { loggedIn?: unknown; email?: unknown };
    return { loggedIn: loggedIn === true, email: typeof email === "string" ? email : null };
  } catch {
    return null;
  }
};

/** Where logins can be: the default, `~/.claude-*`, and every claude-swap session directory. */
export const candidateDirs = (input: {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly list: (dir: string) => ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const sep = input.home.includes("\\") ? "\\" : "/";
  const join = (dir: string, name: string) => `${dir}${sep}${name}`;
  const dirs = [
    input.env["CLAUDE_CONFIG_DIR"] ?? join(input.home, ".claude"),
    ...input
      .list(input.home)
      .filter((name) => name.startsWith(".claude-"))
      .map((name) => join(input.home, name)),
  ];
  const sessions = cswapSessionsRoot({ home: input.home, xdgDataHome: input.env["XDG_DATA_HOME"] });
  dirs.push(...input.list(sessions).map((name) => join(sessions, name)));
  return [...new Set(dirs)];
};

/** `alex@example.com` as `a•••@example.com`, until he clicks. */
export const maskEmail = (email: string): string => {
  const at = email.indexOf("@");
  return at < 1 ? "•••" : `${email[0]}•••${email.slice(at)}`;
};

export const accountLabel = (account: AssistantAccount): string =>
  account.email === null ? account.key : account.email.split("@")[0]!;

export interface PickedEnv {
  readonly env: NodeJS.ProcessEnv;
  /** Plain words for him, when his choice could not be used. */
  readonly notice: string | null;
}

/**
 * The environment for the assistant's `claude`. A choice that is gone, or whose login has expired,
 * falls back to his own login with a plain message; it never stops the assistant working.
 * `accounts` is null before the first look, and then the choice is trusted.
 */
export const pickEnv = (
  choice: string | null,
  accounts: ReadonlyArray<AssistantAccount> | null,
  base: NodeJS.ProcessEnv,
): PickedEnv => {
  if (choice === null) return { env: base, notice: null };
  const account = accounts?.find((a) => a.key === choice);
  if (accounts !== null && account === undefined) {
    return {
      env: base,
      notice: "The account you chose is gone. Tessaya is using the claude login.",
    };
  }
  if (account !== undefined && !account.loggedIn) {
    return {
      env: base,
      notice: `${accountLabel(account)} has signed out. Tessaya is using the claude login. Sign in again with claude auth login.`,
    };
  }
  // A token in his environment would override the directory's own login.
  const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = base;
  return { env: { ...rest, CLAUDE_CONFIG_DIR: choice }, notice: null };
};
