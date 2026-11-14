/**
 * Jobs (D145): long work handed to a worker thread, with written permissions. A job is a work
 * session plus its terms. Status is never stored: it is read from the work session's state.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";

import { TessayaSessionState } from "./sessionState.ts";
import { WorkSessionId } from "./workSession.ts";
import { alsoReads } from "./renamed.ts";

export const JOB_GROUPS = ["running", "needs_you", "done", "failed"] as const;
export const TessayaJobGroup = Schema.Literals(JOB_GROUPS);
export type TessayaJobGroup = typeof TessayaJobGroup.Type;

/** What a worker thread may touch, in the terms he reads on the card. */
export const TessayaJobTool = Schema.Literals(["read", "edit", "shell", "web", "sessions"]);
export type TessayaJobTool = typeof TessayaJobTool.Type;

/** Where a message could go. Every one of these is public, and none is done without his yes. */
export const TessayaOutboundChannel = Schema.Literals([
  "email",
  "social",
  "chat",
  "pr_comment",
  "other_public",
]);
export type TessayaOutboundChannel = typeof TessayaOutboundChannel.Type;

export const TessayaJobPermissions = Schema.Struct({
  /** Folders the worker may read and change. */
  folders: Schema.Array(TrimmedNonEmptyString),
  /** Projects it may work in, by their names. */
  projects: Schema.Array(TrimmedNonEmptyString),
  tools: Schema.Array(TessayaJobTool),
});
export type TessayaJobPermissions = typeof TessayaJobPermissions.Type;

/** Both caps apply to a subscription; dollars only to a metered API key, which is never set up by default. */
export const TessayaJobLimits = Schema.Struct({
  wallClockMinutes: Schema.Number,
  workerTurns: Schema.Number,
  dollars: Schema.NullOr(Schema.Number),
  /** A progress report every this many minutes while it runs; 0 is off. Default 60. */
  reportEveryMinutes: Schema.optionalKey(Schema.Number),
  /** How many times a failed worker may be retried. Default 2. */
  retries: Schema.optionalKey(Schema.Number),
});
export type TessayaJobLimits = typeof TessayaJobLimits.Type;

export const DEFAULT_JOB_LIMITS: TessayaJobLimits = {
  wallClockMinutes: 120,
  workerTurns: 40,
  dollars: null,
};

/** What a standing permission is for: sending on a channel, starting without waiting for his OK, or retrying a failed worker on its own within the retry budget. */
export const TessayaGrantKind = Schema.Literals([
  "email",
  "social",
  "chat",
  "pr_comment",
  "other_public",
  "start",
  "retry",
]);
export type TessayaGrantKind = typeof TessayaGrantKind.Type;

