// @effect-diagnostics globalTimers:off
/**
 * PILL-V2 "D": his words drawn as ghost text at the caret of the field they will land in. The paste never waits for
 * it: the cleaned words land at once and the ghost goes as they do (`stop`). A click-through
 * window that never takes focus and stays out of screen sharing. With no caret to draw at, the pill shows them (E).
 */
import * as Electron from "electron";

import { protectFromCapture } from "../captureProtection.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import { applyLookScript, lookClasses, type Glass, type Motion } from "../home/look.ts";
import { wordsScript } from "./pillIsland.ts";

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
/** What the sidecar reads at the caret, in physical screen pixels; the font size in points (0: not said). */
export type CaretGeometry = {
  readonly caret: Box;
  readonly field: Box;
  readonly fontPt: number;
  /** The field's font family as UI Automation names it; absent when it does not say. */
  readonly fontName?: string;
  /** The words before the caret run right to left. */
  readonly rtl?: boolean;
};

/** Lines of his field the ghost may cover above the caret and below it; a taller field scrolls inside this. */
const ABOVE = 12;
const BELOW = 30;
/** A field's text sits a little inside its box; the field does not say how far. */
const INSET = 8;
/** Narrower than this many average characters, or shorter than two lines, the field is no place to flow his words. */
const MIN_CHARS = 24;

/**
 * Where the ghost window goes and how it sets its words, in DIP; why not when there is no sensible place (the pill shows
 * them, and the turn log says why). The window is the field's text box, so his words wrap at the field's width, not
 * from the caret, and scroll up from its bottom edge; `top` is how far down that box the caret's line is.
 */
export const ghostPlacement = (g: CaretGeometry) => {
  // The ghost lays words out left to right only.
  if (g.rtl === true) return { why: "rtl" };
  const guessedFont = g.fontPt > 0 ? Math.round((g.fontPt * 4) / 3) : 0;
  // An empty field's caret is a sliver a few px tall: its font says how tall the line is, and the line sits as far
  // below the field's top as the caret sits in from its left (the field's padding).
  const sliver = guessedFont > 0 && g.caret.height < guessedFont;
  const line = sliver ? Math.round(guessedFont * 1.4) : Math.round(g.caret.height);
  const caretY = sliver ? g.field.y + Math.max(0, g.caret.x - g.field.x) : g.caret.y;
  const fontPx = guessedFont > 0 ? guessedFont : Math.round(line * 0.72);
  // The text's left edge is never right of the caret: a field with a slim padding puts it there.
  const left = Math.min(g.field.x + INSET, g.caret.x);
  const width = Math.round(g.field.x + g.field.width - INSET - left);
  const indent = Math.round(g.caret.x - left);
  const boxTop = Math.round(Math.max(g.field.y, caretY - ABOVE * line));
  const boxBottom = Math.round(Math.min(g.field.y + g.field.height, caretY + BELOW * line));
  const top = Math.round(caretY) - boxTop;
  const height = boxBottom - boxTop;
  if (line < 8 || line > 80) return { why: `caret line ${line}px` };
  if (g.caret.x < g.field.x || indent > width || top < 0 || top + line > height + line / 2)
    return { why: "caret outside the field" };
  if (width < Math.max(120, fontPx * 0.5 * MIN_CHARS)) return { why: `field ${width}px wide` };
  if (height < 2 * line) return { why: `field ${height}px tall, one line` };
  return {
    bounds: { x: Math.round(left), y: boxTop, width, height },
    // A name that could break out of the CSS string is dropped; the default stack stands in.
    font: /^[\w .-]{1,64}$/.test(g.fontName ?? "") ? (g.fontName as string) : null,
    empty: sliver,
    fontPx,
    linePx: line,
    width,
    indent,
    top,
    height,
  };
};

