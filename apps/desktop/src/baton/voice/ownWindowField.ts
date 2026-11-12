import * as Electron from "electron";

type Focused = {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
} | null;

/**
 * Whether the element with the keyboard in one of our pages takes typed text. A frame or webview (the Browser panel)
 * counts as one: its page is not ours to read. Runs inside the page, so it uses nothing from outside itself.
 */
export const takesText = (e: Focused): boolean =>
  e !== null &&
  (e.isContentEditable === true ||
    e.tagName === "IFRAME" ||
    e.tagName === "WEBVIEW" ||
    ((e.tagName === "TEXTAREA" ||
      (e.tagName === "INPUT" &&
        /^(text|search|email|url|tel|password|number|)$/i.test(e.type ?? ""))) &&
      e.readOnly !== true &&
      e.disabled !== true));

const handleOf = (window: Electron.BrowserWindow): number => {
  const handle = window.getNativeWindowHandle();
  return Number(handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()));
};

/**
 * For a paste into one of Tessaya's own windows: whether a text field there has the keyboard. Windows' own check sees
 * the whole page as a document that takes text, so it never refused a paste into Tessaya with no box focused. Null when
 * `hwnd` is not ours or the page cannot say.
 */
export const ownFieldFocused = async (hwnd: number): Promise<boolean | null> => {
  const window = Electron.BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && handleOf(w) === hwnd,
  );
  if (window === undefined) return null;
  return window.webContents
    .executeJavaScript(`(${takesText.toString()})(document.activeElement)`)
    .then((v: unknown) => (typeof v === "boolean" ? v : null))
    .catch(() => null);
};
