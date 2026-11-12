/**
 * The Tessaya phone app's tabs (drafts/phone-app, variant B): Today, Sessions (T3's thread list), Devices, and You
 * in the settings slot, with Talk as a button between them, not a tab. Pull requests and Usage stay reachable as
 * rows under You. T3's own app keeps its tabs.
 */
export const TESSAYA_TAB_ORDER = ["today", "threads", "devices", "pullRequests", "usage"] as const;

/** Today, Sessions and Devices sit in the bar; the rest are rows under You. */
export const TESSAYA_PRIMARY_TABS = 3;

export const TESSAYA_TAB_LABELS = {
  today: "Today",
  threads: "Sessions",
  devices: "Devices",
} as const;

/** The settings slot is "You" in Tessaya's app. */
export const TESSAYA_YOU = { label: "You", symbol: "person.crop.circle" } as const;

/** Where the app opens: Today in Tessaya's app, the thread list in T3's. */
export const firstTab = (tessaya: boolean) => (tessaya ? "today" : "threads");

/** How many tabs the bar holds before the rest move under the settings slot. */
export const primaryTabCapacity = (tessaya: boolean, capacity: number) =>
  tessaya ? TESSAYA_PRIMARY_TABS : capacity;

/** A Talk button press: hold to talk and release to send; a short tap opens talking hands-free until tapped again. */
export const HOLD_MS = 280;
export type TalkGesture = "hold" | "tap";
export const talkGesture = (pressedForMs: number): TalkGesture =>
  pressedForMs >= HOLD_MS ? "hold" : "tap";

// Set once at startup by `tessayaApp.ts`, before any screen reads it: the build decides, so it never changes.
let tessayaApp = false;
export const setTessayaApp = (on: boolean) => {
  tessayaApp = on;
};
export const tessayaAppOn = () => tessayaApp;
