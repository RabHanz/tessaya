// @effect-diagnostics globalTimers:off
/**
 * The two windows of the companion that take his hands: the ask box and the prompt that replaced
 * the system dialogs (D111). Both are inline pages of ours that never navigate, node is how they
 * hand back an answer, and words from a model only ever reach them as textContent.
 */
import { protectFromCapture } from "../captureProtection.ts";
import * as Electron from "electron";

import { markCompanionWindow } from "../lastAppWindow.ts";

import { PILL_FACES } from "../home/fonts.ts";
import {
  CARD_CSS,
  DEFAULT_LOOK,
  STICKERS,
  applyLookScript,
  lookAttributes,
  type PillLook,
} from "../voice/pillLook.ts";
import { onPillLook, pillLook, refreshPillTheme } from "../voice/pillTheme.ts";
import { MARK_REVERSED_PATH } from "../voice/trayArt.ts";
import { CARD_ABOVE_WORK_AREA, COMPANION_CSS } from "./companionStyle.ts";

export type AnswerOutput = "spoken" | "written";

const ASK_WIDTH = 640;
const ASK_HEIGHT = 124;
const PROMPT_WIDTH = 500;

export const ASK_DOCUMENT = (
  output: AnswerOutput,
) => `<!doctype html><html><head><meta charset="utf-8"><style>${COMPANION_CSS}
html,body{overflow:hidden;height:100%}
body{display:flex;padding:12px;box-sizing:border-box}
form{flex:1;display:flex;flex-direction:column;gap:9px;padding:13px 16px 11px;border-radius:16px;box-sizing:border-box}
input{all:unset;color:var(--text);font-size:17px;line-height:26px;-webkit-user-select:text;user-select:text;cursor:text}
input::placeholder{color:var(--faint)}
footer{display:flex;align-items:center;gap:12px;color:var(--soft);font-size:12.5px}
kbd{font:600 11.5px var(--sans);color:var(--text);padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.1)}
.seg{margin-left:auto;display:flex;padding:2px;border-radius:8px;background:rgba(255,255,255,.08)}
.seg button{all:unset;padding:3px 10px;border-radius:6px;color:var(--soft);font-size:12.5px;cursor:default}
.seg button[aria-pressed=true]{background:rgba(255,255,255,.17);color:var(--text)}
.seg button:focus-visible{outline:2px solid var(--blue-soft)}
</style></head><body><form id="f" class="glass"><input id="q" autofocus placeholder="Ask Tessaya anything" aria-label="Ask Tessaya anything" spellcheck="false">
<footer><span><kbd>Enter</kbd> ask</span><span><kbd>Esc</kbd> close</span>
<div class="seg" role="group" aria-label="How Tessaya answers"><button type="button" data-v="spoken">Spoken and written</button><button type="button" data-v="written">Written only</button></div></footer></form>
<script>const {ipcRenderer}=require('electron');const q=document.getElementById('q');
const marks=(v)=>document.querySelectorAll('.seg button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===v)));
marks(${JSON.stringify(output)});
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{marks(b.dataset.v);ipcRenderer.send('baton-screen:output',b.dataset.v);q.focus();});
document.getElementById('f').onsubmit=e=>{e.preventDefault();ipcRenderer.send('baton-screen:ask',q.value);};
addEventListener('keydown',e=>{if(e.key==='Escape')ipcRenderer.send('baton-screen:ask','');});</script></body></html>`;

const MARK = `<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="${MARK_REVERSED_PATH}"/></svg>`;

