/** Weaving over the wire (D149): one session messaging another by name, with a durable record. Rules: `@t3tools/tessaya-shared/weave`. */
import * as Schema from "effect/Schema";

export const BATON_WEAVE_WS_METHODS = {
  send: "baton.weave.send",
  list: "baton.weave.list",
  tick: "baton.weave.tick",
} as const;

export const TessayaWeave = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  toLabel: Schema.String,
  toPane: Schema.String,
  text: Schema.String,
  status: Schema.Literals(["queued", "delivered", "replied", "lost"]),
  reason: Schema.NullOr(Schema.String),
  job: Schema.NullOr(Schema.String),
  tries: Schema.Number,
  createdAt: Schema.Number,
  deliveredAt: Schema.NullOr(Schema.Number),
  repliedAt: Schema.NullOr(Schema.Number),
  reply: Schema.NullOr(Schema.String),
});
export type TessayaWeave = typeof TessayaWeave.Type;

export const TessayaWeaveSendInput = Schema.Struct({
  /** The target's name, as the fleet shows it. */
  to: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  from: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  job: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const TessayaWeaveSendResult = Schema.Struct({ weave: TessayaWeave });
export const TessayaWeaveListInput = Schema.Struct({ limit: Schema.optionalKey(Schema.Number) });
export const TessayaWeaveListResult = Schema.Struct({ items: Schema.Array(TessayaWeave) });
export const TessayaWeaveTickInput = Schema.Struct({});
export const TessayaWeaveTickResult = Schema.Struct({
  delivered: Schema.Number,
  replied: Schema.Number,
});

/** Said in plain words: no such session, a secret, a name that fits two. */
export class TessayaWeaveError extends Schema.TaggedError<TessayaWeaveError>()("BatonWeaveError", {
  reason: Schema.String,
  /** No session by that name here, so a client may try its other environments. */
  missing: Schema.optionalKey(Schema.Boolean),
}) {
  override get message(): string {
    return this.reason;
  }
}
