/**
 * The phone-to-desktop relay over the wire (docs/baton/MOBILE.md): the desktop assistant takes what the phone page
 * posted, answers it, and mirrors the questions it asks him so the phone can answer them too. One method with an
 * operation word, so the desktop bridge needs one command; the server checks every argument and needs the operate scope.
 */
import * as Schema from "effect/Schema";

export const BATON_PHONE_WS_METHODS = { call: "baton.phone.call" } as const;

export const BATON_PHONE_OPS = [
  "take",
  "renew",
  "state",
  "stateGet",
  "answer",
  "fail",
  "prompt",
  "promptPoll",
  "promptClose",
  "ask",
  "askGet",
  "cards",
  "cardAnswer",
] as const;

export const TessayaPhoneCallInput = Schema.Struct({
  op: Schema.Literals(BATON_PHONE_OPS),
  args: Schema.Record(Schema.String, Schema.Unknown),
});
export type TessayaPhoneCallInput = typeof TessayaPhoneCallInput.Type;

/** A card waiting for his yes, as a worker sends it to her brain (`tessaya_brain`). */
export const TessayaInboxCard = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(80)),
  title: Schema.String.check(Schema.isMaxLength(200)),
  detail: Schema.String.check(Schema.isMaxLength(4000)),
  more: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  buttons: Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(8)),
  yes: Schema.Int,
  cancel: Schema.Int,
  needs: Schema.optionalKey(Schema.Literal("cloud-approve")),
  expiresAt: Schema.Number,
});
export type TessayaInboxCard = typeof TessayaInboxCard.Type;

export const TessayaPhoneCallResult = Schema.Struct({ value: Schema.Unknown });

export class BatonPhoneError extends Schema.TaggedError<BatonPhoneError>()("BatonPhoneError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