/** The prompt that replaced the system dialogs, in the pill's design and the app's theme (pillLook.ts). */
export const promptDocument = (
  look: PillLook = DEFAULT_LOOK,
) => `<!doctype html><html ${lookAttributes(look)}><head><meta charset="utf-8"><style>${PILL_FACES[look.design]}${CARD_CSS}
html,body{overflow:hidden}
/* As wide as its words up to the design's card width; a short shadow, so the window's margin around it stays small. */
#b{width:fit-content;min-width:260px;max-width:350px;padding:16px}
:root[data-design=quiet] #b{max-width:340px}
h1{margin:0;font-size:20px;font-weight:var(--w-ttl);letter-spacing:-.015em;line-height:25px}
:root[data-design=lively] h1{font-variation-settings:"opsz" 28;letter-spacing:-.01em}
p{margin:4px 0 0;font-size:16px;line-height:21px;color:var(--fg2);white-space:pre-line;overflow-wrap:anywhere;max-height:320px;overflow:auto}
:root[data-design=lively] p{margin:6px 0 0;line-height:22px}
.hd{align-items:flex-start}.hd .gl{margin-top:4px}.hd .gl svg{width:16px;height:16px}
nav{display:flex;flex-direction:row-reverse;flex-wrap:wrap;justify-content:flex-start;gap:6px;margin-top:14px}
:root[data-design=quiet] nav{gap:4px}:root[data-design=lively] nav{margin-top:16px}
</style></head><body><div id="wrap"><div id="b" class="card stk" role="alertdialog" aria-labelledby="h" aria-describedby="d"><span class="sticker" style="clip-path:${STICKERS.bloom}" aria-hidden="true">${MARK}</span><div class="hd"><span class="gl">${MARK}</span><div class="grow"><h1 id="h"></h1><p id="d"></p></div></div><nav id="n"></nav></div></div>
<script>const {ipcRenderer}=require('electron');
window.fill=(o)=>{document.getElementById('h').textContent=o.title;document.getElementById('d').textContent=o.detail;const n=document.getElementById('n'),lively=document.documentElement.dataset.design==='lively';
 // The first is the default and sits rightmost; the cancel is plain words; any other is a quiet button.
 o.buttons.forEach((text,i)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.className=i===0?'b pri':i===o.cancel?'b txt':lively?'b ton':'b';b.onclick=()=>ipcRenderer.send('baton-screen:prompt',i);n.appendChild(b);});
 addEventListener('keydown',e=>{if(e.key==='Escape')ipcRenderer.send('baton-screen:prompt',o.cancel);});
 const d=document.getElementById('d'),m=n.firstChild,more=()=>d.scrollHeight-d.scrollTop-d.clientHeight>2;
 let armed=!o.armMs;const ready=()=>{if(armed&&!more())m.disabled=false;};
 if(o.armMs)setTimeout(()=>{armed=true;ready();},o.armMs);
 if(more()||o.armMs){m.disabled=true;d.tabIndex=0;d.focus();d.addEventListener('scroll',ready);}else m.focus();
 const r=document.getElementById('wrap').getBoundingClientRect();return [Math.ceil(r.width),Math.ceil(r.height)];};</script></body></html>`;

export interface PromptInput {
  readonly title: string;
  readonly detail: string;
  /** The first is the default. */
  readonly buttons: ReadonlyArray<string>;
  /** Esc, the box being closed some other way, or running out of time. */
  readonly cancel: number;
  readonly expiresMs?: number;
  /** It came unasked: no default focus, and its yes stays disabled this long. */
  readonly armMs?: number;
  /** Belongs to the lesson or drive: it goes when that ends. */
  readonly scoped?: boolean;
  /** Asked mid-task: it never takes the keyboard, so keys and the window being worked on stay put. Mouse, voice or phone answer it. */
  readonly inactive?: boolean;
}

/** A prompt nobody answers must not block the next one, and an old yes must not stand ready. */
const PROMPT_EXPIRY_MS = 60_000;

