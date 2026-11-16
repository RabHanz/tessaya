/** The Record over the wire: one timeline of what happened, who did it, for which project. Rules: `@t3tools/tessaya-shared/audit`. */
import * as Schema from "effect/Schema";

export const BATON_RECORD_WS_METHODS = {
  list: "baton.record.list",
  append: "baton.record.append",
} as const;

const Line = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const TessayaRecordEntry = Schema.Struct({
  id: Schema.Number,
  at: Schema.String,
  // A plain string, not literals: an older client must still decode a kind added later.
  kind: Schema.String,
  /** Who did it: a persona, the watchdog, a job's worker. */
  actor: Schema.String,
  project: Schema.NullOr(Schema.String),
  /** The id a tool needs to act on it (a session, a job, a weave). */
  ref: Schema.NullOr(Schema.String),
  subject: Schema.String,
  outcome: Schema.String,
  detail: Schema.String,
});
export type TessayaRecordEntry = typeof TessayaRecordEntry.Type;

export const TessayaRecordListInput = Schema.Struct({
  /** ISO time; only what happened after it. */
  since: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Line(200)),
  kind: Schema.optionalKey(Line(40)),
  limit: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export const TessayaRecordListResult = Schema.Struct({ entries: Schema.Array(TessayaRecordEntry) });

/** What the desktop app's own session may write: its own assistant's turns, their traces (tools, argument names, times; no text), its standing jobs' runs, what it sensed for her pulse, and his answers at its gate, stored as `approval_reported_by_client`. The server writes every other kind itself. */
const appendRow = <const K extends string, const O extends ReadonlyArray<string>>(
  kind: K,
  outcomes: O,
) =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    actor: Line(60),
    project: Schema.optionalKey(Line(200)),
    subject: Line(300),
    outcome: Schema.Literals(outcomes),
    detail: Line(1000),
  });
/** Each kind carries only its own outcomes, so a turn cannot be written as "approved". */
export const TessayaRecordAppendInput = Schema.Union([
  appendRow("assistant_turn", ["answered", "failed"]),
  appendRow("turn_trace", ["answered", "failed"]),
  appendRow("approval", ["approved", "declined"]),
  // "proposed": a device or another agent proposed one of his own standing jobs (KIRO-1); it is off until he says yes.
  appendRow("standing_job", ["ran", "held", "failed", "proposed"]),
  // What the desktop sensed (watch, CI, anomalies, commitments) for the server's pulse (B-003); `ref` is the trigger id.
  Schema.Struct({
    ...appendRow("notice", [
      "session_failed",
      "session_stalled",
      "session_waiting",
      "session_finished",
      "ci_failed",
      "job_slow",
      "step_repeating",
      "pressure",
      "commitment_due",
    ]).fields,
    ref: Line(200),
  }),
]);
export const TessayaRecordAppendResult = Schema.Struct({});

/** His reaction to one pulse decision, from Settings → Brain → Pulse (B-003); voice uses `tessaya_pulse`. */
export const BATON_PULSE_WS_METHODS = { react: "baton.pulse.react" } as const;
export const TessayaPulseReactInput = Schema.Struct({
  row: Schema.Number,
  reaction: Schema.Literals(["liked", "told_off", "stop"]),
});
export const TessayaPulseReactResult = Schema.Struct({ line: Schema.String });
