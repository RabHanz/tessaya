// @effect-diagnostics globalTimers:off globalDate:off
/** Runs the splash: a small transparent window with the start animation that hands over to the app window. */
import * as Electron from "electron";

import { protectFromCapture } from "../captureProtection.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import {
  SPLASH_FADE_MS,
  splashHtml,
  splashStep,
  splashWindowOptions,
  type SplashEvent,
  type SplashState,
} from "./splash.ts";

const TICK_MS = 50;

const fade = (
  apply: (opacity: number) => void,
  from: number,
  to: number,
  then?: () => void,
): void => {
  const started = Date.now();
  const timer = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / SPLASH_FADE_MS);
    apply(from + (to - from) * t * t * (3 - 2 * t));
    if (t >= 1) {
      clearInterval(timer);
      then?.();
    }
  }, 16);
  timer.unref();
};

/**
 * Shows the splash centred on `centre`. `windowReady(show)` says the app window can be shown: `show` runs when the
 * splash has played enough (or at the cap), and the app window should fade in with `fadeIn`.
 */
/** `sting` is the animation for the palette and theme in use; without it there is no splash, only the window. */
export const startSplash = (
  centre: { readonly x: number; readonly y: number },
  sting: Buffer | null,
) => {
  let state: SplashState = { phase: "idle" };
  let win: Electron.BrowserWindow | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let onShow: (() => void) | null = null;

  const close = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (win !== null && !win.isDestroyed()) win.destroy();
    win = null;
  };
  const feed = (e: SplashEvent): void => {
    const step = splashStep(state, e);
    state = step.state;
    if (step.showWindow) {
      onShow?.();
      onShow = null;
      if (win !== null && !win.isDestroyed()) {
        const w = win;
        fade((o) => w.isDestroyed() || w.setOpacity(o), 1, 0);
      }
    }
    if (state.phase === "done") close();
  };

  try {
    if (sting === null) throw new Error("no animation for this palette");
    win = new Electron.BrowserWindow(splashWindowOptions(centre));
    markCompanionWindow(win);
    protectFromCapture(win);
    win.setIgnoreMouseEvents(true);
    win.once("ready-to-show", () => win?.showInactive());
    void win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(sting.toString("base64")))}`,
    );
    feed({ type: "start", at: Date.now() });
    timer = setInterval(() => feed({ type: "tick", at: Date.now() }), TICK_MS);
    timer.unref();
  } catch {
    // A splash that cannot be made never stands in the way: the window just shows.
    close();
    state = { phase: "done" };
  }

  return {
    /** Calls `show` when the app window should appear: now if there is no splash, else when the timeline says. */
    whenToShow: (show: () => void): void => {
      if ((state.phase !== "playing" && state.phase !== "idle") || win === null) return show();
      onShow = show;
      feed({ type: "windowReady", at: Date.now() });
    },
    cancel: close,
    fade,
  };
};
