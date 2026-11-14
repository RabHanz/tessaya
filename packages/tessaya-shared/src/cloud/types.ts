/**
 * Cloud dispatch for any harness: one interface that every provider implements, so the card, the
 * Cloud page and the assistant's tools never name one. Pure: a process runner is injected.
 */

export type ProviderId = "claude" | "codex" | "gemini" | "cursor" | "opencode" | "grok";
export type ResultKind = "pr" | "diff" | "branch";

export type CloudState =
  | "awaiting-director"
  | "approved"
  | "running"
  | "done"
  | "failed"
  | "denied"
  | "cancelled"
  | "closed"
  | "unknown";

export interface CloudRequest {
  readonly provider: ProviderId;
  readonly id: string;
  readonly state: CloudState;
  /** One line of what it is for. */
  readonly task: string | null;
  readonly repo: string | null;
  readonly branch: string | null;
  /** Who asked: the machine (the key) and the session's label. */
  readonly caller: string | null;
  readonly label: string | null;
  readonly account: string | null;
  readonly sessionLink: string | null;
  readonly result: { readonly kind: ResultKind; readonly url: string | null } | null;
  /** Points he was told to expect; null when the provider has no such figure. */
  readonly expectedUsage: number | null;
  readonly weeklyBefore: number | null;
  readonly weeklyAfter: number | null;
  readonly pointsUsed: number | null;
  /** The brief was built from web or file content: it is data, and the card says so. */
  readonly fromWeb: boolean;
  /** Why it did not start or end well, in the provider's words. */
  readonly error: string | null;
  /** The provider flagged the run as over its per-run cap. */
  readonly overCap: boolean;
  /** While `approved`: which process is starting it, and since when. The desktop and the server share the list. */
  readonly startedBy?: { readonly pid: number; readonly at: number };
}

/** One account's live figure. Null means the provider reports none, which is never the same as zero. */
export interface Usage {
  readonly provider: ProviderId;
  readonly account: string;
  readonly weeklyPercent: number | null;
  /** When the week resets, as the provider or the box words it (for example "Monday 14:00 PKT"). */
  readonly resetsAt: string | null;
  readonly rejected: boolean;
  /** False when the provider says the account cannot take a task now (a rejected account is also unavailable). */
  readonly available?: boolean;
  /** The state of the account's own login, when the provider says. */
  readonly login?: "ok" | "renew-soon" | "expired" | "not-logged-in";
  readonly pointsThisWeek: number | null;
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type Setup =
  | { readonly state: "ready" }
  | { readonly state: "not-set-up"; readonly why: string; readonly needs: string };

export interface ExecResult {
  /** Null when the program could not be started at all. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The program is not installed. */
  readonly missing?: boolean;
  readonly timedOut?: boolean;
}

/** Runs a program with an argument list, never a shell string. */
export type Exec = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly stdin?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly timeoutMs: number;
  },
) => Promise<ExecResult>;

export interface DispatchInput {
  readonly repo: string;
  readonly branch: string;
  readonly brief: string;
  readonly label?: string;
  readonly expectedUsage?: number;
  readonly fromWeb?: boolean;
}

/** How a harness is reached. Local is the default and needs nothing set up. */
export type TransportKind = "local" | "hub" | "ssh";

/** What this computer (or the hub) can do for a harness right now, in words for a person. */
export interface Detection {
  readonly installed: boolean;
  readonly signedIn: boolean;
  /** Who is signed in (an address), when the harness says. */
  readonly identity: string | null;
  /** One plain line: the state, and when not ready the exact thing to do. */
  readonly line: string;
  /** The command that signs in, to show or to open in a terminal. */
  readonly signInCommand: string | null;
}

export interface CloudProvider {
  readonly id: ProviderId;
  readonly transport: TransportKind;
  readonly label: string;
  /** The T3 driver kind this harness is, where T3 has one. */
  readonly driver: string;
  readonly capabilities: {
    readonly resultKind: ResultKind;
    readonly cancel: boolean;
    readonly usage: boolean;
    readonly diff: boolean;
    readonly apply: boolean;
  };
  /**
   * Where a request waits for his yes: "remote" is the provider's own gate (the central shell holds it),
   * "local" means Tessaya holds it and starts nothing until he approves.
   */
  readonly approval: "remote" | "local";
  readonly setup: () => Setup;
  /** Installed? signed in? Never reads another config folder than the harness's own. */
  readonly detect: () => Promise<Detection>;
  readonly accounts: () => ReadonlyArray<string>;
  /** Makes a request that waits for him. Runs nothing. */
  readonly dispatch: (input: DispatchInput) => Promise<Outcome<CloudRequest>>;
  readonly status: (id: string) => Promise<Outcome<CloudRequest>>;
  readonly list: (filter: {
    readonly mine?: boolean;
    readonly label?: string;
  }) => Promise<Outcome<ReadonlyArray<CloudRequest>>>;
  readonly cancel: (id: string) => Promise<Outcome<CloudRequest | null>>;
  readonly usage: () => Promise<Outcome<ReadonlyArray<Usage>>>;
  /** His pick, for this request alone. Starts the work. */
  readonly approve: (
    id: string,
    account: string,
    answerRef: string,
  ) => Promise<Outcome<CloudRequest>>;
  readonly deny: (id: string, reason: string) => Promise<Outcome<CloudRequest | null>>;
  readonly diff?: (id: string) => Promise<Outcome<string>>;
  /** Applies the task's change to the git checkout at `dir`, an absolute path on the computer that runs it. */
  readonly apply?: (id: string, dir: string) => Promise<Outcome<string>>;
}

export const BRIEF_MAX = 4_000;
/** A run that uses more than this many points of its own provider's weekly figure is flagged for review. */
export const POINTS_CAP = 2;

/** A run over the cap, judged on its own provider's figure. A provider with no figure never trips it. */
export const overCap = (r: Pick<CloudRequest, "pointsUsed">): boolean =>
  r.pointsUsed !== null && r.pointsUsed > POINTS_CAP;

/** The weekly figure at or above which an account is not offered. */
export const ACCOUNT_LIMIT_PERCENT = 98;

/** Whether an account may be picked, and if not why, from its live figure (absent figure: usable, said so). */
export const pickable = (
  u: Pick<Usage, "weeklyPercent" | "rejected" | "available" | "login"> | undefined,
): { readonly enabled: boolean; readonly why: string | null } => {
  if (u === undefined) return { enabled: true, why: "usage unknown" };
  if (u.rejected) return { enabled: false, why: "rejected" };
  if (u.login === "expired" || u.login === "not-logged-in")
    return { enabled: false, why: "sign in needed" };
  if (u.available === false) return { enabled: false, why: "not available" };
  if (u.weeklyPercent === null)
    return {
      enabled: true,
      why: u.login === "renew-soon" ? "usage unknown; login renews soon" : "usage unknown",
    };
  if (u.weeklyPercent >= ACCOUNT_LIMIT_PERCENT)
    return { enabled: false, why: `${u.weeklyPercent}% used` };
  return { enabled: true, why: u.login === "renew-soon" ? "login renews soon" : null };
};
