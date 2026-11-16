/** The desktop's direct-API dictation cleanup, through the desk door, with the key that stays on the server. */
import * as Schema from "effect/Schema";

export const BATON_DICTATION_WS_METHODS = {
  cleanupApi: "baton.dictation.cleanupApi",
  cleanupApiStatus: "baton.dictation.cleanupApiStatus",
  cleanupUsage: "baton.dictation.cleanupUsage",
} as const;

export const TessayaDictationCleanupInput = Schema.Struct({
  system: Schema.String.check(Schema.isMaxLength(50_000)),
  message: Schema.String.check(Schema.isMaxLength(50_000)),
  /** 0 writes nothing: it only warms the connection and the prompt cache as he starts speaking. */
  maxTokens: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  /** The one retry: the answer the desktop's check refused, and why. An older server asks the same message again. */
  refused: Schema.optional(
    Schema.Struct({
      answer: Schema.String.check(Schema.isMaxLength(50_000)),
      why: Schema.String.check(Schema.isMaxLength(500)),
    }),
  ),
});
export const TessayaDictationCleanupResult = Schema.Union([
  Schema.Struct({ configured: Schema.Literal(false) }),
  Schema.Struct({ configured: Schema.Literal(true), text: Schema.String, ms: Schema.Number }),
]);
export const TessayaDictationCleanupStatus = Schema.Struct({ configured: Schema.Boolean });

/** A clean-up his own Claude plan answered on the desktop: its `result` event's usage, for the one usage record. */
export const TessayaDictationCleanupUsageInput = Schema.Struct({
  model: Schema.String.check(Schema.isMaxLength(200)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(Schema.Unknown),
});
