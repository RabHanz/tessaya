/** The Jobs area of Baton's window (D145): job cards as window rows, grouped by where each job is. */
import type { BatonJob } from "@t3tools/tessaya-contracts";
import {
  REPORT_MARK,
  retryBudget,
  retriesUsed,
  retryRefusal,
} from "@t3tools/tessaya-shared/jobReport";

import type { HomeControl } from "../home/batonHome.ts";

const SECTION = {
  needs_you: "Needs you",
  running: "Running",
  failed: "Failed",
  done: "Done",
} as const;
const ORDER = ["needs_you", "running", "failed", "done"] as const;

const status = (j: BatonJob): string =>
  j.phase === "drafting_plan"
    ? "Writing the plan"
    : j.phase === "awaiting_agreement"
      ? "The plan is ready; waiting for your OK"
      : j.limitReached === null
        ? SECTION[j.group]
        : `Stopped at its ${j.limitReached} limit`;

/** "42 of 120 minutes, 11 of 40 turns": what it has used against its caps, once the plan is agreed. */
export const usageLine = (j: BatonJob): string => {
  if (j.usage === undefined || j.phase !== "approved") return "";
  const mins = j.terms.limits.wallClockMinutes;
  const turns = j.terms.limits.workerTurns;
  const spend =
    j.usage.dollars == null
      ? j.usage.tokens === undefined
        ? ""
        : ` ${j.usage.tokens.toLocaleString()} tokens.`
      : ` About $${j.usage.dollars.toFixed(2)}${j.terms.limits.dollars === null ? "" : ` of $${j.terms.limits.dollars}`}${j.usage.partial === true ? " or more" : ""}, ${(j.usage.tokens ?? 0).toLocaleString()} tokens.`;
  return `Used ${j.usage.minutes} of ${mins} min and ${j.usage.turns} of ${turns} turns.${spend}`;
};

/** The newest progress report in the job's record, shortened; empty when there is none. */
export const lastReport = (j: BatonJob): string => {
  const mine = j.terms.revisions?.filter((r) => r.text.startsWith(REPORT_MARK)) ?? [];
  const text = mine.at(-1)?.text.slice(REPORT_MARK.length).trim() ?? "";
  return text === "" ? "" : `Last report: ${text.length > 260 ? `${text.slice(0, 260)}...` : text}`;
};

/** Daily is the one schedule the window offers; the assistant can set any other. */
export const DAILY_MINUTES = 1440;

/**
 * Per job: Approve (or Open T3) with Stop beside it; for a job that needs him, a line to answer or
 * refine in; and, behind More, its schedule.
 */
export const jobControls = (jobs: ReadonlyArray<BatonJob>): ReadonlyArray<HomeControl> =>
  ORDER.flatMap((group) =>
    jobs
      .filter((j) => j.group === group)
      .flatMap((j): ReadonlyArray<HomeControl> => {
        const scheduled = j.terms.scheduleTaskId !== null;
        return [
          {
            id: `j:${j.workSessionId}`,
            section: SECTION[group],
            label: j.title,
            hint: `${status(j)}${scheduled ? ", scheduled" : ""}. ${usageLine(j)} ${lastReport(j)} May: ${j.permissionsSummary}`.replace(
              / {2,}/g,
              " ",
            ),
            kind: "action",
            button: j.phase === "awaiting_agreement" ? "Approve" : "Open T3",
            ...(group === "running" || group === "needs_you" ? { secondary: "Stop" } : {}),
            ...(group === "needs_you" ? { lead: true } : {}),
          },
          ...(group === "needs_you"
            ? [
                {
                  id: `ja:${j.workSessionId}`,
                  section: SECTION[group],
                  label: `Answer or refine: ${j.title}`,
                  kind: "session",
                  project: "",
                  box: "",
                  state: "waiting",
                  stateLabel: "Needs you",
                  urgent: true,
                  canOpen: false,
                  canSend: true,
                } as const,
              ]
            : []),
          ...(group === "done" && j.phase === "approved"
            ? [
                {
                  id: `jk:${j.workSessionId}`,
                  section: SECTION[group],
                  label: `${j.title}: save this as a skill`,
                  hint: "Writes a draft SKILL.md from what the job did, for you to read and edit. Nothing is installed by itself.",
                  kind: "action",
                  button: "Draft a skill",
                } as const,
              ]
            : []),
          ...(j.phase === "approved" && retryRefusal(j) === null
            ? [
                {
                  id: `jr:${j.workSessionId}`,
                  section: SECTION[group],
                  label: `${j.title}: try the worker again`,
                  hint: `It is told why it failed and not to repeat the step. ${retriesUsed(j.terms.revisions)} of ${retryBudget(j)} retries used.`,
                  kind: "action",
                  button: "Retry",
                } as const,
              ]
            : []),
          ...(j.phase === "approved"
            ? [
                {
                  id: `js:${j.workSessionId}`,
                  section: SECTION[group],
                  label: `${j.title}: run it every day`,
                  hint: scheduled
                    ? "It runs again each day in its own thread and reports there."
                    : "Off. Each run reports in the job's own thread.",
                  kind: "action",
                  button: scheduled ? "Turn off" : "Run daily",
                  more: true,
                } as const,
              ]
            : []),
        ];
      }),
  );

/** What a row's action is about: approval, stop, the schedule, or an answer typed in. */
export const jobAction = (jobs: ReadonlyArray<BatonJob>, id: string) => {
  const match = /^(j|ja|js|jr|jk):(.+?)(:later)?$/.exec(id);
  const job = match === null ? undefined : jobs.find((j) => j.workSessionId === match[2]);
  if (match === null || job === undefined) return null;
  const kind = match[1];
  return {
    id: job.workSessionId,
    kind:
      kind === "ja"
        ? "answer"
        : kind === "jk"
          ? "draft"
          : kind === "jr"
            ? "retry"
            : kind === "js"
              ? "schedule"
              : match[3] === undefined
                ? "primary"
                : "stop",
    approve: job.phase === "awaiting_agreement",
    scheduled: job.terms.scheduleTaskId !== null,
  } as const;
};
