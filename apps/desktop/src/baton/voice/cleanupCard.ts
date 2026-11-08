// @effect-diagnostics globalTimers:off
/**
 * The moment after ✓: what he said, in grey, above the pill; the words kept turn white, the fillers and the false start
 * stay grey and blur away, and the clean sentence settles (GB-2, about 1.6 s), then it is pasted. Never takes focus,
 * stays out of screen sharing; with motion reduced or off it shows the clean text only.
 */
import * as Electron from "electron";

import { protectFromCapture } from "../captureProtection.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";

const WIDTH = 470;
const GAP = 10;
const LINE_PX = 19;
const CHARS_PER_LINE = 58;
export const CLEANUP_SHOW_MS = 1_600;
const REDUCED_SHOW_MS = 700;
/** shortcut: a long dictation is pasted with no preview; upgrade by animating only its last lines. */
const MAX_WORDS = 60;

const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Each word he said, and whether the clean text kept it (a longest common run of words, case and marks aside). */
export const cleanupMarks = (
  raw: string,
  clean: string,
): ReadonlyArray<{ readonly word: string; readonly kept: boolean }> => {
  const said = raw.trim().split(/\s+/).filter(Boolean);
  const kept = clean.trim().split(/\s+/).filter(Boolean).map(bare);
  const a = said.map(bare);
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(kept.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = kept.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === kept[j] && a[i] !== ""
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: Array<{ word: string; kept: boolean }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length) {
    // On a tie the later of two equal words is the one kept ("…and a rocket launcher. No. A mustache comb": the
    // retracted span takes its "a" with it, as in the Googlebook frames t067.8 and t069.0).
    if (j < kept.length && a[i] === kept[j] && a[i] !== "" && table[i + 1]![j]! < table[i]![j]!) {
      out.push({ word: said[i]!, kept: true });
      i += 1;
      j += 1;
    } else if (j < kept.length && table[i]![j + 1]! > table[i + 1]![j]!) j += 1;
    else {
      out.push({ word: said[i]!, kept: false });
      i += 1;
    }
  }
  return out;
};

const esc = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const cleanupDocument = (raw: string, clean: string, animate: boolean): string => {
  const words = cleanupMarks(raw, clean)
    .map((m) => `<span class="${m.kept ? "k" : "r"}">${esc(m.word)} </span>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--ink:#0d0d11;--line:rgba(255,255,255,.14);--text:#f6f6f8;--soft:#8a8a95;
--sans:"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
html,body{height:100%;margin:0;overflow:hidden;background:transparent;font:500 13px/${LINE_PX}px var(--sans);-webkit-font-smoothing:antialiased;cursor:default}
#c{box-sizing:border-box;padding:10px 14px;border-radius:12px;background:var(--ink);border:1px solid var(--line);color:var(--soft)}
#c span{display:inline-block;white-space:pre;transition:color .35s ease,opacity .4s ease,filter .4s ease,max-width .4s ease;max-width:30em;overflow:hidden;vertical-align:bottom}
#c.keep .k{color:var(--text)}
#c.blur .r{opacity:0;filter:blur(4px)}
#c.flow .r{max-width:0}
#f{display:none;color:var(--text);white-space:pre-wrap}
#c.done #w{display:none}#c.done #f{display:block}
@media (prefers-reduced-motion:reduce){#c span{transition:none}}
</style></head><body><div id="c" class="${animate ? "" : "done"}" role="status" aria-live="polite"><div id="w">${words}</div><div id="f">${esc(clean)}</div></div>
<script>${animate ? "const c=document.getElementById('c');setTimeout(()=>c.classList.add('keep'),250);setTimeout(()=>c.classList.add('blur'),700);setTimeout(()=>c.classList.add('flow'),1050);setTimeout(()=>c.classList.add('done'),1450);" : ""}</script></body></html>`;
};

/** Shows the card above `anchor` and resolves when it has played (it then goes by itself). */
export const showCleanup = (input: {
  readonly anchor: Electron.Rectangle;
  readonly raw: string;
  readonly clean: string;
  /** "full" plays it; "reduced" shows the clean text a moment; "off" shows nothing and keeps no one waiting. */
  readonly motion: "full" | "reduced" | "off";
}): Promise<void> => {
  const words = input.raw.trim().split(/\s+/).filter(Boolean).length;
  if (
    input.motion === "off" ||
    words === 0 ||
    words > MAX_WORDS ||
    input.raw.trim() === input.clean.trim()
  )
    return Promise.resolve();
  const animate = input.motion === "full";
  const lines = Math.ceil(Math.max(input.raw.length, input.clean.length) / CHARS_PER_LINE);
  const height = 22 + lines * LINE_PX;
  const area = Electron.screen.getDisplayMatching(input.anchor).workArea;
  const x = Math.min(
    Math.max(Math.round(input.anchor.x + input.anchor.width / 2 - WIDTH / 2), area.x),
    area.x + area.width - WIDTH,
  );
  const above = input.anchor.y - height - GAP;
  const y = above >= area.y ? above : input.anchor.y + input.anchor.height + GAP;
  const win = new Electron.BrowserWindow({
    x,
    y,
    width: WIDTH,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  markCompanionWindow(win);
  protectFromCapture(win);
  const ms = animate ? CLEANUP_SHOW_MS : REDUCED_SHOW_MS;
  return new Promise((resolve) => {
    void win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(cleanupDocument(input.raw, input.clean, animate))}`,
      )
      .then(() => {
        if (!win.isDestroyed()) win.showInactive();
      })
      .catch(() => undefined);
    setTimeout(() => {
      resolve();
      // A moment longer on screen than the wait, so the paste lands under the clean sentence.
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 400).unref();
    }, ms).unref();
  });
};
