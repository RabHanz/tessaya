import { useAtomValue } from "@effect/atom-react";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { thisPhoneId } from "../devices/DevicesRouteScreen";
import { isSleeve, withSleeve, type PhoneNames } from "./sleeveMode.logic";

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
// his settings unlocked on this Sleeve, until the app leaves the front or RELOCK_MS pass
let unlocked = false;
const listeners = new Set<() => void>();
const tell = () => {
  for (const l of listeners) l();
};
const hold = (next: string | undefined) => {
  held = next;
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
    sleeve: isSleeve(value, phone()),
    set: (on: boolean) =>
      ask("setPreference", { key: "sleeve", value: withSleeve(value, phone(), on) }),
  };
}

/** Whether the Sleeve covers the app now: this phone is her Sleeve and his settings are locked. */
export function useSleeveCovering() {
  const value = useSyncExternalStore(subscribe, () => held);
  const open = useSyncExternalStore(subscribe, () => unlocked);
  return isSleeve(value, phone()) && !open;
}
