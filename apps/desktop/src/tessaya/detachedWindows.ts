/**
 * Detached thread windows on the desktop app (D96). The renderer opens one with `window.open`, the
 * same call as on the web, so Electron gives it the main window's preload and session and it talks
 * to the same backend. This file only allows that one URL shape, keeps each window's place, and
 * asks the main window to open them again after a restart.
 */
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Electron event callbacks and a small JSON file
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

import { trustRenderer } from "./trustedRenderers.ts";

const WINDOW_NAME_PREFIX = "baton-window-";
const WINDOW_ID = /^[a-z0-9-]{1,40}$/;
const STATE_FILE = "baton-detached-windows.json";
const SAVE_DELAY_MS = 500;

interface DetachedWindow {
  readonly id: string;
  readonly url: string;
  readonly bounds: Electron.Rectangle | null;
}

export function detachedWindowId(url: string, applicationUrl: string): string | null {
  try {
    const parsed = new URL(url);
    const application = new URL(applicationUrl);
    // Not `origin`: it is the string "null" for a custom scheme.
    if (parsed.protocol !== application.protocol || parsed.host !== application.host) return null;
    const id = parsed.searchParams.get("batonWindow");
    return id !== null && WINDOW_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function parseDetachedWindows(text: string): ReadonlyArray<DetachedWindow> {
  try {
    const entries: unknown = JSON.parse(text);
    if (!Array.isArray(entries)) return [];
    return entries.filter(
      (entry): entry is DetachedWindow =>
        typeof entry?.id === "string" && WINDOW_ID.test(entry.id) && typeof entry.url === "string",
    );
  } catch {
    return [];
  }
}

const statePath = () => NodePath.join(Electron.app.getPath("userData"), STATE_FILE);

function readWindows(): ReadonlyArray<DetachedWindow> {
  try {
    return parseDetachedWindows(NodeFS.readFileSync(statePath(), "utf8"));
  } catch {
    return [];
  }
}

const writeWindows = (windows: ReadonlyArray<DetachedWindow>) => {
  try {
    NodeFS.writeFileSync(statePath(), JSON.stringify(windows, null, 2));
  } catch {
    // Losing a window's saved place is not worth interrupting anyone over.
  }
};

/** Windows open now, across re-creations of the main window, so none is opened twice. */
const openWindows = new Set<string>();

/** Installs on a main window. `guard` gives a window the main window's navigation policy. */
export function installDetachedWindows(
  main: Electron.BrowserWindow,
  applicationUrl: string,
  // Electron does not pass the opener's preload to a child, and the renderer needs its bridge.
  webPreferences: Electron.WebPreferences,
  guard: (window: Electron.BrowserWindow) => void,
) {
  const saved = new Map(readWindows().map((entry) => [entry.id, entry]));
  const save = () => writeWindows([...saved.values()]);
  let quitting = false;
  Electron.app.once("before-quit", () => {
    quitting = true;
  });

  const watch = (opener: Electron.WebContents) =>
    opener.on("did-create-window", (window, details) => {
      const id = detachedWindowId(details.url, applicationUrl);
      if (id === null) return;
      openWindows.add(id);
      trustRenderer(window.webContents);
      guard(window);
      watch(window.webContents);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remember = () => {
        if (window.isDestroyed()) return;
        const contentsUrl = window.webContents.getURL();
        const url =
          detachedWindowId(contentsUrl, applicationUrl) === id ? contentsUrl : details.url;
        saved.set(id, { id, url, bounds: window.getNormalBounds() });
        save();
      };
      const rememberSoon = () => {
        clearTimeout(timer);
        timer = setTimeout(remember, SAVE_DELAY_MS);
      };
      remember();
      window.on("move", rememberSoon);
      window.on("resize", rememberSoon);
      window.webContents.on("did-navigate-in-page", rememberSoon);
      window.on("closed", () => {
        clearTimeout(timer);
        openWindows.delete(id);
        // Next tick: a quit or an update tears every window down at once, the main one included,
        // and those windows must come back. With the main window still up this one was closed.
        setTimeout(() => {
          if (quitting || main.isDestroyed()) return;
          saved.delete(id);
          save();
        }, 0);
      });
    });
  watch(main.webContents);

  main.webContents.once("did-finish-load", () => {
    for (const { id, url } of saved.values()) {
      if (openWindows.has(id) || detachedWindowId(url, applicationUrl) !== id) continue;
      const open = `window.open(${JSON.stringify(url)}, ${JSON.stringify(`${WINDOW_NAME_PREFIX}${id}`)}, "popup")`;
      void main.webContents.executeJavaScript(`void ${open}`, true).catch(() => {});
    }
  });

  return (url: string): Electron.WindowOpenHandlerResponse | null => {
    const id = detachedWindowId(url, applicationUrl);
    if (id === null) return null;
    const bounds = saved.get(id)?.bounds;
    return {
      action: "allow",
      // A window on another monitor must not close with the one that opened it.
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        ...bounds,
        webPreferences,
        minWidth: 480,
        minHeight: 400,
        autoHideMenuBar: true,
      },
    };
  };
}
