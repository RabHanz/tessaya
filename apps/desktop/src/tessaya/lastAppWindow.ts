/**
 * Baton lives in the tray, so a window closing is never the end of it (D118). Only the tray's Quit
 * or a system shutdown ends the app. Without a tray there would be no way back, so a build or a
 * machine that has none keeps upstream's rule. Pure, so it can be tested without Electron.
 */
const companions = new WeakSet<object>();
export const markCompanionWindow = (window: object): void => void companions.add(window);
/** The ask box, a prompt, the pointer or the pill: never a window to bring up for him. */
export const isCompanionWindow = (window: object): boolean => companions.has(window);

/**
 * Upstream's theme sync repaints every window. Tessaya's own windows (Home, splash, pill, cards) keep their own
 * colours, and a window made without a title-bar overlay throws on `setTitleBarOverlay`: neither is touched, and the
 * call never throws. True when it was applied.
 */
export const syncsWithT3Appearance = (window: object): boolean => !companions.has(window);
export const setOverlaySafely = (
  window: { readonly setTitleBarOverlay: (options: never) => void },
  options: unknown,
): boolean => {
  if (companions.has(window)) return false;
  try {
    window.setTitleBarOverlay(options as never);
    return true;
  } catch {
    return false;
  }
};

let trayHolds = false;
export const keepRunningForTray = (): void => {
  trayHolds = true;
};

export const shouldQuitOnAllClosed = (): boolean => !trayHolds;

/**
 * The window to reveal for "open Baton's sessions": the first that is neither an auxiliary window nor
 * one of Baton's own. With only Baton's window up this is nothing, and the caller creates T3's.
 */
export const pickRevealable = <W extends object>(
  windows: ReadonlyArray<W>,
  isAuxiliary: (window: W) => boolean,
): W | undefined => windows.find((w) => !isAuxiliary(w) && !isCompanionWindow(w));
