// @effect-diagnostics globalTimers:off
/**
 * The one card beside the pill (PILL-V2): a word learned (Discard), words with nowhere to paste (Copy), or a
 * dictation that went wrong. One at a time; about 8 s, longer while the pointer is on it; Esc or ✕ closes it.
 * It never takes focus, its window is exactly its own size so every click outside goes through, and it stays
 * out of screen sharing.
 */
import { protectFromCapture } from "../captureProtection.ts";
import * as Electron from "electron";

import { markCompanionWindow } from "../lastAppWindow.ts";

const WIDTH = 340;
const GAP = 10;
const LEAVE_MS = 8_000;
const BATCH_MS = 1_200;
/** Tall enough for the longest card (a reason and three lines); the page then says its real height. */
const MAX_HEIGHT = 120;

export type Card =
  | { readonly kind: "learned"; readonly words: ReadonlyArray<string> }
  | { readonly kind: "copy"; readonly why: string; readonly text: string }
  | { readonly kind: "error"; readonly message: string; readonly text?: string };

/** Windows 11 22H2 and later draw acrylic behind a window (BrowserWindow backgroundMaterial). */
export const acrylicSupported = (platform: string, release: string): boolean =>
  platform === "win32" && Number(release.split(".")[2] ?? 0) >= 22621;

/** One line: Learned “Kowalczyk”, or “A”, “B”, or 4 words. */
export const learnedText = (words: ReadonlyArray<string>): string =>
  words.length <= 2
    ? `Learned ${words.map((w) => `“${w}”`).join(", ")}`
    : `Learned ${words.length} words`;

const esc = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const cardDocument = (card: Card, frosted = false): string => {
  const body =
    card.kind === "learned"
      ? `<div class="body"><div class="txt">${esc(learnedText(card.words))}</div></div><div class="acts"><button class="cb" id="discard" type="button">Discard</button>`
      : card.kind === "copy"
        ? `<div class="body"><div class="why">${esc(card.why)}</div><div class="txt">${esc(card.text)}</div></div><div class="acts"><button class="cb" id="copy" type="button">Copy</button>`
        : `<span class="dot" aria-hidden="true"></span><div class="body"><div class="txt">${esc(card.message)}</div></div><div class="acts">${card.text === undefined ? "" : '<button class="cb" id="copy" type="button">Copy</button>'}`;
  return `<!doctype html><html${frosted ? ' class="frost"' : ""}><head><meta charset="utf-8"><style>
:root{--glass:rgba(20,20,26,.58);--edge:rgba(255,255,255,.13);--text:#fff;--soft:rgba(255,255,255,.62);--accent:#5FB3B3;--danger:#ff8a80;
--sans:"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
@media (prefers-color-scheme:light){:root{--glass:rgba(255,255,255,.82);--edge:rgba(0,0,0,.16);--text:#0f1012;--soft:rgba(15,16,18,.74);--accent:#14505A;--danger:#b3261e}}
html,body{margin:0;overflow:hidden;background:transparent;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;cursor:default}
#t{box-sizing:border-box;width:100%;min-height:52px;border-radius:14px;background:var(--glass);box-shadow:inset 0 0 0 1px var(--edge);color:var(--text);padding:10px 8px 10px 14px;display:flex;gap:6px;align-items:flex-start;animation:in .2s cubic-bezier(.2,.8,.25,1) both}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.body{flex:1;min-width:0;padding-top:4px}
.why{color:var(--soft);font:500 12px/1.35 var(--sans);margin-bottom:3px}
.txt{font:500 14px/20px var(--sans);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.acts{display:flex;align-items:center;gap:2px;flex:none}
.cb{position:relative;font:600 13px/1 var(--sans);border:0;background:transparent;color:var(--accent);min-width:28px;height:28px;padding:0 8px;cursor:pointer;border-radius:8px}
.cb:hover{color:var(--text)}
.cb:focus{outline:none}
.cb:focus-visible::after{content:"";position:absolute;left:8px;right:8px;bottom:3px;height:1.5px;border-radius:1px;background:currentColor}
.cb.x{color:var(--soft);padding:0}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--danger);margin:10px 2px 0 0}
@media (prefers-reduced-motion:reduce){#t{animation:none}}
/* Frosted: Windows blurs what is behind the window, so the glass only tints it, at the system's corner radius. */
html.frost{--glass:rgba(20,20,26,.4)}
@media (prefers-color-scheme:light){html.frost{--glass:rgba(255,255,255,.6)}}
html.frost #t{border-radius:8px;min-height:100vh}
</style></head><body><div id="t" role="status" aria-live="polite">${body}<button class="cb x" id="x" type="button" aria-label="Close">✕</button></div></div>
<script>
const {ipcRenderer}=typeof require==='function'?require('electron'):{ipcRenderer:{send(){}}};
const t=document.getElementById('t');
for(const [id,act] of [['discard','discard'],['copy','copy'],['x','close']]){const b=document.getElementById(id);if(b)b.onclick=()=>{if(act==='copy')b.textContent='Copied';ipcRenderer.send('baton-toast:act',act);};}
t.onmouseenter=()=>ipcRenderer.send('baton-toast:act','hover');t.onmouseleave=()=>ipcRenderer.send('baton-toast:act','leave');
</script></body></html>`;
};

export interface VocabToast {
  /** A word was learned; words arriving close together share one card. */
  readonly add: (word: string) => void;
  /** Shows this card in place of any other. */
  readonly show: (card: Card) => void;
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
  };
  const show = (card: Card) => {
    close();
    shown = card;
    const at = input.anchor();
    const area = Electron.screen.getDisplayMatching(at).workArea;
    const x = Math.min(
      Math.max(Math.round(at.x + at.width / 2 - WIDTH / 2), area.x),
      area.x + area.width - WIDTH,
    );
    const place = (height: number) => {
      const above = at.y - height - GAP;
      return {
        x,
        y:
          above >= area.y ? above : Math.min(at.y + at.height + GAP, area.y + area.height - height),
        width: WIDTH,
        height,
      };
    };
    const frosted = input.frosted?.() === true;
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
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cardDocument(card, frosted))}`)
      .then(() => win.webContents.executeJavaScript("document.getElementById('t').offsetHeight"))
      .then((height: unknown) => {
        if (win.isDestroyed()) return;
        if (typeof height === "number" && height > 0) win.setBounds(place(Math.ceil(height)));
        win.showInactive();
      })
      .catch(() => undefined);
    releaseEscape = input.holdEscape?.(close) ?? null;
    leaveIn(LEAVE_MS);
  };

  Electron.ipcMain.on("baton-toast:act", (event, act: unknown) => {
    if (window === null || event.sender !== window.webContents) return;
    const card = shown;
    if (act === "hover") return stopLeave();
    if (act === "leave") return leaveIn(LEAVE_MS);
    if (act === "copy") {
      if (card !== null && card.kind !== "learned" && card.text !== undefined)
        Electron.clipboard.writeText(card.text);
      return;
    }
    close();
    if (act === "discard" && card?.kind === "learned") input.onDiscard(card.words);
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
    dispose: () => {
      if (batchTimer !== null) clearTimeout(batchTimer);
      close();
    },
  };
};
