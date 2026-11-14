// @effect-diagnostics nodeBuiltinImport:off
/**
 * The folder open in an Explorer window. The sidecar knows a window's title, which is only the
 * folder's name, so this asks the shell for its path. Null for anything that is not one.
 */
import * as NodeChildProcess from "node:child_process";

/** "file:///C:/Users/Sam/My%20Docs" to a Windows path. */
export const folderFromUrl = (url: string): string | null => {
  const match = /^file:\/\/\/([A-Za-z]:\/.*)$/.exec(url.trim());
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!).replaceAll("/", "\\");
  } catch {
    return null;
  }
};

const WAIT_MS = 1_500;

export const focusedFolder = (window: number, platform: string): Promise<string | null> => {
  // The number is all that reaches the script, so a title can never become code.
  if (platform !== "win32" || !Number.isSafeInteger(window)) return Promise.resolve(null);
  const script = `(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.HWND -eq ${window} } | ForEach-Object { $_.LocationURL }`;
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: WAIT_MS },
      (error, stdout) => resolve(error === null ? folderFromUrl(stdout) : null),
    );
  });
};
