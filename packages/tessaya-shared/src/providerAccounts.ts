/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Adding a second provider account, as a plan somebody can read before it runs.
 *
 * The Director's requirement, in his words: _"any new profile I add picks up
 * the same config"_. A new account is a place to keep **one login** and nothing
 * else — the skills, agents, commands, plugins, memory tree and instructions
 * stay the primary's, shared.
 *
 * This module decides *where* and *what to say*; it touches no filesystem, so
 * the interesting half — which directory, which command, and whether an
 * existing profile is being reused rather than duplicated — is testable without
 * one.
 *
 * Two provider shapes, both already understood by T3:
 *
 *   - **Claude** keys off `CLAUDE_CONFIG_DIR`, and the layout is materialised by
 *     `ClaudeAccountHome.ts` (D52).
 *   - **Codex** keys off `CODEX_HOME` with a *shadow home*, which upstream
 *     already implements: `auth.json` private, everything else linked from the
 *     shared home. Baton does not reinvent it; it names the same directory and
 *     lets the Codex driver materialise it.
 *
 * @module batonProviderAccounts
 */

export type ProviderAccountDriver = "claudeAgent" | "codex";

/** An account claude-swap already manages on this machine. */
export interface CswapSession {
  /** The number `cswap list` shows. */
  readonly index: number;
  readonly email: string;
  /** Absolute path of the session directory. */
  readonly path: string;
}

export interface ProviderAccountPlan {
  readonly driver: ProviderAccountDriver;
  /** What the instance will be called in the picker. */
  readonly label: string;
  /** The id the provider instance gets in settings. */
  readonly instanceId: string;
  /** The directory that holds only this account's credentials. */
  readonly accountHomePath: string;
  /** The primary directory everything else is shared from. */
  readonly sharedHomePath: string;
  /** The one command the user runs, with the environment it needs. */
  readonly loginCommand: string;
  /**
   * True when an existing claude-swap session is being adopted rather than a
   * new directory created. Adopting is always preferred: the account is already
   * logged in there, and a second directory for the same login is how somebody
   * ends up wondering which one the rate limit belongs to.
   */
  readonly reusedExistingProfile: boolean;
  /** Anything the person should know before running it. */
  readonly notes: ReadonlyArray<string>;
}

/** Lower case, letters digits and dashes, collapsed. Stable for a directory name. */
export const accountSlug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/@.*$/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40) || "account";

/**
 * Where claude-swap keeps its session directories.
 *
 * `$XDG_DATA_HOME/claude-swap/sessions`, falling back to `~/.local/share`, which
 * is the same rule cswap itself follows.
 */
export const cswapSessionsRoot = (input: {
  readonly home: string;
  readonly xdgDataHome?: string | undefined;
}): string => {
  const base =
    input.xdgDataHome !== undefined && input.xdgDataHome.trim().length > 0
      ? input.xdgDataHome.trim()
      : `${input.home}/.local/share`;
  return `${base}/claude-swap/sessions`;
};

/**
 * Is this the account the user means?
 *
 * By the email's own slug — "alex@example.com" and "alex" are the same
 * account to a person, and a second directory for one login is how somebody
 * ends up wondering which one a rate limit belongs to. The directory name is
 * checked too, because that is what `cswap list` shows next to the number.
 */
const matchesLabel = (session: CswapSession, label: string): boolean => {
  const slug = accountSlug(label);
  const emailSlug = accountSlug(session.email);
  return emailSlug === slug || emailSlug.startsWith(slug) || session.path.includes(slug);
};

/**
 * Decide what adding this account means, without doing any of it.
 */
export function planProviderAccount(input: {
  readonly driver: ProviderAccountDriver;
  /** What the user called it: an email, or a nickname. */
  readonly label: string;
  readonly home: string;
  /** Sessions claude-swap already manages, when it is installed. */
  readonly cswapSessions?: ReadonlyArray<CswapSession> | undefined;
  /** Overrides the primary directory; empty means the CLI's own default. */
  readonly sharedHomePath?: string | undefined;
}): ProviderAccountPlan {
  const slug = accountSlug(input.label);
  const notes: string[] = [];

  if (input.driver === "codex") {
    const sharedHomePath = input.sharedHomePath?.trim() || `${input.home}/.codex`;
    const accountHomePath = `${input.home}/.codex-t3/${slug}`;
    return {
      driver: "codex",
      label: input.label,
      instanceId: `codex-${slug}`,
      accountHomePath,
      sharedHomePath,
      loginCommand: `CODEX_HOME=${accountHomePath} codex login`,
      reusedExistingProfile: false,
      notes: [
        "Codex's own shadow home does the sharing: auth.json stays in this directory and every other entry is linked from the shared home. T3 materialises it when the instance next starts.",
        `Set the instance's "Shadow home path" to ${accountHomePath} and leave CODEX_HOME pointing at ${sharedHomePath}.`,
      ],
    };
  }

  const sharedHomePath = input.sharedHomePath?.trim() || `${input.home}/.claude`;
  const existing = (input.cswapSessions ?? []).find((session) =>
    matchesLabel(session, input.label),
  );

  if (existing !== undefined) {
    notes.push(
      `claude-swap already manages this account (${existing.email}), so its directory is reused rather than a second one created for the same login.`,
      "Tessaya adds the links claude-swap does not: settings.json, skills/ and the projects/ memory tree, so this account sees the same configuration as the primary.",
    );
    return {
      driver: "claudeAgent",
      label: input.label,
      instanceId: `claude-${slug}`,
      accountHomePath: existing.path,
      sharedHomePath,
      loginCommand: `CLAUDE_CONFIG_DIR=${existing.path} claude auth status`,
      reusedExistingProfile: true,
      notes,
    };
  }

  const accountHomePath = `${input.home}/.claude-accounts/${slug}`;
  notes.push(
    "Everything except the credentials is a link to the primary configuration, so a skill added once is available to every account.",
    "Run the command below in a terminal you can see: signing in opens a browser.",
  );
  return {
    driver: "claudeAgent",
    label: input.label,
    instanceId: `claude-${slug}`,
    accountHomePath,
    sharedHomePath,
    loginCommand: `CLAUDE_CONFIG_DIR=${accountHomePath} claude auth login`,
    reusedExistingProfile: false,
    notes,
  };
}
