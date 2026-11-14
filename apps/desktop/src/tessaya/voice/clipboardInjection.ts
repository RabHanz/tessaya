/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
/**
 * Dictation into whatever field has focus, through §18's "clipboard" rung of
 * Phase 6's `TextInjectionAdapter`: put the words on the clipboard, send the
 * OS paste chord, put the old clipboard back.
 *
 * Windows only. Electron cannot send keys to another application, and on
 * Linux/Wayland nothing can (D33), so other platforms refuse by name.
 */
import * as NodeChildProcess from "node:child_process";

import type { TextInjectionAdapter } from "@t3tools/tessaya-shared/injection";

export interface Clipboard {
  // Electron 44's clipboard is asynchronous; a plain object in a test is not.
  readonly readText: () => string | Promise<string>;
  readonly writeText: (text: string) => void | Promise<void>;
}

/** The paste chord as a command, or null where this platform cannot send one. */
export const pasteCommand = (
  platform: string,
): { readonly file: string; readonly args: ReadonlyArray<string> } | null =>
  platform === "win32"
    ? {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
        ],
      }
    : null;

export const makeClipboardInjection = (input: {
  readonly platform: string;
  readonly clipboard: Clipboard;
}): TextInjectionAdapter => ({
  method: "clipboard",
  canInject: () => pasteCommand(input.platform) !== null,
  insertText: async ({ text }) => {
    const command = pasteCommand(input.platform);
    if (command === null)
      throw new Error("This platform does not let Tessaya paste into another app.");
    const previous = await input.clipboard.readText();
    await input.clipboard.writeText(text);
    try {
      await new Promise<void>((resolve, reject) => {
        NodeChildProcess.execFile(
          command.file,
          [...command.args],
          { windowsHide: true },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    } finally {
      // The target reads the clipboard on its own schedule; restoring at once
      // can paste the old text. 400 ms covers Chromium and Office.
      setTimeout(() => void input.clipboard.writeText(previous), 400);
    }
  },
});
