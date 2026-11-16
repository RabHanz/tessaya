/** Activity / Why over the wire (B-046): every action and what caused it. Rules: `@t3tools/tessaya-shared/provenance`. */
import * as Schema from "effect/Schema";

export const TESSAYA_ACTIVITY_WS_METHODS = {
  list: "baton.activity.list",
  why: "baton.activity.why",
} as const;

const Line = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const TessayaActionEvent = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  // Plain strings, not literals: an older client must still decode a kind added later.
  kind: Schema.String,
  origin: Schema.String,
  actor: Schema.Struct({
    kind: Schema.String,
    id: Schema.optionalKey(Schema.String),
    certainty: Schema.Number,
  }),
  cause: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.Struct({ kind: Schema.String, ref: Schema.String })),
  persona: Schema.NullOr(Schema.String),
  subject: Schema.String,
  outcome: Schema.String,
  data: Schema.Unknown,
});
export type TessayaActionEvent = typeof TessayaActionEvent.Type;

export const TessayaActivityFinding = Schema.Struct({
  rule: Schema.String,
  key: Schema.String,
  title: Schema.String,
  count: Schema.Number,
  firstAt: Schema.Number,
  lastAt: Schema.Number,
  eventIds: Schema.Array(Schema.String),
});
export type TessayaActivityFinding = typeof TessayaActivityFinding.Type;

export const TessayaActivityListInput = Schema.Struct({
  /** How far back, in minutes. Default 60. */
  sinceMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 43_200 })),
  ),
  /** A kind or its family: "tool", "model.call", "device", "room". */
  kind: Schema.optionalKey(Line(60)),
  actor: Schema.optionalKey(Line(20)),
  outcome: Schema.optionalKey(Line(40)),
  text: Schema.optionalKey(Line(100)),
  limit: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type TessayaActivityListInput = typeof TessayaActivityListInput.Type;

export const TessayaActivityListResult = Schema.Struct({
  events: Schema.Array(TessayaActionEvent),
  /** The gap detector over the same window: likely bugs and gaps, each with the events that show it. */
  findings: Schema.Array(TessayaActivityFinding),
  /** Events dropped because the writer fell behind since this server started. */
  dropped: Schema.Number,
});
export type TessayaActivityListResult = typeof TessayaActivityListResult.Type;

export const TessayaActivityWhyInput = Schema.Struct({
  /** An event id; without one, the newest event matching `text` (or the newest of all). */
  id: Schema.optionalKey(Line(40)),
  text: Schema.optionalKey(Line(100)),
});
export type TessayaActivityWhyInput = typeof TessayaActivityWhyInput.Type;

export const TessayaActivityWhyResult = Schema.Struct({
  /** The event, then what caused it, then what caused that. */
  chain: Schema.Array(TessayaActionEvent),
  /** What it caused in turn. */
  effects: Schema.Array(TessayaActionEvent),
  /** The chain in short lines a voice can read. */
  lines: Schema.Array(Schema.String),
});
export type TessayaActivityWhyResult = typeof TessayaActivityWhyResult.Type;
