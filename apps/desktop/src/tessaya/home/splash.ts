/**
 * The start-up splash, as rules: when to show it, how long it plays and when the app window takes over,
 * and the window's options. Pure. It never holds the app back: the window is shown at the cap whatever happens.
 */
/** The window sting runs 3.6 s and comes to rest at about 3 s (`pack-window-motion.py`). */
export const STING_REST_MS = 3_050;
/** The app window takes over only once the mark has settled, so nothing else moves while it plays. */
export const SPLASH_MIN_MS = 3_150;
export const SPLASH_CAP_MS = 3_900;
export const SPLASH_FADE_MS = 450;
export const SPLASH_SIZE = 192;

export interface SplashAsk {
  /** The app started this run and this is its first window. */
  readonly coldStart: boolean;
  /** Started by the system at sign-in, or hidden in the tray. */
  readonly quietLaunch: boolean;
  /** Reduced or Off motion, or the system asking for it. */
  readonly reducedMotion: boolean;
}

export const shouldSplash = (a: SplashAsk): boolean =>
  a.coldStart && !a.quietLaunch && !a.reducedMotion;

export type SplashState =
  | { readonly phase: "idle" }
  | { readonly phase: "playing"; readonly startedAt: number; readonly windowReadyAt: number | null }
  | { readonly phase: "fading"; readonly fadeStartedAt: number }
  | { readonly phase: "done" };

export type SplashEvent =
  | { readonly type: "start"; readonly at: number }
  | { readonly type: "windowReady"; readonly at: number }
  | { readonly type: "tick"; readonly at: number };

/** `showWindow` is true on the step that begins the cross-fade: that is when the app window is shown. */
export const splashStep = (
  s: SplashState,
  e: SplashEvent,
): { readonly state: SplashState; readonly showWindow: boolean } => {
  if (e.type === "start")
    return s.phase === "idle"
      ? { state: { phase: "playing", startedAt: e.at, windowReadyAt: null }, showWindow: false }
      : { state: s, showWindow: false };
  if (s.phase === "fading") {
    return {
      state: e.at - s.fadeStartedAt >= SPLASH_FADE_MS ? { phase: "done" } : s,
      showWindow: false,
    };
  }
  if (s.phase !== "playing") return { state: s, showWindow: false };
  const next =
    e.type === "windowReady" && s.windowReadyAt === null ? { ...s, windowReadyAt: e.at } : s;
  const played = e.at - next.startedAt;
  const takeOver =
    played >= SPLASH_CAP_MS || (next.windowReadyAt !== null && played >= SPLASH_MIN_MS);
  return takeOver
    ? { state: { phase: "fading", fadeStartedAt: e.at }, showWindow: true }
    : { state: next, showWindow: false };
};

export interface SplashWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly frame: false;
  readonly transparent: true;
  readonly backgroundColor: "#00000000";
  readonly resizable: false;
  readonly movable: false;
  readonly focusable: false;
  readonly skipTaskbar: true;
  readonly hasShadow: false;
  readonly show: false;
  readonly alwaysOnTop: true;
  readonly fullscreenable: false;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly sandbox: true;
  };
}

/** The middle of the screen the window opens on: the one mark sits there, whatever size or place the window has. */
export const splashCentre = (workArea: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): { readonly x: number; readonly y: number } => ({
  x: workArea.x + workArea.width / 2,
  y: workArea.y + workArea.height / 2,
});

/** A small frameless, transparent, click-through-in-spirit window centred on `centre`; no taskbar entry on any system. */
export const splashWindowOptions = (centre: {
  readonly x: number;
  readonly y: number;
}): SplashWindowOptions => ({
  width: SPLASH_SIZE,
  height: SPLASH_SIZE,
  x: Math.round(centre.x - SPLASH_SIZE / 2),
  y: Math.round(centre.y - SPLASH_SIZE / 2),
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  resizable: false,
  movable: false,
  focusable: false,
  skipTaskbar: true,
  hasShadow: false,
  show: false,
  alwaysOnTop: true,
  fullscreenable: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
});

/** The splash page: the transparent animation, centred, nothing else. The image is a data: URL the app made. */
export const splashHtml = (webpBase64: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}body{display:grid;place-items:center;height:100vh}img{width:128px;height:128px}</style></head><body><img alt="" src="data:image/webp;base64,${webpBase64.replace(/[^A-Za-z0-9+/=]/g, "")}"></body></html>`;
