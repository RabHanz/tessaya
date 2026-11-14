/**
 * The first-run choice of what Baton works through (D133): which of Claude Code and Codex are
 * installed and signed in, and the rows to show. API key and local model are listed as coming
 * soon, never as controls. Pure; `brainDetect.ts` does the asking.
 */
export type ToolState = "ready" | "signed-out" | "missing";

export interface ToolStatus {
  readonly state: ToolState;
  /** Codex only: signed in with an API key bills that key, with ChatGPT it uses the plan. */
  readonly apiKey?: boolean;
  readonly email?: string | null;
}

export interface BrainStatus {
  readonly claude: ToolStatus;
  readonly codex: ToolStatus;
}

export interface BrainRow {
  readonly value: string;
  readonly label: string;
  /** Whose subscription or billing it uses, or what is wrong. */
  readonly note: string;
  readonly state: "ready" | "unavailable" | "soon";
}

/** `claude auth status` prints JSON, sometimes after a banner. */
export const parseClaudeStatus = (stdout: string): ToolStatus => {
  try {
    const parsed = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{")))) as {
      loggedIn?: unknown;
      email?: unknown;
    };
    return parsed.loggedIn === true
      ? { state: "ready", email: typeof parsed.email === "string" ? parsed.email : null }
      : { state: "signed-out" };
  } catch {
    return { state: "signed-out" };
  }
};

export const parseCodexStatus = (stdout: string, code: number | null): ToolStatus =>
  code === 0 && /logged in/i.test(stdout)
    ? { state: "ready", apiKey: /api key/i.test(stdout) }
    : { state: "signed-out" };

export const brainRows = (status: BrainStatus): ReadonlyArray<BrainRow> => {
  const { claude, codex } = status;
  const claudeNote =
    claude.state === "ready"
      ? "Uses your Claude subscription. Tessaya never bills an API key."
      : claude.state === "signed-out"
        ? "Not signed in. Run claude auth login in a terminal, then choose Check again."
        : "Not installed. Install Claude Code, then choose Check again.";
  // The one assistant runs only on Claude Code (INT-12): say so instead of degrading silently.
  const assistantNote =
    claude.state === "ready"
      ? ""
      : " The assistant you talk to needs a Claude login; without one it follows simple word rules.";
  const codexNote =
    codex.state === "ready"
      ? `${codex.apiKey === true ? "Signed in with an API key, so each use is billed to that key." : "Uses your ChatGPT plan."}${assistantNote}`
      : codex.state === "signed-out"
        ? "Not signed in. Run codex login in a terminal, then choose Check again."
        : "Not installed. Install Codex, then choose Check again.";
  return [
    {
      value: "claude",
      label: "Claude Code",
      note: claudeNote,
      state: claude.state === "ready" ? "ready" : "unavailable",
    },
    {
      value: "codex",
      label: "Codex",
      note: codexNote,
      state: codex.state === "ready" ? "ready" : "unavailable",
    },
    {
      value: "api-key",
      label: "API key",
      note: "You would pay per use with your own key.",
      state: "soon",
    },
    {
      value: "local",
      label: "Local model",
      note: "It would run on this computer, with no account.",
      state: "soon",
    },
  ];
};

/** Only a ready tool can be chosen; a saved choice that stopped being ready is still honoured. */
export const canChoose = (status: BrainStatus, value: string): value is "claude" | "codex" =>
  (value === "claude" || value === "codex") && status[value].state === "ready";