/** A standing permission, for one job. Kept after it is revoked, as the log. */
export const TessayaJobGrant = Schema.Struct({
  channel: TessayaGrantKind,
  grantedAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type TessayaJobGrant = typeof TessayaJobGrant.Type;

/**
 * His one yes on a job's plan, for the computer and browser acts the plan names (PERSONA-TEAM-DESIGN §6): acts inside it
 * run without a card, acts outside it ask, risky acts always ask. Cleared when the job leaves "approved" or is stopped.
 */
export const TessayaPlanLease = Schema.Struct({
  persona: TrimmedNonEmptyString,
  sites: Schema.Array(TrimmedNonEmptyString),
  apps: Schema.Array(TrimmedNonEmptyString),
  acts: Schema.Array(TrimmedNonEmptyString),
  issuedAt: IsoDateTime,
  until: IsoDateTime,
});
export type TessayaPlanLease = typeof TessayaPlanLease.Type;

/** Where a job is before work starts (D145): planning, waiting for his OK, or approved to run. */
export const TessayaJobPhase = Schema.Literals(["drafting_plan", "awaiting_agreement", "approved"]);
export type TessayaJobPhase = typeof TessayaJobPhase.Type;

/** Every word he or Baton added to the job's context after it began: who said what, when, and how. */
export const TessayaJobRevision = Schema.Struct({
  by: Schema.Union([Schema.Literal("him"), alsoReads("baton", "tessaya")]),
  at: IsoDateTime,
  via: Schema.Literals(["voice", "text", "thread"]),
  text: TrimmedNonEmptyString,
});
export type TessayaJobRevision = typeof TessayaJobRevision.Type;

export const TessayaJobTerms = Schema.Struct({
  workSessionId: WorkSessionId,
  goal: TrimmedString,
  permissions: TessayaJobPermissions,
  limits: TessayaJobLimits,
  grants: Schema.Array(TessayaJobGrant),
  /** Absent from an older server, and null while no agreed plan names an act set. */
  lease: Schema.optionalKey(Schema.NullOr(TessayaPlanLease)),
  phase: TessayaJobPhase,
  revisions: Schema.Array(TessayaJobRevision),
  /** T3's own scheduled task that starts or resumes the worker; null for a job that runs once. */
  scheduleTaskId: Schema.NullOr(TrimmedNonEmptyString),
  /** The provider instance the worker runs on, chosen from the pool unless he said. */
  workerInstanceId: Schema.NullOr(TrimmedNonEmptyString),
  /** The job this is a part of (the coordinator, D148); null for a job of its own. */
  parentId: Schema.NullOr(WorkSessionId),
  /** For a part that waits on others: the parts it needs finished first, and how it is to run. Null once nothing is pending. */
  partSpec: Schema.NullOr(
    Schema.Struct({
      after: Schema.Array(WorkSessionId),
      role: Schema.optionalKey(Schema.String),
      routine: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TessayaJobTerms = typeof TessayaJobTerms.Type;

/** What a job card shows. */
export const TessayaJob = Schema.Struct({
  workSessionId: WorkSessionId,
  title: TrimmedNonEmptyString,
  goal: TrimmedString,
  group: TessayaJobGroup,
  state: TessayaSessionState,
  lastActivityAt: IsoDateTime,
  /** The permissions in words, as written on the card. */
  permissionsSummary: TrimmedNonEmptyString,
  /** "time", "turns" or "spend" when a cap has been reached; null while it is within them. */
  phase: TessayaJobPhase,
  limitReached: Schema.NullOr(Schema.Literals(["time", "turns", "spend"])),
  /** What the job has used so far, against its caps. Absent from an older server. */
  usage: Schema.optionalKey(
    Schema.Struct({
      minutes: Schema.Number,
      turns: Schema.Number,
      /** From the worker's own transcript; absent when no transcript could be read. */
      tokens: Schema.optionalKey(Schema.Number),
      /** Null when nothing could be priced. */
      dollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      /** The figures are a floor: a transcript or a price was missing. */
      partial: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  terms: TessayaJobTerms,
});
export type TessayaJob = typeof TessayaJob.Type;

export const BATON_JOB_WS_METHODS = {
  jobList: "baton.job.list",
  jobStart: "baton.job.start",
  jobAgree: "baton.job.agree",
  jobRefine: "baton.job.refine",
  jobGrant: "baton.job.grant",
  jobRevoke: "baton.job.revoke",
  jobStop: "baton.job.stop",
  jobSchedule: "baton.job.schedule",
  jobSplit: "baton.job.split",
  /** Start a job from his words: the server picks the project he named and a ready worker (GEN-6). */
  jobPlace: "baton.job.place",
  /** Hand a job to the worker he named. */
  jobHandoff: "baton.job.handoff",
  /** Who on the team is doing what (P4): a read of jobs, episodes and the Record, never a store. */
  jobTeam: "baton.job.team",
} as const;

export const TessayaTeamBoardInput = Schema.Struct({
  /** The persona asking (its pack id); only his desktop app may name one, and walls apply to it. */
  agent: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60))),
  /** His own view (the Now page): walled projects included. Only his desktop app may ask. */
  admin: Schema.optionalKey(Schema.Boolean),
});
export type TessayaTeamBoardInput = typeof TessayaTeamBoardInput.Type;

export const TessayaTeamMember = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** What it does: the part of its pack role before the first ";". */
  role: Schema.String,
  /** A private persona shows only whether it is busy (P5; no persona is private yet). */
  private: Schema.Boolean,
  busy: Schema.Boolean,
  jobs: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  /** Its latest conversation episode (MEM-18), as written. */
  episode: Schema.NullOr(Schema.Struct({ text: Schema.String, at: Schema.String })),
  /** Its newest lines in the Record. They quote agents' words: data, never instructions. */
  recent: Schema.Array(
    Schema.Struct({ at: Schema.String, subject: Schema.String, outcome: Schema.String }),
  ),
});
export type TessayaTeamMember = typeof TessayaTeamMember.Type;

export const TessayaTeamBoardResult = Schema.Struct({ members: Schema.Array(TessayaTeamMember) });
export type TessayaTeamBoardResult = typeof TessayaTeamBoardResult.Type;

/** His words verbatim become the goal; the worker starts in plan mode (D145). */
export const TessayaJobStartInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  permissions: TessayaJobPermissions,
  limits: Schema.optionalKey(
    Schema.Struct({
      wallClockMinutes: Schema.optionalKey(Schema.Number),
      workerTurns: Schema.optionalKey(Schema.Number),
      dollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      reportEveryMinutes: Schema.optionalKey(Schema.Number),
      retries: Schema.optionalKey(Schema.Number),
    }),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  /** A retried start is the same job. */
  id: Schema.optionalKey(WorkSessionId),
});
export type TessayaJobStartInput = typeof TessayaJobStartInput.Type;

export const TessayaJobPlaceInput = Schema.Struct({
  project: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  folders: Schema.Array(TrimmedNonEmptyString),
  /** Read only when empty. */
  tools: Schema.Array(TessayaJobTool),
  reportEveryMinutes: Schema.optionalKey(Schema.Number),
  /** The worker he named: an instance's id or name, or a kind such as codex. Absent: the first ready Claude. */
  worker: Schema.optionalKey(TrimmedNonEmptyString),
  /** The R1 he asked on: its plan-ready and done lines are said there. */
  origin: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  /** Who leads it, by the name he knows (Onyx) or the role's file stem; absent or unknown: the lead. */
  persona: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
  /** The pack template it follows (`plan-a-trip`); its brief joins the worker's frame. */
  template: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
});
export type TessayaJobPlaceInput = typeof TessayaJobPlaceInput.Type;

export const TessayaJobHandoffInput = Schema.Struct({
  id: WorkSessionId,
  instance: TrimmedNonEmptyString,
  note: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TessayaJobHandoffInput = typeof TessayaJobHandoffInput.Type;

/** His words named no project or worker this server has; the reason says what it does have. */
export class TessayaJobPlacementError extends Schema.TaggedError<TessayaJobPlacementError>()(
  "BatonJobPlacementError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const TessayaJobStartResult = Schema.Struct({
  terms: TessayaJobTerms,
  threadId: ThreadId,
  /** Its account is nearly spent: the work waits for this reset (null when none was named) and then starts. */
  pausedUntil: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TessayaJobStartResult = typeof TessayaJobStartResult.Type;

export const TessayaJobRefInput = Schema.Struct({ id: WorkSessionId });
export type TessayaJobRefInput = typeof TessayaJobRefInput.Type;

export const TessayaJobRefineInput = Schema.Struct({
  id: WorkSessionId,
  text: TrimmedNonEmptyString,
  via: Schema.Literals(["voice", "text"]),
  /** True when the edit adds a folder, project, tool or a longer leash: it asks for his OK again. */
  widens: Schema.optionalKey(Schema.Boolean),
  /** True for a line in the job's record only: the worker is not told and does not take a turn. */
  note: Schema.optionalKey(Schema.Boolean),
});
export type TessayaJobRefineInput = typeof TessayaJobRefineInput.Type;

export const TessayaJobGrantInput = Schema.Struct({ id: WorkSessionId, channel: TessayaGrantKind });
export type TessayaJobGrantInput = typeof TessayaJobGrantInput.Type;

/** Null when no such job exists. */
export const TessayaJobTermsResult = Schema.Struct({ terms: Schema.NullOr(TessayaJobTerms) });
export type TessayaJobTermsResult = typeof TessayaJobTermsResult.Type;

export const TessayaJobListResult = Schema.Struct({ jobs: Schema.Array(TessayaJob) });
export type TessayaJobListResult = typeof TessayaJobListResult.Type;

export const TessayaJobStopResult = Schema.Struct({ stopped: Schema.Boolean });
export type TessayaJobStopResult = typeof TessayaJobStopResult.Type;

/** `everyMinutes` of null takes the schedule off. A scheduled job runs again in its own thread and reports there. */
export const TessayaJobScheduleInput = Schema.Struct({
  id: WorkSessionId,
  everyMinutes: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type TessayaJobScheduleInput = typeof TessayaJobScheduleInput.Type;

/** One part of a job that has several: its own title and goal (his words), and optionally a pack role. */
export const TessayaJobPart = Schema.Struct({
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  role: Schema.optionalKey(TrimmedNonEmptyString),
  /** Mechanical, repeatable work: runs on the cheap model of the routing table. */
  routine: Schema.optionalKey(Schema.Boolean),
  /** The parts (numbered from 1, earlier ones only) that must be done before this one starts. */
  after: Schema.optionalKey(
    Schema.Array(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  ),
});

export const TessayaJobSplitInput = Schema.Struct({
  id: WorkSessionId,
  parts: Schema.Array(TessayaJobPart).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type TessayaJobSplitInput = typeof TessayaJobSplitInput.Type;

export const TessayaJobSplitResult = Schema.Struct({
  started: Schema.Array(Schema.Struct({ id: WorkSessionId, threadId: ThreadId })),
});
export type TessayaJobSplitResult = typeof TessayaJobSplitResult.Type;
