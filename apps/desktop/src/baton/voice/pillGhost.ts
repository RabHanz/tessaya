// @effect-diagnostics globalTimers:off
/**
 * PILL-V2 "D": his words drawn as ghost text at the caret of the field they will land in, then the same cleanup
 * played in place; the paste lands as the ghost goes, and any key or click skips straight to it. A click-through
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
export type CaretGeometry = { readonly caret: Box; readonly field: Box; readonly fontPt: number };

/** Lines of his field the ghost may cover above the caret and below it; a taller field scrolls inside this. */
const ABOVE = 12;
const BELOW = 30;
/** A field's text sits a little inside its box; the field does not say how far. */
const INSET = 8;
/** Narrower than this many average characters, or shorter than two lines, the field is no place to flow his words. */
const MIN_CHARS = 24;
/** How often a key or click is looked for while the ghost plays. */
const SKIP_POLL_MS = 50;

/**
 * Where the ghost window goes and how it sets its words, in DIP; null when there is no sensible place (the pill shows
 * them). The window is the field's text box, so his words wrap at the field's width, not from the caret, and scroll
 * up from its bottom edge; `top` is how far down that box the caret's line is.
 */
export const ghostPlacement = (g: CaretGeometry) => {
  const line = Math.round(g.caret.height);
  const left = g.field.x + INSET;
  const width = Math.round(g.field.width - 2 * INSET);
  const indent = Math.round(g.caret.x - left);
  const fontPx = g.fontPt > 0 ? Math.round((g.fontPt * 4) / 3) : Math.round(line * 0.72);
  const boxTop = Math.round(Math.max(g.field.y, g.caret.y - ABOVE * line));
  const boxBottom = Math.round(Math.min(g.field.y + g.field.height, g.caret.y + BELOW * line));
  const top = Math.round(g.caret.y) - boxTop;
  const height = boxBottom - boxTop;
  if (line < 8 || line > 80 || indent < 0 || indent > width) return null;
  if (
    width < Math.max(120, fontPx * 0.5 * MIN_CHARS) ||
    height < 2 * line ||
    top < 0 ||
    top + line > height + line / 2
  )
    return null;
  return {
    bounds: { x: Math.round(left), y: boxTop, width, height },
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
window.ghost={start(f){setField(f.fontPx,f.linePx,f.width,f.indent,f.top,f.height);island.start();},words(t){island.words(t);},release(){island.release();},cleanup(r,c){return island.cleanup(r,c);},stop(){island.stop();}};
</script></body></html>`;

export interface PillGhost {
  /** Opens the ghost at this caret; false when there is nowhere sensible to draw (the pill shows the words). */
  readonly start: (geometry: CaretGeometry) => boolean;
  readonly active: () => boolean;
  readonly words: (text: string) => void;
  /** His ✓ or the key's release. */
  readonly release: () => void;
  /**
   * Plays the cleanup in place and resolves when the paste should land: as the ghost goes, or at once on a key or
   * click. False when the ghost was not up (nothing waited).
   */
  readonly play: (raw: string, clean: string) => Promise<boolean>;
  /** A key he pressed is waiting for the paste: the play ends at once, now or as soon as it starts. */
  readonly skip: () => void;
  readonly stop: () => void;
}

export const createPillGhost = (input: {
  readonly look: () => { readonly motion: Motion; readonly glass: Glass };
  /** The system's last-input tick (a key, a click or a move); null when it cannot say. */
  readonly lastInput: () => Promise<number | null>;
  /** The sidecar's boxes are physical pixels only on Windows. */
  readonly windows: boolean;
}): PillGhost => {
  let window: Electron.BrowserWindow | null = null;
  let ready: Promise<unknown> = Promise.resolve();
  const live = () => window !== null && !window.isDestroyed();
  let keyWaiting = false;
  let onKey: (() => void) | null = null;
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
  /**
   * A click or key while the ghost plays pastes at once: the tick moved while the pointer stayed put (a move alone is
   * not a skip). Edge: a plain key (Enter included) still reaches the field just before the paste; no hook swallows it.
   */
  const skipped = (stopAt: Promise<void>) =>
    new Promise<void>((resolve) => {
      let done = false;
      void stopAt.then(() => (done = true));
      void input.lastInput().then((first) => {
        if (first === null) return;
        let cursor = Electron.screen.getCursorScreenPoint();
        const look = () => {
          if (done) return;
          void input.lastInput().then((tick) => {
            const now = Electron.screen.getCursorScreenPoint();
            const moved = now.x !== cursor.x || now.y !== cursor.y;
            cursor = now;
            if (tick !== null && tick !== first && !moved) return resolve();
            if (moved && tick !== null) first = tick;
            setTimeout(look, SKIP_POLL_MS).unref();
          });
        };
        setTimeout(look, SKIP_POLL_MS).unref();
      });
    });
  return {
    start: (geometry) => {
      stop();
      keyWaiting = false;
      const scale = (b: Box) => (input.windows ? Electron.screen.screenToDipRect(null, b) : b);
      const placed = ghostPlacement({
        caret: scale(geometry.caret),
        field: scale(geometry.field),
        fontPt: geometry.fontPt,
      });
      if (placed === null) return false;
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
        `window.ghost.start(${JSON.stringify({ fontPx: placed.fontPx, linePx: placed.linePx, width: placed.width, indent: placed.indent, top: placed.top, height: placed.height })})`,
      );
      return true;
    },
    active: live,
    words: (text) => void call(`window.ghost.words(${JSON.stringify(text)})`),
    release: () => void call("window.ghost.release()"),
    play: async (raw, clean) => {
      if (!live()) return false;
      const target = window;
      const ms = await call(
        `window.ghost.cleanup(${JSON.stringify(raw)},${JSON.stringify(clean)})`,
      );
      const fade = 300;
      const total = typeof ms === "number" ? Math.min(ms, 3_000) : 0;
      let end = () => undefined as void;
      const over = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, total - fade));
        t.unref();
        end = resolve;
      });
      const key = new Promise<boolean>((resolve) => {
        onKey = () => resolve(true);
        if (keyWaiting) resolve(true);
      });
      const skip = await Promise.race([
        over.then(() => false),
        skipped(over).then(() => true),
        key,
      ]);
      onKey = null;
      keyWaiting = false;
      end();
      // The words land under the ghost as it fades; a skip takes it away at once.
      setTimeout(
        () => {
          if (window === target) stop();
        },
        skip || total <= fade ? 0 : fade,
      ).unref();
      return true;
    },
    skip: () => {
      keyWaiting = true;
      onKey?.();
    },
    stop,
  };
};
