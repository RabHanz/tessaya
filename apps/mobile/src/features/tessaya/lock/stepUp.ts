/**
 * Confirming it's him on this phone, the one way for Sleeve's settings and the private layer: his PIN, checked by her
 * brain's household store (`stepUp`, the same check the desk's private window uses), or Face ID or a fingerprint,
 * which only releases that PIN from the phone's keychain for the same check. Nothing is unlocked on the phone alone.
 */
import * as SecureStore from "expo-secure-store";

const PIN_KEY = "tessaya.stepUpPin";
const SAVED_KEY = "tessaya.stepUpPin.saved";

/** `refused`: her brain said the PIN is wrong (not that it couldn't be reached). */
export type StepUpCall = (
  pin: string,
) => Promise<{ readonly ok: boolean; readonly refused: boolean; readonly line: string }>;

/** Face ID or a fingerprint can stand in for the PIN once he has typed it here and agreed. */
export const biometricOffered = (): boolean => {
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
};

export const biometricSaved = async (): Promise<boolean> =>
  (await SecureStore.getItemAsync(SAVED_KEY).catch(() => null)) === "1";

/** His PIN, checked by her brain; kept behind biometrics for next time when he asks. */
export const stepUpWithPin = async (call: StepUpCall, pin: string, remember: boolean) => {
  const result = await call(pin);
  if (result.ok && remember && biometricOffered()) {
    await SecureStore.setItemAsync(PIN_KEY, pin, {
      requireAuthentication: true,
      authenticationPrompt: "Keep your PIN for Face ID",
    }).catch(() => undefined);
    await SecureStore.setItemAsync(SAVED_KEY, "1").catch(() => undefined);
  }
  return result;
};

/** Face ID or a fingerprint releases the kept PIN, which her brain checks as if typed. */
export const stepUpWithBiometric = async (call: StepUpCall, why: string) => {
  const pin = await SecureStore.getItemAsync(PIN_KEY, {
    requireAuthentication: true,
    authenticationPrompt: why,
  }).catch(() => null);
  if (pin === null) return { ok: false, refused: false, line: "Use your PIN instead." };
  const result = await call(pin);
  // a PIN changed elsewhere: the kept one is useless now
  if (result.refused) await forgetBiometric();
  return result;
};

export const forgetBiometric = async () => {
  await SecureStore.deleteItemAsync(PIN_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(SAVED_KEY).catch(() => undefined);
};
