/** Her brain's word for a wrong PIN (TessayaHousehold stepUp): any other refusal means the PIN cannot be checked. */
const WRONG_PIN = /not right/i;

/**
 * Whether his own phone's way out may fall back to a long hold: when neither his Face ID nor his PIN can be checked
 * here (no biometrics on this phone, no PIN set, his brain unreachable). A wrong PIN never opens it. The Sleeve must
 * never lock him out of his own phone.
 */
export const exitFallback = (input: {
  readonly biometric: boolean;
  /** The last PIN try's answer, null before any. */
  readonly pin: { readonly ok: boolean; readonly line: string } | null;
}): boolean =>
  !input.biometric || (input.pin !== null && !input.pin.ok && !WRONG_PIN.test(input.pin.line));
