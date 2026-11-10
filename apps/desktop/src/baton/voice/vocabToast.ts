// @effect-diagnostics globalTimers:off
/**
 * The one card beside the pill (PILL-V2): a word learned (Discard), words with nowhere to paste (Copy), or a
 * dictation that went wrong. One at a time; about 8 s, longer while the pointer is on it; Esc or ✕ closes it.
 * It never takes focus, its window is exactly its own size so every click outside goes through, and it stays
 * out of screen sharing.
 */
import { protectFromCapture } from "../captureProtection.ts";
import * as Electron from "electron";

import { PILL_FACES } from "../home/fonts.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import {
  CARD_CSS,
  DEFAULT_LOOK,
  ICON,
  STICKERS,
  applyLookScript,
  lookAttributes,
  type PillLook,
} from "./pillLook.ts";
import { onPillLook, pillLook, refreshPillTheme } from "./pillTheme.ts";

/** The widest a card gets, with the 6 px around it; a short one is as wide as its words (the page says its real size). */
const WIDTH = 352;
const GAP = 8;
const LEAVE_MS = 8_000;
const BATCH_MS = 1_200;
/** "Copied" stays this long once Copy is pressed. */
const COPIED_MS = 1_300;
/** Tall enough for the longest card (a reason, three lines of his words and Copy); the page then says its real size. */
const MAX_HEIGHT = 220;

export type Card =
  | { readonly kind: "learned"; readonly words: ReadonlyArray<string> }
  | { readonly kind: "copy"; readonly why: string; readonly text: string }
  | { readonly kind: "error"; readonly message: string; readonly text?: string };

/** Windows 11 22H2 and later draw acrylic behind a window (BrowserWindow backgroundMaterial). */
export const acrylicSupported = (platform: string, release: string): boolean =>
  platform === "win32" && Number(release.split(".")[2] ?? 0) >= 22621;

/** The learned card's title: the word, two words, or how many. */
export const learnedTitle = (words: ReadonlyArray<string>): string =>
  words.length <= 2 ? words.join(", ") : `${words.length} words`;

/** Only Quiet is drawn over acrylic; Tessaya and Lively look the same on Windows 10 and 11. */
export const frostedFor = (look: PillLook, frosted: boolean): boolean =>
  frosted && look.design === "quiet";

const esc = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A copy card this short fits on one line beside its Copy. */
const SHORT = 28;

const cardBody = (card: Card): string => {
  const close = `<button class="ic" id="x" type="button" aria-label="Close">${ICON.x}</button>`;
  const sticker = (shape: keyof typeof STICKERS, cls: string, icon: string) =>
    `<span class="sticker ${cls}" style="clip-path:${STICKERS[shape]}" aria-hidden="true">${icon}</span>`;
  if (card.kind === "learned")
    return `<div class="card stk" style="padding:10px 8px 10px 14px">${sticker("bloom", "s2", ICON.book)}<div class="hd"><span class="gl alt">${ICON.book}</span><span style="padding-right:6px"><span class="lbl">Learned</span><br><span class="ttl">${esc(learnedTitle(card.words))}</span></span><button class="b undo" id="discard" type="button">Undo</button>${close}</div></div>`;
  if (card.kind === "copy") {
    const copy = `<button class="b pri" id="copy" type="button">${ICON.copy}Copy</button>`;
    if (card.text.length <= SHORT && !card.text.includes("\n"))
      return `<div class="card stk w-short">${sticker("petal", "", ICON.copy)}<div class="hd"><span class="grow"><span class="lbl">${esc(card.why)}</span><br><span class="said">${esc(card.text)}</span></span>${copy}${close}</div></div>`;
    return `<div class="card stk w-copy">${sticker("petal", "", ICON.copy)}<div class="hd"><span class="gl">${ICON.copy}</span><span class="lbl grow">${esc(card.why)}</span>${close}</div><div class="body said clip">${esc(card.text)}</div><div class="acts">${copy}</div></div>`;
  }
  const copy =
    card.text === undefined
      ? close
      : `<button class="b pri" id="copy" type="button">${ICON.copy}Copy</button>`;
  const line =
    card.text === undefined
      ? `<span class="sec">${esc(card.message)}</span>`
      : `<span class="lbl fail">${esc(card.message)}</span><span class="one said">${esc(card.text)}</span>`;
  return `<div class="card stk w-err" style="padding:10px 10px 10px 14px">${sticker("knot", "s3", ICON.alert)}<div class="hd"><span class="gl fail">${ICON.alert}</span><span class="grow">${line}</span>${copy}</div></div>`;
};

export const cardDocument = (
  card: Card,
  options: { readonly frosted?: boolean; readonly look?: PillLook } = {},
): string => {
  const look = options.look ?? DEFAULT_LOOK;
  const frosted = frostedFor(look, options.frosted === true);
  return `<!doctype html><html${frosted ? ' class="frost"' : ""} ${lookAttributes(look)}><head><meta charset="utf-8"><style>${PILL_FACES[look.design]}${CARD_CSS}
/* Frosted: Windows blurs what is behind the window, so the card fills it at the system's corner radius. */
html.frost #wrap{padding:0}html.frost .card{border-radius:8px;min-height:100vh;box-shadow:none}
</style></head><body><div id="wrap" role="status" aria-live="polite">${cardBody(card)}</div>
<script>
const {ipcRenderer}=typeof require==='function'?require('electron'):{ipcRenderer:{send(){}}};
const wrap=document.getElementById('wrap'),size=()=>{const r=wrap.getBoundingClientRect();return [Math.ceil(r.width),Math.ceil(r.height)];};
window.size=size;
for(const [id,act] of [['discard','discard'],['copy','copy'],['x','close']]){const b=document.getElementById(id);if(b)b.onclick=()=>{
 // Copy becomes the Copied pill, as the drafts end: the window then shrinks to it.
 if(act==='copy'){wrap.innerHTML='<span class="copied"><span class="ok" aria-hidden="true">${ICON.check}</span><span>Copied</span></span>';}
 ipcRenderer.send('baton-toast:act',act,...size());};}
wrap.onmouseenter=()=>ipcRenderer.send('baton-toast:act','hover');wrap.onmouseleave=()=>ipcRenderer.send('baton-toast:act','leave');
</script></body></html>`;
};

