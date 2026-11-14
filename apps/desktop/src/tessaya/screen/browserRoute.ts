// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Which way to work a browser (computer-use reliability): his own Chrome through the Claude in Chrome
 * extension, the operating system's UI Automation on the real window, pixels, or a plain fetch for reads.
 * The choice is pure and always comes with a reason, so a failure is spoken as a reason and the turn log
 * says which route ran and why.
 */
import * as NodeChildProcess from "node:child_process";

import type { ChromeCheck } from "./chromeCheck.ts";

export type Route = "chrome" | "uia" | "pixels" | "fetch" | "none";

export interface RouteInput {
  readonly task: "read" | "act";
  readonly url?: string | undefined;
  /** The page needs his login or his tabs, so a plain fetch would not see what he sees. */
  readonly needsLogin: boolean;
  /** "Use my Chrome" is switched on in Settings. */
  readonly ownChromeOn: boolean;
  readonly chrome: ChromeCheck;
  /** A Chrome window is on screen and not minimised; null when that could not be told. */
  readonly chromeVisible: boolean | null;
  /** Whether Chrome exposes its page to UI Automation. */
  readonly accessibility: "on" | "off" | "unknown";
  /** He has approved restarting Chrome with accessibility on. */
  readonly relaunchApproved: boolean;
}

export interface RouteChoice {
  readonly route: Route;
  /** One plain sentence: said aloud when it matters, and written into the turn log. */
  readonly why: string;
  /** Things to do first, in order. */
  readonly steps: ReadonlyArray<string>;
  /** Needs his yes before it can go ahead. */
  readonly needsApproval?: "relaunch-accessibility";
}

export const CALL_TIMEOUT_MS = 10_000;

export const chooseBrowserRoute = (i: RouteInput): RouteChoice => {
  if (i.task === "read" && !i.needsLogin && i.url !== undefined) {
    return { route: "fetch", why: "A plain read of a public page needs no browser.", steps: [] };
  }
  if (i.ownChromeOn && i.chrome.state === "ready") {
    return {
      route: "chrome",
      why: "Using your own Chrome, which is connected.",
      steps:
        i.chromeVisible === true
          ? ["call with a 10 second limit and one retry"]
          : [
              "bring the Chrome window and the tab to the front",
              "call with a 10 second limit and one retry",
            ],
    };
  }
  const reason = !i.ownChromeOn
    ? "Using your own Chrome is off"
    : i.chrome.message.replace(/\.$/, "");
  if (i.chromeVisible === false) {
    return {
      route: "none",
      why: `${reason}, and no Chrome window is open to work in. Open Chrome and ask again.`,
      steps: [],
    };
  }
  if (i.accessibility === "on") {
    return {
      route: "uia",
      why: `${reason}, so I work the Chrome window through the screen's own controls.`,
      steps: ["bring the Chrome window to the front", "ui_tree, then click_element"],
    };
  }
  if (i.accessibility === "off" && !i.relaunchApproved) {
    return {
      route: "pixels",
      why: `${reason}, and Chrome does not show its page to the controls. I can read the screen and click by sight, or restart Chrome with accessibility on if you allow it.`,
      steps: ["bring the Chrome window to the front", "screen_capture, then click"],
      needsApproval: "relaunch-accessibility",
    };
  }
  if (i.accessibility === "off") {
    return {
      route: "uia",
      why: `${reason}; Chrome was restarted with accessibility on, so I use the screen's controls.`,
      steps: ["ui_tree, then click_element"],
    };
  }
  return {
    route: "pixels",
    why: `${reason}; I will read the screen and click by sight.`,
    steps: ["bring the Chrome window to the front", "screen_capture, then click"],
  };
};

/** Chrome with accessibility off shows a window frame and nothing inside it. */
export const accessibilityLooksOff = (tree: string): boolean => {
  const named = tree
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !/^\s*(pane|window|group|title bar)\b/i.test(l.trim()));
  return named.length < 8;
};

/** `fn` with a time limit and one retry; says what happened in words when both fail. */
export const withCallRetry = async <T>(
  fn: () => Promise<T>,
  opts: { readonly ms?: number; readonly retries?: number; readonly label: string } = {
    label: "that",
  },
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string }
> => {
  const ms = opts.ms ?? CALL_TIMEOUT_MS;
  const tries = 1 + (opts.retries ?? 1);
  for (let attempt = 1; attempt <= tries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), ms);
        }),
      ]);
      return { ok: true, value };
    } catch {
      /* try again */
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: false,
    why: `${opts.label} did not answer in ${Math.round(ms / 1000)} seconds, even after trying again.`,
  };
};

export interface ChromeRelaunchPorts {
  readonly platform: string;
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
}

/** Closes Chrome the polite way and starts it with accessibility on; Chrome restores his tabs. He has already said yes. */
export const relaunchChromeWithAccessibility = async (p: ChromeRelaunchPorts): Promise<string> => {
  const flags = ["--force-renderer-accessibility", "--restore-last-session"];
  try {
    if (p.platform === "win32") {
      await p.run("taskkill", ["/IM", "chrome.exe"]);
      await p.wait(3_000);
      await p.run("cmd", ["/c", "start", "", "chrome", ...flags]);
    } else if (p.platform === "darwin") {
      await p.run("osascript", ["-e", 'quit app "Google Chrome"']);
      await p.wait(3_000);
      await p.run("open", ["-a", "Google Chrome", "--args", ...flags]);
    } else {
      return "Restarting Chrome with accessibility on is not supported on this system.";
    }
  } catch {
    return "Chrome could not be restarted. Close it yourself and open it again.";
  }
  return "Chrome was restarted with accessibility on; your tabs come back.";
};

export const realRelaunchPorts = (platform: string): ChromeRelaunchPorts => ({
  platform,
  run: (command, args) =>
    new Promise((resolve, reject) =>
      NodeChildProcess.execFile(command, [...args], { windowsHide: true }, (e) =>
        e === null ? resolve() : reject(e),
      ),
    ),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
