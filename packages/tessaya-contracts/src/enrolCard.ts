/**
 * The guided voice-enrolment card (Voice ID on the desktop, Enrol on an R1): what to read, how far he has got and how
 * it went. Whoever listens builds it (`createEnrolGuide` in baton-voice); every client only draws it, so its words
 * are here, not in the clients.
 */
import * as Schema from "effect/Schema";

export const EnrolCardLine = Schema.Struct({
  /** The sentence; clients split it on spaces, and `heard` counts those words. */
  text: Schema.String,
  state: Schema.Literals(["todo", "now", "again", "done"]),
  /** Words he has reached in this sentence while it is the one being read. */
  heard: Schema.Number,
  /** Why it must be read again. */
  why: Schema.NullOr(Schema.String),
});
export type EnrolCardLine = typeof EnrolCardLine.Type;

export const EnrolCard = Schema.Struct({
  title: Schema.String,
  lead: Schema.String,
  lines: Schema.Array(EnrolCardLine),
  /** The microphone that is listening, in his words. */
  mic: Schema.String,
  /** 0 to 1, for the meter. */
  level: Schema.Number,
  phase: Schema.Literals(["reading", "saving", "done", "failed"]),
  summary: Schema.NullOr(
    Schema.Struct({
      /** 1 to 3 bars; 0 when nothing was saved. */
      quality: Schema.Number,
      headline: Schema.String,
      rows: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
      tip: Schema.NullOr(Schema.String),
    }),
  ),
});
export type EnrolCard = typeof EnrolCard.Type;