export interface VocabToast {
  /** A word was learned; words arriving close together share one card. */
  readonly add: (word: string) => void;
  /** Shows this card in place of any other. */
  readonly show: (card: Card) => void;
  /** Takes back the copy card for these words, if it is the one up. */
  readonly retract: (text: string) => void;
  readonly dispose: () => void;
}

export const createVocabToast = (input: {
  /** Where the pill is (or would be): the card sits just above it. */
  readonly anchor: () => Electron.Rectangle;
  /** He chose Discard: take these out and never add them again. */
  readonly onDiscard: (words: ReadonlyArray<string>) => void;
  /** Settings → On screen → Frosted glass, where Windows can draw it (`acrylicSupported`); else the tint. */
  readonly frosted?: () => boolean;
  /** Esc closes the card while it is up; it is his key again after. */
  readonly holdEscape?: (onPress: () => void) => () => void;
}): VocabToast => {
  let pending: string[] = [];
  let shown: Card | null = null;
  let window: Electron.BrowserWindow | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseEscape: (() => void) | null = null;
  let copied = false;

  const stopLeave = () => {
    if (leaveTimer !== null) clearTimeout(leaveTimer);
    leaveTimer = null;
  };
  const leaveIn = (ms: number) => {
    stopLeave();
    leaveTimer = setTimeout(close, ms);
    leaveTimer.unref();
  };
  const close = () => {
    stopLeave();
    releaseEscape?.();
    releaseEscape = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
    window = null;
    shown = null;
    copied = false;
  };
  const show = (card: Card) => {
    close();
    shown = card;
    const at = input.anchor();
    const area = Electron.screen.getDisplayMatching(at).workArea;
    const place = (height: number, width = WIDTH) => {
      const above = at.y - height - GAP;
      return {
        x: Math.min(
          Math.max(Math.round(at.x + at.width / 2 - width / 2), area.x),
          area.x + area.width - width,
        ),
        y:
          above >= area.y ? above : Math.min(at.y + at.height + GAP, area.y + area.height - height),
        width,
        height,
      };
    };
    void refreshPillTheme();
    const look = pillLook();
    const frosted = frostedFor(look, input.frosted?.() === true);
    const win = new Electron.BrowserWindow({
      ...place(MAX_HEIGHT),
      ...(frosted ? { backgroundMaterial: "acrylic" as const, roundedCorners: true } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    markCompanionWindow(win);
    protectFromCapture(win);
    window = win;
    void win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(cardDocument(card, { frosted, look }))}`,
      )
      .then(() => win.webContents.executeJavaScript("window.size()"))
      .then((size: unknown) => {
        if (win.isDestroyed()) return;
        const [width, height] = Array.isArray(size) ? size : [];
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0)
          win.setBounds(place(Math.ceil(height), Math.min(WIDTH, Math.ceil(width))));
        win.showInactive();
      })
      .catch(() => undefined);
    releaseEscape = input.holdEscape?.(close) ?? null;
    leaveIn(LEAVE_MS);
  };

  Electron.ipcMain.on("baton-toast:act", (event, act: unknown, width: unknown, height: unknown) => {
    if (window === null || event.sender !== window.webContents) return;
    const card = shown;
    // Copied leaves on its own clock, pointer or not.
    if (act === "hover" || act === "leave") {
      if (copied) return;
      return act === "hover" ? stopLeave() : leaveIn(LEAVE_MS);
    }
    if (act === "copy") {
      if (card !== null && card.kind !== "learned" && card.text !== undefined)
        Electron.clipboard.writeText(card.text);
      // The page is now the Copied pill: the window shrinks to it where the card stood, then goes.
      if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
        const b = window.getBounds();
        const w = Math.ceil(width);
        const h = Math.ceil(height);
        window.setBounds({
          x: Math.round(b.x + (b.width - w) / 2),
          y: b.y + b.height - h,
          width: w,
          height: h,
        });
      }
      copied = true;
      return leaveIn(COPIED_MS);
    }
    close();
    if (act === "discard" && card?.kind === "learned") input.onDiscard(card.words);
  });

  // A theme or design change while a card is up repaints it in place.
  const stopLook = onPillLook((look) => {
    if (window !== null && !window.isDestroyed())
      void window.webContents.executeJavaScript(applyLookScript(look)).catch(() => undefined);
  });

  return {
    add: (word) => {
      pending.push(word);
      if (batchTimer !== null) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        // Words learned while their card is still up join it.
        const words = [...(shown?.kind === "learned" ? shown.words : []), ...pending];
        pending = [];
        if (words.length > 0) show({ kind: "learned", words });
      }, BATCH_MS);
      batchTimer.unref();
    },
    show,
    retract: (text: string) => {
      if (shown?.kind === "copy" && shown.text === text) close();
    },
    dispose: () => {
      if (batchTimer !== null) clearTimeout(batchTimer);
      stopLook();
      close();
    },
  };
};
