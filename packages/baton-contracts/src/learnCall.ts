/** Learning Tessaya's progress, kept per person on this machine's server so every device counts the same tips. */
import * as Schema from "effect/Schema";

export const BATON_LEARN_WS_METHODS = { call: "baton.learn.call" } as const;

export const BatonLearnCallInput = Schema.Struct({
  kind: Schema.Literals(["read", "act"]),
  op: Schema.String.check(Schema.isMaxLength(40)),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BatonLearnCallInput = typeof BatonLearnCallInput.Type;

/** ok with the progress after the call, or not ok with a sentence for a person. */
export const BatonLearnCallResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
});
export type BatonLearnCallResult = typeof BatonLearnCallResult.Type;
