// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Is Claude in Chrome set up on this computer? One question, one plain line (D3). Two facts are read:
 * the extension is installed in a Chrome profile, and its native host is listening (a named pipe on
 * Windows, a socket in the temp folder elsewhere). Reading them changes nothing and starts nothing.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** The extension's id in the Chrome Web Store. */
export const CLAUDE_CHROME_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

export type ChromeState = "ready" | "no-extension" | "not-connected" | "unsupported";

export interface ChromeCheck {
  readonly state: ChromeState;
  /** One line a person can read aloud. */
  readonly message: string;
}

export interface ChromeProbe {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly user: string;
  readonly tmp: string;
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * Nothing here blocks the main thread or throws: the folder reads are asynchronous, and the check as a
 * whole gives up after a few seconds, because the voice and the window must never wait on Chrome.
 */
export const realProbe = (platform: string): ChromeProbe => ({
  platform,
  env: process.env,
  home: NodeOS.homedir(),
  user: process.env["USERNAME"] ?? process.env["USER"] ?? "",
  tmp: NodeOS.tmpdir(),
  list: (dir) => NodeFS.promises.readdir(dir).catch(() => []),
  exists: (path) =>
    NodeFS.promises.access(path).then(
      () => true,
      () => false,
    ),
});

const chromeRoots = (p: ChromeProbe): ReadonlyArray<string> =>
  p.platform === "win32"
    ? [
        NodePath.join(
          p.env["LOCALAPPDATA"] ?? NodePath.join(p.home, "AppData", "Local"),
          "Google",
          "Chrome",
          "User Data",
        ),
      ]
    : p.platform === "darwin"
      ? [NodePath.join(p.home, "Library", "Application Support", "Google", "Chrome")]
      : [NodePath.join(p.home, ".config", "google-chrome")];

const extensionInstalled = async (p: ChromeProbe): Promise<boolean> => {
  for (const root of chromeRoots(p)) {
    for (const profile of await p.list(root)) {
      if (
        (profile === "Default" || profile.startsWith("Profile ")) &&
        (await p.exists(NodePath.join(root, profile, "Extensions", CLAUDE_CHROME_EXTENSION_ID)))
      ) {
        return true;
      }
    }
  }
  return false;
};

const hostListening = async (p: ChromeProbe): Promise<boolean> =>
  p.platform === "win32"
    ? (await p.list("\\\\.\\pipe\\")).some((name) => name.startsWith("claude-mcp-browser-bridge"))
    : (await p.list(NodePath.join(p.tmp, `claude-mcp-browser-bridge-${p.user}`))).some((name) =>
        name.endsWith(".sock"),
      );

export const checkChrome = async (p: ChromeProbe): Promise<ChromeCheck> => {
  if (p.platform !== "win32" && p.platform !== "darwin" && p.platform !== "linux") {
    return { state: "unsupported", message: "Chrome control is not available on this system." };
  }
  if (!(await extensionInstalled(p))) {
    return {
      state: "no-extension",
      message:
        "Claude in Chrome is not installed in Chrome. Install the extension from the Chrome Web Store and sign in to it.",
    };
  }
  if (!(await hostListening(p))) {
    return {
      state: "not-connected",
      message:
        "The Chrome extension is installed but not connected. Open Chrome and the extension, and check it is signed in.",
    };
  }
  return { state: "ready", message: "Chrome is connected." };
};

/** The check, with a time limit and no way to throw: the voice and the window never wait on Chrome. */
export const checkChromeWithin = async (p: ChromeProbe, ms: number): Promise<ChromeCheck> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      checkChrome(p),
      new Promise<ChromeCheck>((resolve) => {
        timer = setTimeout(
          () => resolve({ state: "not-connected", message: "Chrome did not answer in time." }),
          ms,
        );
      }),
    ]);
  } catch {
    return { state: "not-connected", message: "Chrome could not be checked." };
  } finally {
    clearTimeout(timer);
  }
};
