/**
 * His standing yeses ("Always allow") over the wire: one list on his server that every vessel reads, so a yes given
 * once holds on the Tessel, the desktop, the phone and the web. The rule for when one counts is
 * `@t3tools/tessaya-shared/consent`.
 */
import * as Schema from "effect/Schema";

export const BATON_CONSENT_WS_METHODS = {
  list: "baton.consent.list",
  set: "baton.consent.set",
} as const;

const GrantKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400));

export const TessayaConsentListInput = Schema.Struct({});
export const TessayaConsentSetInput = Schema.Struct({ key: GrantKey, allow: Schema.Boolean });
export const TessayaConsentResult = Schema.Struct({ keys: Schema.Array(Schema.String) });
