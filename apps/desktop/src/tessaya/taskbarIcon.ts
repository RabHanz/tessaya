// @effect-diagnostics nodeBuiltinImport:off
/**
 * The taskbar icon of every window follows the palette and theme. Each `setIcon` is a synchronous call into the
 * window manager, so a window gets it only when its icon changes; a window opened later gets the current one when it
 * is created. Never animated. The pinned shortcut and the .exe keep the installed icon (the installer's own).
 */
import * as Electron from "electron";

const given = new WeakMap<Electron.BrowserWindow, string>();
let current: string | null = null;
let watching = false;

const apply = (window: Electron.BrowserWindow): void => {
  if (current === null || window.isDestroyed() || given.get(window) === current) return;
  try {
    window.setIcon(current);
    given.set(window, current);
  } catch {
    // An icon that cannot be loaded leaves the installed one.
  }
};

/** Windows only: the .ico files. Cheap to call on every refresh: it does nothing unless the file changed. */
export const showTaskbarIcon = (file: string, platform: string): void => {
  if (platform !== "win32") return;
  if (!watching) {
    watching = true;
    Electron.app.on("browser-window-created", (_event, window) => apply(window));
  }
  if (file === current) return;
  current = file;
  for (const window of Electron.BrowserWindow.getAllWindows()) apply(window);
};
