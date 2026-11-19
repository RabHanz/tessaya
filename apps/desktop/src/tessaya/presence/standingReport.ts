// @effect-diagnostics globalDate:off
/**
 * Standing jobs for Coming up: what this desktop reports of its own jobs and the built-ins (each one's next run), and
 * what a change from Coming up does here. A moved run stays within its own day.
 */
import type { DesktopStandingChange, DesktopStandingJob } from "@t3tools/tessaya-contracts";
import {
  nextUserJobRun,
  userJobDay,
  whenText,
  type UserJob,
  type UserJobRun,
} from "@t3tools/tessaya-shared/userJobs";

import { BUILT_INS, nextBuiltInRun, type BuiltInId, type StandingState } from "./standingJobs.ts";

const pad = (n: number) => String(n).padStart(2, "0");

export const standingReport = (input: {
  readonly jobs: ReadonlyArray<UserJob>;
  readonly runs: ReadonlyArray<UserJobRun>;
  readonly state: StandingState;
  readonly now: number;
}): ReadonlyArray<DesktopStandingJob> => [
  ...input.jobs
    .filter((j) => !j.proposed)
    .map((j) => ({
      id: j.id,
      title: j.title.slice(0, 200),
      line: `Your standing job: ${j.instruction}`.slice(0, 400),
      on: j.on,
      at: nextUserJobRun(j, input.runs, new Date(input.now)),
      condition: j.trigger.kind === "event" ? `Runs ${whenText(j.trigger)}`.slice(0, 200) : null,
      repeats: j.trigger.kind === "time" ? whenText(j.trigger).slice(0, 80) : null,
      movable: j.trigger.kind === "time",
    })),
  ...BUILT_INS.map((b) => ({
    id: b.id,
    title: b.title.slice(0, 200),
    line: b.what.slice(0, 400),
    on: input.state.on[b.id] === true,
    at: nextBuiltInRun(input.state, b.id, input.now),
    condition: b.trigger.kind === "event" ? `Runs when ${b.trigger.event}` : null,
    repeats: b.trigger.kind === "time" ? `every day from ${pad(b.trigger.hour)}:00` : null,
    movable: b.trigger.kind === "time",
  })),
];

/** What one change does here: his job's switch or its moved run, or a built-in's; null when it no longer applies. */
export type StandingAction =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly patch: Pick<UserJob, "on"> | Pick<UserJob, "moved">;
    }
  | { readonly kind: "builtin"; readonly id: BuiltInId; readonly on: boolean }
  | {
      readonly kind: "builtin-moved";
      readonly id: BuiltInId;
      readonly moved: { readonly day: string; readonly at: number };
    };

export const standingAction = (
  change: DesktopStandingChange,
  input: {
    readonly jobs: ReadonlyArray<UserJob>;
    readonly runs: ReadonlyArray<UserJobRun>;
    readonly state: StandingState;
    readonly now: number;
  },
): StandingAction | null => {
  const job = input.jobs.find((j) => j.id === change.id);
  const builtIn = BUILT_INS.find((b) => b.id === change.id);
  if (change.op !== "move") {
    const on = change.op === "resume";
    if (job !== undefined && !job.proposed) return { kind: "user", id: job.id, patch: { on } };
    if (builtIn !== undefined) return { kind: "builtin", id: builtIn.id, on };
    return null;
  }
  if (change.at === undefined) return null;
  // The run that moves is the next one; its day keeps one run, now at the new time.
  if (job !== undefined) {
    const next = nextUserJobRun(job, input.runs, new Date(input.now));
    if (next === null || userJobDay(next) !== userJobDay(change.at)) return null;
    return { kind: "user", id: job.id, patch: { moved: { day: userJobDay(next), at: change.at } } };
  }
  if (builtIn !== undefined) {
    const next = nextBuiltInRun(input.state, builtIn.id, input.now);
    if (next === null || new Date(next).toDateString() !== new Date(change.at).toDateString())
      return null;
    return {
      kind: "builtin-moved",
      id: builtIn.id,
      moved: { day: new Date(next).toDateString(), at: change.at },
    };
  }
  return null;
};
