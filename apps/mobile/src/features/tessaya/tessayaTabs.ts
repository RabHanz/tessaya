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

/** What Android's native tab bar draws for Tessaya's tabs: its words, and 24 unit outline icons as SVG path data. */
export const TESSAYA_NATIVE_TABS = {
  labels: { today: "Today", threads: "Sessions", devices: "Devices", settings: "You" },
  icons: {
    // A sun.
    today:
      "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4 -1.4M17.7 6.3l1.4 -1.4",
    // The R1: a rounded body, its eye and its grille.
    devices:
      "M8 3h8a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-8a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3zM9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M9 17h6",
    // A person.
    settings: "M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2",
  },
} as const;
