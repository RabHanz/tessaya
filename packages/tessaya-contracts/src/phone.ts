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
] as const;

export const BatonPhoneCallInput = Schema.Struct({
  op: Schema.Literals(BATON_PHONE_OPS),
  args: Schema.Record(Schema.String, Schema.Unknown),
});
export type BatonPhoneCallInput = typeof BatonPhoneCallInput.Type;

export const BatonPhoneCallResult = Schema.Struct({ value: Schema.Unknown });

export class BatonPhoneError extends Schema.TaggedError<BatonPhoneError>()("BatonPhoneError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
