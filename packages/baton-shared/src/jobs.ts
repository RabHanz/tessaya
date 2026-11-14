/**
 * The rules of a job (D145), pure: which group it is in, what its permissions say in words, whether
 * a cap has been reached, whether a public message needs his yes, and which account the worker uses.
 */
import {
  DEFAULT_JOB_LIMITS,
  type BatonJob,
  type BatonJobGrant,
  type BatonJobGroup,
  type BatonJobLimits,
  type BatonJobPermissions,
  type BatonJobTool,
  type BatonGrantKind,
  type BatonJobPhase,
  type BatonJobRevision,
  type BatonPlanLease,
  type BatonSessionState,
} from "@t3tools/baton-contracts";

import type { LineEvent } from "./expression.ts";

/** running, needs him, done or failed: from the work session's state and whether it was settled. */
export const jobGroup = (state: BatonSessionState, settled: boolean): BatonJobGroup => {
  if (state === "failed") return "failed";
  if (state === "needs_approval" || state === "needs_input" || state === "limited")
    return "needs_you";
  if (settled || state === "done_unseen") return "done";
  return "running";
};

/** The group on the Jobs page: a job waiting for his OK is one that needs him, whatever its thread's state. */
export const jobGroupFor = (
  state: BatonSessionState,
  settled: boolean,
  phase: BatonJobPhase,
): BatonJobGroup =>
  phase === "awaiting_agreement"
    ? "needs_you"
    : phase === "drafting_plan" &&
        state !== "failed" &&
        state !== "needs_input" &&
        state !== "needs_approval"
      ? "running"
      : jobGroup(state, settled);

const TOOL_WORDS: Readonly<Record<BatonJobTool, string>> = {
  read: "read files",
  edit: "change files",
  shell: "run commands",
  web: "use the web",
  sessions: "message other sessions",
};

