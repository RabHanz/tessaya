/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
/**
 * Choosing the model and reasoning effort of a Claude Code session that is already running in a
 * terminal. The session is told with its own slash commands, typed into its Herdr pane, and the
 * answer is read back from the transcript: Claude Code records each command's output as a user
 * line, `<local-command-stdout>Set model to …</local-command-stdout>`. Nothing is assumed done
 * until that line is there.
 */

export const LIVE_EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max"] as const;
export type LiveEffort = (typeof LIVE_EFFORT_CHOICES)[number];

/** The only models typed into a pane: a known id, or an alias made of safe characters. */
export const modelCommand = (model: string): string | null =>
  /^[a-z][a-z0-9.-]{1,59}$/.test(model) ? `/model ${model}` : null;

export const effortCommand = (effort: string): string | null =>
  (LIVE_EFFORT_CHOICES as ReadonlyArray<string>).includes(effort) ? `/effort ${effort}` : null;

const STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g;

/**
 * What the session answered to a command, from transcript text written after the command was sent:
 * the newest command output that is about the model or the effort, or null while there is none.
 */
export const readBack = (written: string, kind: "model" | "effort"): string | null => {
  const outputs = [...written.matchAll(STDOUT)].map((m) => m[1]!.trim());
  const about = kind === "model" ? /\bmodel\b/i : /\beffort\b/i;
  return outputs.reverse().find((text) => about.test(text)) ?? null;
};

export type LiveModelState =
  | "applied"
  | "not_confirmed"
  | "not_in_herdr"
  | "busy"
  | "not_running"
  | "refused";

export interface LiveModelResult {
  readonly state: LiveModelState;
  readonly detail: string;
  /** What the session said back, as it said it. */
  readonly confirmed: ReadonlyArray<string>;
}

export interface LiveModelDeps {
  readonly session: {
    readonly herdrPane: string | null;
    readonly status: string | null;
  } | null;
  /** Types a line into the pane and presses return. */
  readonly send: (pane: string, text: string) => Promise<boolean>;
  /** The transcript's size now, and what was written after a size. */
  readonly mark: () => number | null;
  readonly since: (mark: number) => string;
  readonly wait: (ms: number) => Promise<void>;
  /** The Claude provider's model slugs: a live session is Claude Code, so nothing else is typed into it. */
  readonly claudeModels: ReadonlyArray<string>;
}

const CLAUDE_ALIASES = ["opus", "sonnet", "haiku"];

const READBACK_TRIES = 16;
const READBACK_EVERY_MS = 500;

/** Sends `/model` and `/effort` one after the other and reports only what the session confirmed. */
export const setLiveModel = async (
  deps: LiveModelDeps,
  input: { readonly model?: string | undefined; readonly effort?: string | undefined },
): Promise<LiveModelResult> => {
  const steps: Array<{ kind: "model" | "effort"; text: string }> = [];
  if (input.model !== undefined) {
    const text = modelCommand(input.model);
    if (text === null)
      return { state: "refused", detail: "That is not a model name.", confirmed: [] };
    if (!CLAUDE_ALIASES.includes(input.model) && !deps.claudeModels.includes(input.model))
      return {
        state: "refused",
        detail:
          "A terminal session runs Claude Code; continue in a new thread for another provider.",
        confirmed: [],
      };
    steps.push({ kind: "model", text });
  }
  if (input.effort !== undefined) {
    const text = effortCommand(input.effort);
    if (text === null) {
      return {
        state: "refused",
        detail: "Effort is low, medium, high, xhigh or max.",
        confirmed: [],
      };
    }
    steps.push({ kind: "effort", text });
  }
  if (steps.length === 0) return { state: "refused", detail: "Nothing to change.", confirmed: [] };
  const { session } = deps;
  if (session === null) {
    return { state: "not_running", detail: "That session is not running here now.", confirmed: [] };
  }
  if (session.herdrPane === null) {
    return {
      state: "not_in_herdr",
      detail: "This session is not in Herdr, so it cannot be told. Bring it in to change it here.",
      confirmed: [],
    };
  }
  // A question or approval on screen would take the typed command as its answer.
  if (session.status === "busy" || session.status === "waiting") {
    const detail =
      session.status === "busy"
        ? "It is working. Change it when it is idle."
        : "It is waiting on a question. Answer it first.";
    return { state: "busy", detail, confirmed: [] };
  }
  const confirmed: string[] = [];
  for (const step of steps) {
    const mark = deps.mark();
    if (mark === null) {
      return { state: "not_confirmed", detail: "Its transcript could not be read.", confirmed };
    }
    if (!(await deps.send(session.herdrPane, step.text))) {
      return { state: "not_confirmed", detail: `${step.text} did not reach the pane.`, confirmed };
    }
    let said: string | null = null;
    for (let i = 0; i < READBACK_TRIES && said === null; i += 1) {
      await deps.wait(READBACK_EVERY_MS);
      said = readBack(deps.since(mark), step.kind);
    }
    if (said === null) {
      return {
        state: "not_confirmed",
        detail: `Sent ${step.text}, but the session did not confirm it.`,
        confirmed,
      };
    }
    confirmed.push(said);
  }
  return { state: "applied", detail: confirmed.join(" "), confirmed };
};

const RESUME_TRIES = 20;
const RESUME_EVERY_MS = 1500;

/**
 * A change for a session that is not running resumes that same session id first (never another session), waits for it
 * to be live, then tells it. A running session is told directly.
 */
export const setModelResumingStopped = async (deps: {
  readonly run: () => Promise<LiveModelResult>;
  readonly resume: () => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
}): Promise<LiveModelResult> => {
  const first = await deps.run();
  if (first.state !== "not_running") return first;
  if (!(await deps.resume()))
    return { ...first, detail: "That session is stopped and could not be resumed here." };
  for (let i = 0; i < RESUME_TRIES; i += 1) {
    await deps.wait(RESUME_EVERY_MS);
    const again = await deps.run();
    if (again.state !== "not_running") return again;
  }
  return {
    ...first,
    detail: "The session was resumed but is not live yet. Try again in a moment.",
  };
};