const companionWindow = (bounds: Electron.Rectangle, focusable = true): Electron.BrowserWindow => {
  const win = new Electron.BrowserWindow({
    ...bounds,
    focusable,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // These pages have Node: only the page written here may ever load in them.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  markCompanionWindow(win);
  win.setAlwaysOnTop(true, "screen-saver");
  protectFromCapture(win);
  return win;
};

const cursorArea = () =>
  Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).workArea;

/** One at a time: a second question waits for the first. */
export const createCompanionWindows = (input: {
  readonly output: () => AnswerOutput;
  readonly setOutput: (output: AnswerOutput) => void;
  readonly onAsk: (text: string) => void;
}) => {
  let askBox: Electron.BrowserWindow | null = null;
  let promptBox: {
    win: Electron.BrowserWindow;
    done: (index: number) => void;
    cancel: number;
    scoped: boolean;
  } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const closeAsk = () => {
    if (askBox !== null && !askBox.isDestroyed()) askBox.destroy();
    askBox = null;
  };
  const ownedAsk = (event: Electron.IpcMainEvent) =>
    askBox !== null && event.sender === askBox.webContents;
  const onAskIpc = (event: Electron.IpcMainEvent, text: unknown) => {
    if (!ownedAsk(event)) return;
    closeAsk();
    if (typeof text === "string" && text.trim().length > 0) input.onAsk(text.trim());
  };
  const onOutputIpc = (event: Electron.IpcMainEvent, value: unknown) => {
    if (ownedAsk(event) && (value === "spoken" || value === "written")) input.setOutput(value);
  };
  const onPromptIpc = (event: Electron.IpcMainEvent, index: unknown) => {
    if (promptBox === null || event.sender !== promptBox.win.webContents) return;
    if (typeof index === "number") promptBox.done(index);
  };
  Electron.ipcMain.on("baton-screen:ask", onAskIpc);
  Electron.ipcMain.on("baton-screen:output", onOutputIpc);
  Electron.ipcMain.on("baton-screen:prompt", onPromptIpc);
  const openAsk = () => {
    if (askBox !== null && !askBox.isDestroyed()) return askBox.focus();
    const area = cursorArea();
    const box = companionWindow({
      x: Math.round(area.x + (area.width - ASK_WIDTH) / 2),
      y: Math.round(area.y + area.height * 0.26),
      width: ASK_WIDTH,
      height: ASK_HEIGHT,
    });
    askBox = box;
    box.on("blur", () => {
      if (!box.isDestroyed()) box.destroy();
      if (askBox === box) askBox = null;
    });
    void box
      .loadURL(`data:text/html,${encodeURIComponent(ASK_DOCUMENT(input.output()))}`)
      .then(() => {
        if (box.isDestroyed()) return;
        box.show();
        box.focus();
        box.webContents.focus();
      });
  };

  const ask = (options: PromptInput): Promise<number> => {
    const turn = queue.then(
      () =>
        new Promise<number>((resolve) => {
          const area = cursorArea();
          void refreshPillTheme();
          const win = companionWindow(
            {
              x: Math.round(area.x + (area.width - PROMPT_WIDTH) / 2),
              y: area.y,
              width: PROMPT_WIDTH,
              height: 200,
            },
            options.inactive !== true,
          );
          const expiry = setTimeout(
            () => done(options.cancel),
            options.expiresMs ?? PROMPT_EXPIRY_MS,
          );
          const done = (index: number) => {
            clearTimeout(expiry);
            // First: destroying fires "closed", which would answer Cancel over his yes.
            resolve(index);
            if (promptBox?.win === win) promptBox = null;
            if (!win.isDestroyed()) win.destroy();
          };
          promptBox = { win, done, cancel: options.cancel, scoped: options.scoped === true };
          win.on("closed", () => done(options.cancel));
          void win
            .loadURL(`data:text/html,${encodeURIComponent(promptDocument(pillLook()))}`)
            .then(() =>
              win.webContents.executeJavaScript(`window.fill(${JSON.stringify(options)})`),
            )
            .then(([wide, height]: [number, number]) => {
              if (win.isDestroyed()) return;
              // A long plan scrolls inside the box; the buttons stay on the screen.
              const tall = Math.min(Math.ceil(height), area.height - 120);
              const width = Math.min(PROMPT_WIDTH, Math.ceil(wide));
              win.setBounds({
                x: Math.round(area.x + (area.width - width) / 2),
                y: Math.round(area.y + area.height - tall - CARD_ABOVE_WORK_AREA),
                width,
                height: tall,
              });
              if (options.inactive === true) return win.showInactive();
              win.show();
              win.focus();
              win.webContents.focus();
            })
            .catch(() => done(options.cancel));
        }),
    );
    queue = turn.catch(() => undefined);
    return turn;
  };

  const stopLook = onPillLook((look) => {
    const win = promptBox?.win;
    if (win !== undefined && !win.isDestroyed())
      void win.webContents.executeJavaScript(applyLookScript(look)).catch(() => undefined);
  });

  return {
    openAsk,
    ask,
    /** Scoped prompts come down with their lesson or drive; `force` also takes down one the phone just answered. */
    closePrompt: (force = false) => {
      if (promptBox !== null && (force || promptBox.scoped)) promptBox.done(promptBox.cancel);
    },
    dispose: () => {
      stopLook();
      closeAsk();
      promptBox?.done(promptBox.cancel);
      Electron.ipcMain.removeListener("baton-screen:ask", onAskIpc);
      Electron.ipcMain.removeListener("baton-screen:output", onOutputIpc);
      Electron.ipcMain.removeListener("baton-screen:prompt", onPromptIpc);
    },
  };
};
