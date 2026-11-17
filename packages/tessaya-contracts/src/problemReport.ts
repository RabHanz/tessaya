/**
 * Problem reports and the developer feed (Director, 18 Nov: "send back the problems for you to fix"). A report is a
 * compact, redacted bundle: the symptom, her guess at the cause, the health diagnosis and the log events that show it.
 * The feed is the live tail of the same action log, for the owner's developer mode only. Logic: tessaya-shared/problemReport.
 */
import * as Schema from "effect/Schema";

import { HealthDiagnosis, HealthSnapshot } from "./health.ts";

export const BATON_REPORTS_WS_METHODS = {
  /**
   * List (no op), withdraw or delete, each answered with the whole view; or `sync`, a peer's mirror pull over the
   * memory-sync credential, answered with every row changed since `since`, deleted ones too.
   */
  call: "baton.reports.call",
  /** The live developer feed; maintainer scope, and only while the owner's feedback setting is "developer". */
  feed: "baton.reports.feed",
} as const;

/** One log event as a report or the feed carries it: never a private one, never his words. */
export const FeedEvent = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  kind: Schema.String,
  origin: Schema.String,
  actor: Schema.String,
  subject: Schema.String,
  outcome: Schema.String,
  /** The vessel it came from ("tumble", "desktop", a phone id), when the event names one. */
  vessel: Schema.NullOr(Schema.String),
  data: Schema.NullOr(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  ),
});
export type FeedEvent = typeof FeedEvent.Type;

export const ProblemBundle = Schema.Struct({
  symptom: Schema.String,
  /** Her plain-words guess at the cause. */
  guess: Schema.String,
  vessel: Schema.NullOr(Schema.String),
  diagnosis: Schema.NullOr(HealthDiagnosis),
  health: Schema.NullOr(HealthSnapshot),
  /** The events that show it (the provenance chain, failures, turn metrics), oldest first, trimmed. */
  events: Schema.Array(FeedEvent),
  versions: Schema.Struct({ server: Schema.String, host: Schema.String }),
});
export type ProblemBundle = typeof ProblemBundle.Type;

export const REPORT_STATUSES = ["open", "filed", "withdrawn", "deleted"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const ProblemReport = Schema.Struct({
  id: Schema.String,
  /** Stable per cause, so the same fault is one report, not a flood. */
  key: Schema.String,
  /** The environment that wrote it. */
  origin: Schema.String,
  at: Schema.Number,
  updatedAt: Schema.Number,
  status: Schema.Literals(REPORT_STATUSES),
  source: Schema.Literals(["asked", "proactive"]),
  title: Schema.String,
  /** Null once deleted: the row stays only so the delete reaches every mirror. */
  bundle: Schema.NullOr(ProblemBundle),
  issueUrl: Schema.NullOr(Schema.String),
});
export type ProblemReport = typeof ProblemReport.Type;

export const FEEDBACK_MODES = ["off", "silent", "developer"] as const;
export type FeedbackMode = (typeof FEEDBACK_MODES)[number];

export const ReportsView = Schema.Struct({
  mode: Schema.Literals(FEEDBACK_MODES),
  github: Schema.Boolean,
  reports: Schema.Array(ProblemReport),
  /** The environment that answered; set on a sync pull. */
  origin: Schema.optionalKey(Schema.String),
});
export type ReportsView = typeof ReportsView.Type;

export const ReportsCallInput = Schema.Struct({
  op: Schema.optionalKey(Schema.Literals(["withdraw", "delete", "sync"])),
  id: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.Number),
});

export class ReportsError extends Schema.TaggedError<ReportsError>()("ReportsError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Her tool: what he asked her to report, in her words. */
export const ReportProblemInput = Schema.Struct({
  symptom: Schema.String.annotate({
    description: 'What went wrong, in one short sentence ("she answered twice on Tumble").',
  }),
  guess: Schema.String.annotate({
    description: "Your plain-words guess at the cause; say you are unsure when you are.",
  }),
  vessel: Schema.optionalKey(
    Schema.String.annotate({ description: "The device it happened on, when known." }),
  ),
});
export const ReportProblemResult = Schema.Struct({
  /** Null when reports are off here, or the same problem was reported in the last day. */
  id: Schema.NullOr(Schema.String),
  /** What to say, in one short line. */
  say: Schema.String,
});

export const ReportsListInput = Schema.Struct({
  id: Schema.optionalKey(
    Schema.String.annotate({ description: "One report's id, for its whole bundle." }),
  ),
  status: Schema.optionalKey(Schema.Literals(["open", "filed", "withdrawn"])),
  limit: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

export const DevFeedInput = Schema.Struct({
  after: Schema.optionalKey(
    Schema.Number.annotate({ description: "The `next` of the last call; omit for the newest." }),
  ),
  waitSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 55 })).annotate({
      description: "Wait this long for a new event when there is none yet (long poll).",
    }),
  ),
  vessel: Schema.optionalKey(Schema.String),
});
export const DevFeedResult = Schema.Struct({
  on: Schema.Boolean,
  events: Schema.Array(FeedEvent),
  next: Schema.Number,
});