const list = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const duration = (minutes: number): string =>
  minutes % 60 === 0 && minutes >= 60
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minutes`;

/** The permissions, limits and grants as the sentence on the job card. */
export const permissionsSummary = (
  permissions: BatonJobPermissions,
  limits: BatonJobLimits,
  grants: ReadonlyArray<BatonJobGrant>,
  lease?: BatonPlanLease | null,
): string => {
  const where = [...permissions.projects.map((p) => `the ${p} project`), ...permissions.folders];
  const parts = [
    where.length === 0 ? "Works nowhere yet." : `Works in ${list(where)}.`,
    permissions.tools.length === 0
      ? "May not use any tool."
      : `May ${list(permissions.tools.map((t) => TOOL_WORDS[t]))}${permissions.tools.includes("web") ? "" : "; no web"}.`,
    `Stops after ${duration(limits.wallClockMinutes)} or ${limits.workerTurns} turns${limits.dollars === null ? "" : `, or $${limits.dollars} of spend (as far as the worker's own log shows)`}.`,
  ];
  const live = grants.filter((g) => g.revokedAt === null);
  const standing = live
    .filter((g) => g.channel !== "start" && g.channel !== "retry")
    .map((g) => g.channel.replace("_", " "));
  if (live.some((g) => g.channel === "start")) parts.push("Starts without waiting for your OK.");
  if (live.some((g) => g.channel === "retry")) {
    parts.push("Retries a failed worker by itself, within its retry budget.");
  }
  parts.push(
    standing.length === 0
      ? "Asks you before it sends anything public."
      : `May send ${list(standing)} without asking; asks for anything else public.`,
  );
  if (lease != null)
    parts.push(
      `Its agreed plan may ${list(lease.acts)} on ${list([...lease.sites, ...lease.apps])} without asking; anything risky still asks.`,
    );
  return parts.join(" ");
};

/** The job has gone past a cap it was given. Spend only counts when a dollar cap was set. */
export const limitReached = (
  limits: BatonJobLimits,
  used: { readonly minutes: number; readonly turns: number; readonly dollars?: number },
): "time" | "turns" | "spend" | null =>
  used.minutes >= limits.wallClockMinutes
    ? "time"
    : used.turns >= limits.workerTurns
      ? "turns"
      : limits.dollars !== null && (used.dollars ?? 0) >= limits.dollars
        ? "spend"
        : null;

/** A public message always asks, unless this job holds a standing permission for that channel, not revoked. */
export const outboundDecision = (
  grants: ReadonlyArray<BatonJobGrant>,
  channel: BatonGrantKind,
): "ask" | "standing" =>
  grants.some((g) => g.channel === channel && g.revokedAt === null) ? "standing" : "ask";

export const withGrant = (
  grants: ReadonlyArray<BatonJobGrant>,
  channel: BatonGrantKind,
  at: string,
): ReadonlyArray<BatonJobGrant> =>
  outboundDecision(grants, channel) === "standing"
    ? grants
    : [...grants, { channel, grantedAt: at, revokedAt: null }];

/** Revoking keeps the row, as the log of what was allowed and when. */
export const withRevoked = (
  grants: ReadonlyArray<BatonJobGrant>,
  channel: BatonGrantKind,
  at: string,
): ReadonlyArray<BatonJobGrant> =>
  grants.map((g) => (g.channel === channel && g.revokedAt === null ? { ...g, revokedAt: at } : g));

export const jobLimits = (given?: Partial<BatonJobLimits>): BatonJobLimits => ({
  ...DEFAULT_JOB_LIMITS,
  ...given,
});

export interface WorkerCandidate {
  readonly key: string;
  readonly usable: boolean;
  /** Each window the account reports; a window it does not report is not in the list. */
  readonly windows: ReadonlyArray<{ readonly usedPercent: number }>;
}

/**
 * The account with the most headroom, by its tightest window. An account that reports no session window
 * (Optima) is judged on the windows it does report, and one that reports none counts as half free.
 */
export const pickWorkerAccount = (candidates: ReadonlyArray<WorkerCandidate>): string | null => {
  const headroom = (c: WorkerCandidate) =>
    c.windows.length === 0 ? 50 : Math.min(...c.windows.map((w) => 100 - w.usedPercent));
  const usable = candidates.filter((c) => c.usable && headroom(c) > 0);
  return (
    usable.toSorted((a, b) => headroom(b) - headroom(a) || a.key.localeCompare(b.key))[0]?.key ??
    null
  );
};

/** Does an edit give the job more than it had: a new folder, project or tool, or a longer leash? */
export const permissionsWiden = (
  before: { readonly permissions: BatonJobPermissions; readonly limits: BatonJobLimits },
  after: { readonly permissions: BatonJobPermissions; readonly limits: BatonJobLimits },
): boolean => {
  const grew = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
    b.some((x) => !a.includes(x));
  return (
    grew(before.permissions.folders, after.permissions.folders) ||
    grew(before.permissions.projects, after.permissions.projects) ||
    grew(before.permissions.tools, after.permissions.tools) ||
    after.limits.wallClockMinutes > before.limits.wallClockMinutes ||
    after.limits.workerTurns > before.limits.workerTurns ||
    (after.limits.dollars ?? 0) > (before.limits.dollars ?? 0)
  );
};

export interface JobLifecycle {
  readonly phase: BatonJobPhase;
  readonly revisions: ReadonlyArray<BatonJobRevision>;
  readonly grants: ReadonlyArray<BatonJobGrant>;
}

export type JobEvent =
  /** The worker, in plan mode, has written the plan and its questions into the thread. */
  | { readonly type: "plan_ready" }
  /** He, or Baton for him, said something about the job; `widens` when it gives the job more. */
  | { readonly type: "refined"; readonly revision: BatonJobRevision; readonly widens: boolean }
  /** His explicit agreement: spoken, the button, or a reply in the thread. */
  | { readonly type: "agreed" };

/**
 * Where a job goes (D145): planning, waiting for his OK, running. The worker runs a turn that does the
 * work only in `approved`. His words are always kept. A job with a standing permission to start skips
 * the wait; a refinement that widens what it may do sends even that one back to wait.
 */
export const reduceJob = (state: JobLifecycle, event: JobEvent): JobLifecycle => {
  switch (event.type) {
    case "plan_ready":
      if (state.phase !== "drafting_plan") return state;
      return {
        ...state,
        phase:
          outboundDecision(state.grants, "start") === "standing"
            ? "approved"
            : "awaiting_agreement",
      };
    case "refined": {
      const revisions = [...state.revisions, event.revision];
      if (state.phase === "approved") {
        // Work is under way: more context joins it, and only a wider leash stops it to ask again.
        return { ...state, revisions, phase: event.widens ? "awaiting_agreement" : "approved" };
      }
      return { ...state, revisions, phase: "drafting_plan" };
    }
    case "agreed":
      // Agreeing to a plan that is not written yet starts nothing.
      return state.phase === "awaiting_agreement" ? { ...state, phase: "approved" } : state;
  }
};

/** Whether the worker may take a turn that does the work, rather than planning. */
export const workerMayExecute = (state: JobLifecycle): boolean => state.phase === "approved";

/** The label on the Jobs page for a job that has not started. */
export const phaseLabel = (phase: BatonJobPhase): string | null =>
  phase === "drafting_plan"
    ? "Writing the plan"
    : phase === "awaiting_agreement"
      ? "Waiting for your OK"
      : null;

const GROUP_WORDS: Readonly<Record<BatonJobGroup, string>> = {
  running: "running",
  needs_you: "needs him",
  done: "done",
  failed: "failed",
};

/** Where a job stands, in the words the Record keeps. */
const jobOutcome = (j: Pick<BatonJob, "phase" | "group" | "limitReached">): string =>
  j.phase === "drafting_plan"
    ? "writing its plan"
    : j.phase === "awaiting_agreement"
      ? "plan waits for his OK"
      : j.limitReached !== null
        ? `stopped at its ${j.limitReached} limit`
        : GROUP_WORDS[j.group];

/** What is said aloud where a job was asked when its standing changes to this, or null for a change not worth a word. */
export const jobNotice = (title: string, outcome: string): string | null =>
  outcome === "plan waits for his OK"
    ? `The plan for ${title} is ready in its thread.`
    : outcome === GROUP_WORDS.done
      ? `${title} is done.`
      : outcome === GROUP_WORDS.failed
        ? `${title} failed.`
        : outcome === GROUP_WORDS.needs_you
          ? `${title} needs you.`
          : outcome.startsWith("stopped at its ")
            ? `${title} ${outcome}.`
            : null;

/** The moment a job's change is, for her own words (`jobNotice` is the plain line), or null for none. */
export const jobMoment = (
  outcome: string,
): { readonly event: LineEvent; readonly facts: Readonly<Record<string, string>> } | null =>
  outcome === "plan waits for his OK"
    ? { event: "job.plan", facts: {} }
    : outcome === GROUP_WORDS.done
      ? { event: "job.done", facts: {} }
      : outcome === GROUP_WORDS.failed
        ? { event: "job.failed", facts: {} }
        : outcome === GROUP_WORDS.needs_you
          ? { event: "job.needs", facts: {} }
          : outcome.startsWith("stopped at its ")
            ? {
                event: "job.stopped",
                facts: { limit: outcome.replace(/^stopped at its | limit$/g, "") },
              }
            : null;

/**
 * The jobs whose standing changed since `seen`, which is updated in place. A job seen for the first
 * time is only remembered: a restart must not announce every job again.
 */
export const jobChanges = <
  J extends Pick<BatonJob, "workSessionId" | "phase" | "group" | "limitReached">,
>(
  jobs: ReadonlyArray<J>,
  seen: Map<string, string>,
): ReadonlyArray<{ readonly job: J; readonly outcome: string }> =>
  jobs.flatMap((job) => {
    const outcome = jobOutcome(job);
    const was = seen.get(job.workSessionId);
    seen.set(job.workSessionId, outcome);
    return was === undefined || was === outcome ? [] : [{ job, outcome }];
  });

/**
 * The first message to a worker thread created in plan mode: his words exactly, then the written
 * permissions, then what to do first. Never his words reworded.
 */
export const workerFirstMessage = (input: {
  readonly verbatim: string;
  readonly permissionsSummary: string;
  /** How to frame the job (the operating-system pack, D148), after his words and before the rest. */
  readonly frame?: string;
  /** What memory recalls for his words, as the assistant's turns get it. */
  readonly memory?: string;
  /** A part of a larger plan that he has already agreed: no planning pause. */
  readonly agreed?: boolean;
}): string =>
  [
    `He asked: ${input.verbatim}`,
    ...(input.frame === undefined || input.frame === "" ? [] : [input.frame]),
    ...(input.memory === undefined || input.memory === "" ? [] : [input.memory]),
    `What you may do: ${input.permissionsSummary}`,
    input.agreed === true
      ? "This is one part of a larger plan he has already agreed. Do it now, inside what you were allowed, and report what changed, the evidence, and what blocks you."
      : "Plan first. Write the plan, and any question you need answered, here in this thread. Do not start the work. He will refine the plan here and tell you when to go.",
  ].join("\n\n");
