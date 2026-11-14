// @effect-diagnostics globalTimers:off
/**
 * Overlay windows (pointer, cards, pill, toasts) can be kept out of every screen capture with content
 * protection. That also hides them from the person's own screenshot tool and from screen sharing, so it is a
 * setting and is OFF by default. When it is off, Tessaya's own grab hides the windows for the instant it takes.
 * A test run (BATON_TEST_DIR set) records itself on purpose and never protects.
 */
export const overlaysVisibleToCapture = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => (env["BATON_TEST_DIR"] ?? "") !== "";

interface Protectable {
  readonly setContentProtection: (on: boolean) => void;
  readonly isDestroyed?: () => boolean;
  readonly isVisible?: () => boolean;
  readonly hide?: () => void;
  readonly showInactive?: () => void;
}

const windows = new Set<Protectable>();
// A click-through window says how to become click-through again: toggling protection must never leave it taking the mouse.
const reassert = new WeakMap<Protectable, () => void>();
let hideFromCapture = false;

const wanted = (): boolean => hideFromCapture && !overlaysVisibleToCapture();

/** True when content protection is doing the hiding, so a grab need not hide the windows itself. */
export const protectionOn = (): boolean => wanted();

/** Registers a Tessaya window; it follows the setting now and whenever it changes. */
export const protectFromCapture = (win: Protectable, clickThrough?: () => void): void => {
  windows.add(win);
  if (clickThrough !== undefined) reassert.set(win, clickThrough);
  win.setContentProtection(wanted());
};

/** The "Hide Tessaya from screenshots and screen sharing" setting, applied live to every window. */
export const setHideFromCapture = (on: boolean): void => {
  hideFromCapture = on;
  for (const win of windows) {
    if (win.isDestroyed?.() === true) windows.delete(win);
    else {
      win.setContentProtection(wanted());
      reassert.get(win)?.();
    }
  }
};

/**
 * Runs `fn` (a screen grab) with every Tessaya window out of the picture. Windows and macOS can exclude a window
 * from capture for an instant (content protection), which keeps it on screen and in place: hiding a window and
 * showing it again left the pill's first mouse press lost. Elsewhere the windows are hidden for the grab.
 */
export const hiddenForCapture = async <T>(fn: () => Promise<T>, platform: string): Promise<T> => {
  if (wanted()) return fn();
  const live = [...windows].filter((w) => w.isDestroyed?.() !== true && w.isVisible?.() === true);
  const excludes = platform === "win32" || platform === "darwin";
  for (const w of live) {
    if (excludes) w.setContentProtection(true);
    else w.hide?.();
  }
  try {
    if (live.length > 0) await new Promise((r) => setTimeout(r, excludes ? 60 : 120));
    return await fn();
  } finally {
    for (const w of live) {
      if (w.isDestroyed?.() === true) continue;
      if (excludes) w.setContentProtection(false);
      else w.showInactive?.();
      reassert.get(w)?.();
    }
  }
};
