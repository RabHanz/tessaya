import { useAtomValue } from "@effect/atom-react";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { setThisPhoneSleeve, thisPhoneId } from "../devices/thisPhone";
import { sleeveCovers, withSleeve, type PhoneNames } from "./sleeveMode.logic";

// The last answer, so a Sleeve starts as her at once, before her brain is reached.
const CACHE_KEY = "tessaya.sleeve";

// one value for every screen that reads it (the Sleeve itself and More's row)
const cached = () => {
  try {
    return SecureStore.getItem(CACHE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
let held: string | undefined = cached();
// he gave this phone back here: the preference value it was given back from, until her brain's value changes
const GIVEN_KEY = "tessaya.sleeve.given";
let given: string | null = (() => {
  try {
    return SecureStore.getItem(GIVEN_KEY);
  } catch {
    return null;
  }
})();
const setGiven = (next: string | null) => {
  given = next;
  void (
    next === null
      ? SecureStore.deleteItemAsync(GIVEN_KEY)
      : SecureStore.setItemAsync(GIVEN_KEY, next)
  ).catch(() => undefined);
};
// his settings unlocked on this Sleeve, until the app leaves the front or RELOCK_MS pass
let unlocked = false;
const listeners = new Set<() => void>();
const tell = () => {
  for (const l of listeners) l();
};
const hold = (next: string | undefined) => {
  held = next;
  setThisPhoneSleeve(sleeveCovers(next, phone(), given));
  tell();
};
export const RELOCK_MS = 5 * 60_000;
let relock: ReturnType<typeof setTimeout> | null = null;
export const setSleeveUnlocked = (on: boolean) => {
  if (relock !== null) clearTimeout(relock);
  relock = on ? setTimeout(() => setSleeveUnlocked(false), RELOCK_MS) : null;
  unlocked = on;
  tell();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const phone = (): PhoneNames => ({
  id: thisPhoneId(),
  names: [Device.deviceName, Device.modelName].filter((n): n is string => typeof n === "string"),
});
setThisPhoneSleeve(sleeveCovers(held, phone(), given));

/** Whether this phone is her Sleeve, from his `sleeve` preference on her brain (set here, elsewhere or by voice). */
export function useSleeve() {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, { reportFailure: false });
  const value = useSyncExternalStore(subscribe, () => held);
  const ask = async (op: "preferences" | "setPreference", args: Record<string, unknown> = {}) => {
    if (environmentId === null) return;
    const r = await devicesCall({ environmentId, input: { kind: "vessel", op, args } });
    if (r._tag !== "Success" || !r.value.ok) return;
    const next = (r.value.value as { preferences?: Record<string, string> }).preferences?.[
      "sleeve"
    ];
    // her brain's value moved on (cleared, or he made it her Sleeve again): his giving it back is done with
    if (given !== null && (next ?? "") !== given) setGiven(null);
    hold(next);
    await (
      next === undefined
        ? SecureStore.deleteItemAsync(CACHE_KEY)
        : SecureStore.setItemAsync(CACHE_KEY, next)
    ).catch(() => undefined);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his preference now and each time the app comes to the front
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- ask closes over this environment
    void ask("preferences");
    const sub = AppState.addEventListener(
      "change",
      (s) => s === "active" && void ask("preferences"),
    );
    return () => sub.remove();
  }, [environmentId]);
  return {
    sleeve: sleeveCovers(value, phone(), given),
    set: (on: boolean) => {
      // giving it back takes effect here at once, whether or not her brain is reached; making it hers again ends that
      setGiven(on ? null : (value ?? ""));
      tell();
      return ask("setPreference", { key: "sleeve", value: withSleeve(value, phone(), on) });
    },
  };
}

/** Whether the Sleeve covers the app now: this phone is her Sleeve and his settings are locked. */
export function useSleeveCovering() {
  const value = useSyncExternalStore(subscribe, () => held);
  const open = useSyncExternalStore(subscribe, () => unlocked);
  const back = useSyncExternalStore(subscribe, () => given);
  return sleeveCovers(value, phone(), back) && !open;
}

/** Whether this phone is her Sleeve, locked or not: it holds her voice route as her body (phoneRoute). */
export function useIsSleeve() {
  const value = useSyncExternalStore(subscribe, () => held);
  const back = useSyncExternalStore(subscribe, () => given);
  return sleeveCovers(value, phone(), back);
}
