/** The desktop's direct-API dictation cleanup, through the desk door, with the key that stays on the server. */
import * as Schema from "effect/Schema";

export const BATON_DICTATION_WS_METHODS = {
  cleanupApi: "baton.dictation.cleanupApi",
  cleanupApiStatus: "baton.dictation.cleanupApiStatus",
} as const;

export const BatonDictationCleanupInput = Schema.Struct({
  system: Schema.String.check(Schema.isMaxLength(50_000)),
  message: Schema.String.check(Schema.isMaxLength(50_000)),
  maxTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
});
export const BatonDictationCleanupResult = Schema.Union([
  Schema.Struct({ configured: Schema.Literal(false) }),
  Schema.Struct({ configured: Schema.Literal(true), text: Schema.String, ms: Schema.Number }),
]);
export const BatonDictationCleanupStatus = Schema.Struct({ configured: Schema.Boolean });
