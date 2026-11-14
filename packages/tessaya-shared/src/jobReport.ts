/**
 * Employee flows for a job (D145): a progress report every so often, a retry of a failed worker with
 * a budget, and a daily digest. A report is written from state (what the worker did, what is next,
 * what is blocked, what it has used), not asked of the worker, so it costs no turn. Pure.
 */
import type { TessayaJob } from "@t3tools/tessaya-contracts";

export const DEFAULT_REPORT_MINUTES = 60;
export const DEFAULT_RETRIES = 2;
export const REPORT_MARK = "Report:";
export const RETRY_MARK = "Retry";

interface Revision {
  readonly at: string;
  readonly text: string;
}

const minutesText = (m: number): string => (m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

/** The cadence this job asked for, in minutes; 0 turns reports off. */
export const reportCadence = (job: Pick<TessayaJob, "terms">): number => {
  const asked = (job.terms.limits as { reportEveryMinutes?: number }).reportEveryMinutes;
  return asked === undefined ? DEFAULT_REPORT_MINUTES : Math.max(0, Math.min(1440, asked));
};

/** Is a report due: the last one (or the start) is older than the cadence. */
export const reportDue = (
  revisions: ReadonlyArray<Revision>,
  startedAt: string,
  cadenceMinutes: number,
  now: number,
): boolean => {
  if (cadenceMinutes <= 0) return false;
  const last = revisions.filter((r) => r.text.startsWith(REPORT_MARK)).map((r) => Date.parse(r.at));
  const since = last.length > 0 ? Math.max(...last) : Date.parse(startedAt);
  return !Number.isNaN(since) && now - since >= cadenceMinutes * 60_000;
};

export interface ReportInput {
  readonly title: string;
  readonly state: string;
  readonly minutes: number;
  readonly turns: number;
  readonly dollars: number | null;
  readonly partial: boolean;
  readonly doing: string | null;
  readonly findings: ReadonlyArray<string>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly next: ReadonlyArray<string>;
  readonly needsUser: boolean;
  readonly failedChecks: number;
  readonly limitReached: string | null;
}

/** What happened so far, what is next, what is blocking; short and plain. */
export const buildReport = (r: ReportInput): string => {
  const used = `${minutesText(r.minutes)}, ${r.turns} turns${r.dollars === null ? "" : `, about $${r.dollars.toFixed(2)}${r.partial ? " or more" : ""}`}`;
  const sofar = [
    ...(r.findings.length > 0 ? [r.findings.slice(0, 3).join("; ")] : []),
    ...(r.changedFiles.length > 0
      ? [
          `changed ${r.changedFiles.slice(0, 4).join(", ")}${r.changedFiles.length > 4 ? ` and ${r.changedFiles.length - 4} more` : ""}`,
        ]
      : []),
  ];
  const blockers = [
    ...(r.needsUser ? ["waiting for his answer"] : []),
    ...(r.failedChecks > 0
      ? [`${r.failedChecks} failed check${r.failedChecks === 1 ? "" : "s"}`]
      : []),
    ...(r.limitReached === null ? [] : [`it has reached its ${r.limitReached} limit`]),
    ...(r.state === "failed" ? ["the worker failed"] : []),
  ];
  return [
    `${REPORT_MARK} ${r.title} has run ${used}.`,
    r.doing === null ? "" : `Doing: ${r.doing}.`,
    `So far: ${sofar.length > 0 ? sofar.join("; ") : "nothing new recorded"}.`,
    `Next: ${r.next.length > 0 ? r.next.slice(0, 3).join("; ") : "not stated"}.`,
    `Blockers: ${blockers.length > 0 ? blockers.join("; ") : "none"}.`,
  ]
    .filter((l) => l !== "")
    .join(" ");
};

export const retryBudget = (job: Pick<TessayaJob, "terms">): number => {
  const asked = (job.terms.limits as { retries?: number }).retries;
  return asked === undefined ? DEFAULT_RETRIES : Math.max(0, Math.min(5, asked));
};

export const retriesUsed = (revisions: ReadonlyArray<Revision>): number =>
  revisions.filter((r) => r.text.startsWith(`${RETRY_MARK} `)).length;

/** Null when it may be retried; otherwise why not, in words for him. */
export const retryRefusal = (job: TessayaJob): string | null => {
  if (job.phase !== "approved") return "Only a job that has been agreed can be retried.";
  if (job.group !== "failed" && job.limitReached === null) {
    return "It has not failed, so there is nothing to retry.";
  }
  const used = retriesUsed(job.terms.revisions);
  const budget = retryBudget(job);
  return used >= budget
    ? `It has used its ${budget} ${budget === 1 ? "retry" : "retries"}. Say what to change, or hand it to another worker.`
    : null;
};

/** The message sent to the worker: the reason, what was tried, and an instruction not to repeat it. */
export const retryText = (job: TessayaJob, reason: string, lastDid: string | null): string =>
  `${RETRY_MARK} ${retriesUsed(job.terms.revisions) + 1} of ${retryBudget(job)}: ${reason.trim().slice(0, 400)}${lastDid === null ? "" : ` (last it did: ${lastDid.slice(0, 160)})`}. Try again from where it stopped. If the same step failed, take a different approach and say what you changed.`;

/** One line for the morning brief about jobs in the last day. */
export const jobsDigest = (jobs: ReadonlyArray<TessayaJob>, now: number): string | null => {
  const recent = jobs.filter((j) => now - Date.parse(j.lastActivityAt) <= 86_400_000);
  if (recent.length === 0) return null;
  const done = recent.filter((j) => j.group === "done").length;
  const failed = recent.filter((j) => j.group === "failed" || j.limitReached !== null);
  const running = recent.filter((j) => j.group === "running").length;
  const dollars = recent.reduce((s, j) => s + (j.usage?.dollars ?? 0), 0);
  const turns = recent.reduce((s, j) => s + (j.usage?.turns ?? 0), 0);
  const parts = [
    `${recent.length} job${recent.length === 1 ? "" : "s"} worked in the last day`,
    ...(done > 0 ? [`${done} finished`] : []),
    ...(running > 0 ? [`${running} still going`] : []),
    ...(failed.length > 0
      ? [
          `${failed.length} failed or stopped at a limit (${failed
            .slice(0, 2)
            .map((j) => j.title)
            .join(", ")})`,
        ]
      : []),
    `${turns} worker turns`,
    ...(dollars > 0 ? [`about $${dollars.toFixed(2)} as far as the logs show`] : []),
  ];
  return `Jobs: ${parts.join("; ")}.`;
};
