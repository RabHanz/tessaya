/**
 * This Sleeve's own settings (REQ-25-096), kept on the phone like any device's own state and reported to the household
 * device registry as its items, so her brain reads and changes them by voice (device_set) as the Settings rows do.
 */
import type { NotificationBehavior } from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export interface SleeveSettings {
  /** The screen stays on while it charges as her Sleeve. */
  readonly awake: boolean;
  /** The app's notifications arrive without sound or banner while she is on screen. */
  readonly quiet: boolean;
}
const KEY = "tessaya.sleeve.settings";
const DEFAULTS: SleeveSettings = { awake: true, quiet: false };

let settings: SleeveSettings = (() => {
  try {
    return {
      ...DEFAULTS,
      ...(JSON.parse(SecureStore.getItem(KEY) ?? "{}") as Partial<SleeveSettings>),
    };
  } catch {
    return DEFAULTS;
  }
})();
const listeners = new Set<() => void>();

export const sleeveSettings = () => settings;
export const setSleeveSetting = (key: keyof SleeveSettings, on: boolean) => {
  settings = { ...settings, [key]: on };
  void SecureStore.setItemAsync(KEY, JSON.stringify(settings)).catch(() => undefined);
  for (const l of listeners) l();
};
export const useSleeveSettings = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );

// whether she covers the app now (SleeveHost), for her quiet notifications
let covering = false;
export const setSleeveShowing = (on: boolean) => {
  covering = on;
};
/** A notification's foreground behavior, kept in the list but without sound or banner while she is quietly on screen. */
export const sleeveQuietBehavior = (b: NotificationBehavior): NotificationBehavior =>
  covering && settings.quiet ? { ...b, shouldShowBanner: false, shouldPlaySound: false } : b;
