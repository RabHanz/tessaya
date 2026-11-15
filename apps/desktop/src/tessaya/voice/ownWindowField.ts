import * as Electron from "electron";

import type { CaretContext } from "@t3tools/tessaya-shared/dictationFit";

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

/** How much text either side of the caret a dictation reads to fit in: the last sentence and the next words. */
export const AROUND_CHARS = 300;

type Field = {
  readonly tagName?: string;
  readonly type?: string;
  readonly value?: string;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
  readonly isContentEditable?: boolean;
} | null;

/**
 * The text either side of the caret in the field with the keyboard, read as the words go in, so they fit where he put
 * the caret since. A secret field, a frame or nothing focused says nothing. Runs inside the page on its own.
 */
export const caretAround = (e: Field, chars: number): { before: string; after: string } | null => {
  if (e === null || e.type === "password") return null;
  if (
    (e.tagName === "TEXTAREA" || e.tagName === "INPUT") &&
    typeof e.value === "string" &&
    typeof e.selectionStart === "number"
  ) {
    const end = typeof e.selectionEnd === "number" ? e.selectionEnd : e.selectionStart;
    return {
      before: e.value.slice(Math.max(0, e.selectionStart - chars), e.selectionStart),
      after: e.value.slice(end, end + chars),
    };
  }
  if (e.isContentEditable !== true) return null;
  const root = e as unknown as Node;
  const s = window.getSelection();
  if (s === null || s.rangeCount === 0) return null;
  const r = s.getRangeAt(0);
  if (!root.contains(r.startContainer)) return null;
  const b = document.createRange();
  b.selectNodeContents(root);
  b.setEnd(r.startContainer, r.startOffset);
  const a = document.createRange();
  a.selectNodeContents(root);
  a.setStart(r.endContainer, r.endOffset);
  // A range's text has no line breaks between paragraphs: a caret at the start of one after another is on a new line.
  let block: Node | null = r.startContainer;
  while (
    block !== null &&
    block !== root &&
    !(block instanceof HTMLElement && /^(P|DIV|LI|H[1-6]|PRE|BLOCKQUOTE)$/.test(block.tagName))
  )
    block = block.parentNode;
  let newLine = false;
  if (block !== null && block !== root && (block as HTMLElement).previousElementSibling !== null) {
    const inBlock = document.createRange();
    inBlock.selectNodeContents(block);
    inBlock.setEnd(r.startContainer, r.startOffset);
    newLine = inBlock.toString() === "";
  }
  return {
    before: b.toString().slice(-chars) + (newLine ? "\n" : ""),
    after: a.toString().slice(0, chars),
  };
};

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

/** The words around the caret when `hwnd` is one of Tessaya's own windows; null when it is not ours or cannot say. */
export const ownCaretContext = async (
  hwnd: number,
  chars = AROUND_CHARS,
): Promise<CaretContext | null> => {
  const window = Electron.BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && handleOf(w) === hwnd,
  );
  if (window === undefined) return null;
  return window.webContents
    .executeJavaScript(`(${caretAround.toString()})(document.activeElement, ${chars})`)
    .then((v: unknown) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { before?: unknown }).before === "string" &&
      typeof (v as { after?: unknown }).after === "string"
        ? (v as CaretContext)
        : null,
    )
    .catch(() => null);
};
