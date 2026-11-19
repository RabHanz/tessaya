/**
 * Coming up: everything Tessaya will do later, read from the stores that already hold it (house timers and automations,
 * device rules, reminders, scheduled tasks and jobs, rules on sessions, standing jobs, waiting account moves, dated
 * memories), soonest first. Nothing here is stored; a change goes back to the source that owns the item.
 */
import * as Schema from "effect/Schema";

export const BATON_UPCOMING_WS_METHODS = {
  list: "baton.upcoming.list",
  change: "baton.upcoming.change",
} as const;

export const UPCOMING_SOURCES = [
  "house",
  "reminder",
  "task",
  "standing",
  "rule",
  "move",
  "date",
] as const;
export type UpcomingSource = (typeof UPCOMING_SOURCES)[number];

export const UPCOMING_OPS = ["cancel", "pause", "resume", "move"] as const;
export type UpcomingOp = (typeof UPCOMING_OPS)[number];

export const UpcomingItem = Schema.Struct({
  /** `<source>:<the source's own id>`. */
  id: Schema.String.check(Schema.isMaxLength(300)),
  source: Schema.Literals(UPCOMING_SOURCES),
  title: Schema.String.check(Schema.isMaxLength(200)),
  /** What it does and who asked, in a sentence. */
  line: Schema.String.check(Schema.isMaxLength(400)),
  /** Epoch ms of its next run; null when it waits on a condition. */
  at: Schema.NullOr(Schema.Number),
  /** A date with no time of day (a birthday): `at` is that day's start. */
  allDay: Schema.optionalKey(Schema.Boolean),
  /** What it waits for, when it has no time ("Waiting for you to get home"). */
  condition: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  /** How it repeats ("daily", "every 4 h"), or null when it runs once. */
  repeats: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
  paused: Schema.Boolean,
  can: Schema.Struct({ cancel: Schema.Boolean, pause: Schema.Boolean, move: Schema.Boolean }),
});
export type UpcomingItem = typeof UpcomingItem.Type;

export const UpcomingListInput = Schema.Struct({
  days: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))),
});
export type UpcomingListInput = typeof UpcomingListInput.Type;

export const UpcomingListResult = Schema.Struct({
  items: Schema.Array(UpcomingItem),
  /** Sources that could not be read just now, named for a person ("the house"). */
  unreadable: Schema.Array(Schema.String),
});
export type UpcomingListResult = typeof UpcomingListResult.Type;

export const UpcomingChangeInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  op: Schema.Literals(UPCOMING_OPS),
  /** For move: the new time (epoch ms). */
  at: Schema.optionalKey(Schema.Number),
  /** For move, instead of `at`: this many minutes from now ("make it fifteen"). */
  inMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 * 24 * 31 })),
  ),
});
export type UpcomingChangeInput = typeof UpcomingChangeInput.Type;

export const UpcomingChangeResult = Schema.Struct({
  /** False when it waits for his yes, or the source cannot do it; `line` says which. */
  done: Schema.Boolean,
  line: Schema.String,
});
export type UpcomingChangeResult = typeof UpcomingChangeResult.Type;

export class UpcomingError extends Schema.TaggedError<UpcomingError>()("UpcomingError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}