const GHOST_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--field-bg:#1f1f23;--field-ink:#e9e9ee;--ghost:rgba(233,233,238,.84);--ghost-drop:rgba(233,233,238,.5);--sans:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:light){:root{--field-bg:#fff;--field-ink:#17181b;--ghost:rgba(23,24,27,.82);--ghost-drop:rgba(23,24,27,.5)}}
html,body{margin:0;height:100%;overflow:hidden;background:transparent;-webkit-font-smoothing:antialiased}
#vp{position:absolute;left:0;top:0;pointer-events:none}
#vp span{position:absolute;left:0;top:0;white-space:pre;text-decoration:underline dotted color-mix(in srgb,currentColor 55%,transparent);text-underline-offset:4px}
#vp span.m span{position:static}
#vp span.m .slot{position:relative;display:inline-block;vertical-align:top;height:1em}
#vp span.m .g{position:absolute;left:0;top:0;transform-origin:0 85%}
#mE{position:absolute;visibility:hidden;left:0;top:0}
#cr{position:absolute;left:0;top:0;width:1.5px;background:var(--field-ink);opacity:0}
#bg{position:absolute;inset:0;background:var(--field-bg);opacity:0;border-radius:4px}
#mE span{display:inline-block;vertical-align:top;white-space:pre}
</style></head><body><div id="bg" aria-hidden="true"></div><div id="vp" aria-hidden="true"></div><div id="mE" aria-hidden="true"></div><script>
const $=i=>document.getElementById(i);
const reduce=matchMedia('(prefers-reduced-motion:reduce)'),root=document.documentElement.classList;
const isCalm=()=>reduce.matches||root.contains('motion-reduced')||root.contains('motion-off');
${wordsScript("D")}
window.ghost={start(f){EMPTY=f.empty;if(f.font)document.documentElement.style.setProperty('--sans','"'+f.font+'",'+getComputedStyle(document.documentElement).getPropertyValue('--sans'));setField(f.fontPx,f.linePx,f.width,f.indent,f.top,f.height);island.start();},words(t){island.words(t);},release(){island.release();},stop(){island.stop();}};
</script></body></html>`;

export interface PillGhost {
  /** Opens the ghost at this caret; why not when there is nowhere sensible to draw (the pill shows the words). */
  readonly start: (geometry: CaretGeometry) => { readonly why: string } | null;
  readonly active: () => boolean;
  readonly words: (text: string) => void;
  /** His ✓ or the key's release. */
  readonly release: () => void;
  readonly stop: () => void;
}

export const createPillGhost = (input: {
  readonly look: () => { readonly motion: Motion; readonly glass: Glass };
  /** The sidecar's boxes are physical pixels only on Windows. */
  readonly windows: boolean;
}): PillGhost => {
  let window: Electron.BrowserWindow | null = null;
  let ready: Promise<unknown> = Promise.resolve();
  const live = () => window !== null && !window.isDestroyed();
  const call = (code: string): Promise<unknown> => {
    const target = window;
    return ready.then(() =>
      target !== null && !target.isDestroyed()
        ? target.webContents
            .executeJavaScript(
              `${applyLookScript(lookClasses(input.look().motion, input.look().glass))};${code}`,
            )
            .catch(() => null)
        : null,
    );
  };
  const stop = () => {
    if (live()) window!.destroy();
    window = null;
  };
  return {
    start: (geometry) => {
      stop();
      const scale = (b: Box) => (input.windows ? Electron.screen.screenToDipRect(null, b) : b);
      const placed = ghostPlacement({
        caret: scale(geometry.caret),
        field: scale(geometry.field),
        fontPt: geometry.fontPt,
      });
      if (placed.why !== undefined) return { why: placed.why };
      const win = new Electron.BrowserWindow({
        ...placed.bounds,
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
      window = win;
      ready = win
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(GHOST_DOCUMENT)}`)
        .then(() => {
          if (!win.isDestroyed()) win.showInactive();
        })
        .catch(() => undefined);
      void call(
        `window.ghost.start(${JSON.stringify({ fontPx: placed.fontPx, linePx: placed.linePx, width: placed.width, indent: placed.indent, top: placed.top, height: placed.height, font: placed.font, empty: placed.empty })})`,
      );
      return null;
    },
    active: live,
    words: (text) => void call(`window.ghost.words(${JSON.stringify(text)})`),
    release: () => void call("window.ghost.release()"),
    stop,
  };
};
