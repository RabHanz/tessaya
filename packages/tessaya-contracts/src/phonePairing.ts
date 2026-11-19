/**
 * Add a phone: one QR pairs the phone with this environment and every environment linked to it. Each machine mints its
 * own one-time, short-lived pairing code (a linked one over its full-access peer link); nothing long-lived is in the code.
 */
import { AuthPairingCredentialResult, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const BATON_PHONE_PAIRING_WS_METHODS = {
  issue: "baton.phonePairing.issue",
  // the way out matching the way in: this phone signed out of every machine of the household (M-097)
  signOut: "baton.phonePairing.signOut",
} as const;

export const PhoneSignOutResult = Schema.Struct({
  /** False when this phone was paired before households: only this machine signs it out. */
  everywhere: Schema.Boolean,
});
export type PhoneSignOutResult = typeof PhoneSignOutResult.Type;

/** The tool a linked environment calls here for this machine's own code. */
export const PHONE_PAIRING_TOOL = "phone_pairing_code";

/** The tool her brain calls on each of his machines to sign a household device out there too. */
export const HOUSEHOLD_DEVICE_REVOKE_TOOL = "household_device_revoke";

/**
 * One device across his machines (M-097): every code in one pairing carries the same id in its label, which becomes the
 * device's session label on each machine, so signing it out on one signs it out on all.
 */
export const HOUSEHOLD_DEVICE = /^hd-[a-z0-9]{8,32}$/;
export const householdDeviceLabel = (device: string): string => `Phone · ${device}`;
export const householdDeviceOf = (label: string | null | undefined): string | null => {
  const tail = label?.split(" · ").at(-1) ?? "";
  return HOUSEHOLD_DEVICE.test(tail) ? tail : null;
};

/** How long a phone's pairing code lasts: long enough to find the app and scan. */
export const PHONE_PAIRING_TTL_MINUTES = 10;

/** The Tessaya phone app's link scheme: a camera scan opens its Add environment screen. */
export const PHONE_APP_SCHEME = "tessaya";

export const PhonePairingLinked = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  pairingUrl: Schema.String,
  expiresAt: Schema.DateTimeUtc,
});
export type PhonePairingLinked = typeof PhonePairingLinked.Type;

export const PhonePairingResult = Schema.Struct({
  /** This environment's own code; the client puts it on the address the phone can reach. */
  here: AuthPairingCredentialResult,
  linked: Schema.Array(PhonePairingLinked),
  /** Linked environments left out, each with why in plain words. */
  missed: Schema.Array(Schema.Struct({ label: Schema.String, reason: Schema.String })),
  /** The household device id every code here carries (one sign-out signs it out everywhere). */
  device: Schema.optionalKey(Schema.String),
  /** Her brain's environment: where the phone's Tessaya reads from when it is connected. */
  brain: Schema.optionalKey(EnvironmentId),
});
export type PhonePairingResult = typeof PhonePairingResult.Type;

export class PhonePairingError extends Schema.TaggedError<PhonePairingError>()(
  "PhonePairingError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The QR's text: the app link carrying every machine's pairing URL, in order. */
export const phonePairingLink = (pairingUrls: ReadonlyArray<string>): string =>
  `${PHONE_APP_SCHEME}://connections/new?${new URLSearchParams(pairingUrls.map((url): [string, string] => ["pairingUrl", url]))}`;
