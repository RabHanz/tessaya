/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalTimers:off
/**
 * The click-through layer the companion draws on (D84, D111): farzaa/clicky's pointer and bezier
 * flight, its label, and the answer card riding beside the pointer. Nothing is drawn round the
 * control itself: a pointer and words, never an inspector's box (CU-1). Pointer
 * and card share one display at a time, the stage, so neither can wipe the other. One window per
 * display, kept out of screenshots by content protection (Windows, macOS) or hidden for the
 * capture (Linux). Windows go after two idle minutes, so this layer never stops the app quitting.
 */
import { hiddenForCapture, protectFromCapture } from "../captureProtection.ts";
import * as Electron from "electron";

import { markCompanionWindow } from "../lastAppWindow.ts";

import { loadDocument } from "../voice/loadDocument.ts";
import { CARD_ABOVE_WORK_AREA, COMPANION_CSS } from "./companionStyle.ts";

export const OVERLAY_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>${COMPANION_CSS}
html,body{width:100%;height:100%;overflow:hidden;font-size:15px}
:root{--tz-dye:#14505A;--tz-glow:#5FB3B3;--tz-ink:#0B2A30}
#ptr{position:absolute;left:0;top:0;width:24px;height:26px;margin:-13px 0 0 -12px;opacity:0;transition:opacity .22s;filter:drop-shadow(0 0 8px var(--tz-glow)) drop-shadow(0 1px 2px rgba(0,0,0,.5));will-change:transform}
#ptr.on{opacity:1}
#trail{position:absolute;left:0;top:0;height:3px;border-radius:2px;transform-origin:0 50%;background:linear-gradient(90deg,transparent,var(--tz-glow));opacity:0;pointer-events:none}
#trail.on{opacity:.55;transition:none}#trail.fade{opacity:0;transition:opacity .4s}
#tag{position:absolute;left:0;top:0;padding:4px 10px;border-radius:999px;background:var(--tz-dye);color:#fff;font-weight:600;font-size:13px;line-height:18px;white-space:nowrap;opacity:0;box-shadow:0 0 0 1px rgba(255,255,255,.35) inset,0 2px 8px rgba(0,0,0,.35);transition:opacity .3s}
#tag.on{opacity:1}
#card{position:absolute;left:0;top:0;box-sizing:border-box;width:560px;max-width:calc(100vw - 32px);padding:13px 16px 14px;border-radius:14px;opacity:0;line-height:1.48;overflow:hidden;transition:opacity .2s,left .28s cubic-bezier(.2,.8,.3,1),top .28s cubic-bezier(.2,.8,.3,1)}
#card.on{opacity:1}
#card.beside{width:400px}
#top{display:flex;align-items:center;gap:8px;min-height:18px;margin-bottom:4px;color:var(--blue-soft);font-size:12.5px;font-weight:600}
#dots{display:flex;gap:4px;margin-left:auto}
#next{margin-top:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--soft)}#next:empty{display:none}#next b{color:var(--text);font-weight:600}
#acts{margin-top:10px;display:flex;gap:8px;align-items:center}#acts:empty{display:none}
#acts button{all:unset;padding:5px 13px;border-radius:999px;background:rgba(255,255,255,.12);color:var(--text);font-size:13px;font-weight:600;cursor:default}
#acts button:hover{background:rgba(255,255,255,.22)}#acts button:focus-visible{outline:2px solid var(--tz-glow)}
#acts button.go{background:var(--tz-glow);color:var(--tz-ink)}
#acts em{margin-left:auto;font-style:normal;font-size:12px;color:var(--faint)}#acts kbd{border:1px solid rgba(255,255,255,.4);border-radius:4px;padding:0 5px;font:inherit}
#card.step{border:1px solid color-mix(in srgb,var(--tz-glow) 35%,transparent)}
#card.step #t{font-size:20px;font-weight:600;line-height:1.3}
#card.waiting #k{color:var(--tz-glow)}#card.error{border-color:rgba(217,150,43,.75)}#card.error #k{color:#F2B84B}#card.done{border-color:rgba(46,143,110,.85)}#card.done #k{color:#6FD1AE}
#bub{position:absolute;left:0;top:0;max-width:300px;padding:8px 12px;border-radius:10px;background:#2E8F6E;color:#fff;font-size:14px;line-height:1.35;box-shadow:0 4px 14px rgba(0,0,0,.35);opacity:0;transition:opacity .2s;pointer-events:none}#bub.on{opacity:1}
#cp{all:unset;margin-left:8px;padding:2px 9px;border-radius:999px;background:rgba(255,255,255,.12);color:var(--text);font-size:12px;font-weight:600;cursor:default}
#cp:hover{background:rgba(255,255,255,.22)}
#cp:focus-visible{outline:2px solid var(--blue-soft)}
#dots i{width:22px;height:4px;border-radius:2px;background:rgba(255,255,255,.22)}
#dots i.done{background:var(--tz-glow)}
#dots i.now{background:#fff}
#pg{color:var(--faint);font-weight:500;font-variant-numeric:tabular-nums}
#t{white-space:pre-line}
#h{margin-top:7px;color:var(--soft);font-size:12.5px}
#h:empty{display:none}
#bar{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--blue-soft);opacity:.55;transform-origin:0 0;transform:scaleX(0)}
@media (prefers-reduced-motion:reduce){#card,#ptr,#tag,#bub{transition:none}#trail{display:none}}
</style></head><body>
<div id="trail"></div>
<svg id="ptr" viewBox="0 0 24 26"><path d="M2.5 2.5 21 12 12 14 8.5 23.5Z" fill="#14505A" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>
<div id="tag"></div>
<div id="card" class="glass" role="status" aria-live="polite"><div id="top"><span id="k"></span><span id="pg"></span><span id="dots"></span><button id="cp" type="button" hidden>Copy</button></div><div id="t"></div><div id="h"></div><div id="next"></div><div id="acts"></div><i id="bar"></i></div><div id="bub"></div>
<script>
const $=i=>document.getElementById(i),ptr=$('ptr'),tag=$('tag'),card=$('card');
const calm=matchMedia('(prefers-reduced-motion:reduce)').matches;
let at={x:innerWidth/2,y:innerHeight/2},anim=0,landed=null,inset=72;
const place=(x,y,deg,s)=>{ptr.style.transform='translate('+x+'px,'+y+'px) rotate('+deg+'deg) scale('+s+')';};
const clamp=(v,a,b)=>Math.max(a,Math.min(v,b));
const placeTag=()=>{const r=tag.getBoundingClientRect(),x=at.x+15+r.width>innerWidth-12?at.x-r.width-15:at.x+15;tag.style.transform='translate('+x+'px,'+clamp(at.y+11,8,innerHeight-40)+'px)';};
const placeCard=()=>{const beside=landed!==null;card.classList.toggle('beside',beside);const w=card.offsetWidth,h=card.offsetHeight;let x,y;
 if(beside){x=clamp(landed.x+15,16,innerWidth-w-16);y=landed.y+50;if(y+h>innerHeight-inset)y=Math.max(16,landed.y-h-30);}
 else{x=(innerWidth-w)/2;y=innerHeight-inset-h;}
 card.style.left=x+'px';card.style.top=y+'px';};
const flight=(to,done,ms)=>{cancelAnimationFrame(anim);const s0={...at},d=Math.hypot(to.x-s0.x,to.y-s0.y);
 if(calm||d<1){at={...to};place(to.x,to.y,-35,1);return done();}
 const dur=ms||clamp(d/800,.6,1.4)*1000,c={x:(s0.x+to.x)/2,y:(s0.y+to.y)/2-Math.min(d*.2,80)},t0=performance.now();
 const step=(now)=>{const p=Math.min((now-t0)/dur,1),t=p*p*(3-2*p),u=1-t,
  x=u*u*s0.x+2*u*t*c.x+t*t*to.x,y=u*u*s0.y+2*u*t*c.y+t*t*to.y,
  tx=2*u*(c.x-s0.x)+2*t*(to.x-c.x),ty=2*u*(c.y-s0.y)+2*t*(to.y-c.y);
  at={x,y};place(x,y,p<1?Math.atan2(ty,tx)*180/Math.PI+90:-35,1+.3*Math.sin(Math.PI*p));
  if(p<1)anim=requestAnimationFrame(step);else{at={...to};done();}};
 anim=requestAnimationFrame(step);};
const label=(text)=>{tag.textContent=text||'';if(!text)return tag.classList.remove('on');placeTag();tag.classList.add('on');};
window.inset=(n)=>{inset=n;};
const hide=()=>tag.classList.remove('on');
// The trail is one line from where the pointer was to where it is going, drawn once and faded once: nothing repaints while it waits.
const trail=(a,b)=>{const t=$('trail'),d=Math.hypot(b.x-a.x,b.y-a.y);if(calm||d<40)return t.classList.remove('on','fade');
 t.style.cssText='left:'+a.x+'px;top:'+a.y+'px;width:'+d+'px;transform:rotate('+Math.atan2(b.y-a.y,b.x-a.x)+'rad)';t.classList.remove('fade');t.classList.add('on');};
const fadeTrail=()=>{const t=$('trail');if(t.classList.contains('on')){t.classList.remove('on');t.classList.add('fade');}};
window.fly=(from,to,text)=>{landed=null;if(from)at=from;ptr.classList.add('on');hide();place(at.x,at.y,-35,1);
 const spot={x:clamp(to.x+8,20,innerWidth-20),y:clamp(to.y+12,20,innerHeight-20)};
 trail({...at},spot);
 flight(spot,()=>{landed=spot;label(text);placeCard();setTimeout(fadeTrail,150);});};
// Her own cursor while she acts: a short glide to the target and its words, no trail and nothing round the control.
// It answers how long the glide takes, so the action can follow it.
window.glide=(to,text)=>{landed=null;const spot={x:clamp(to.x+8,20,innerWidth-20),y:clamp(to.y+12,20,innerHeight-20)};
 if(!ptr.classList.contains('on')){at={x:spot.x-70,y:spot.y+50};place(at.x,at.y,-35,1);ptr.classList.add('on');}
 hide();const ms=calm?0:Math.round(clamp(Math.hypot(spot.x-at.x,spot.y-at.y)/2200,.16,.4)*1000);
 flight(spot,()=>label(text),ms);return ms;};
window.fadeOut=()=>{cancelAnimationFrame(anim);hide();ptr.classList.remove('on');};
const acts=$('acts'),nextLine=$('next');
window.card=(c)=>{const on=!!(c&&(c.text||c.kicker));card.classList.toggle('on',on);if(!on)return;
 card.classList.toggle('step',!!(c.dots||c.state));for(const s of['waiting','error','done'])card.classList.toggle(s,c.state===s);
 $('k').textContent=c.kicker||'';$('t').textContent=c.text||'';$('h').textContent=c.hint||'';$('pg').textContent=c.page||'';$('cp').hidden=!c.text||!!c.state;
 nextLine.replaceChildren();(c.next||[]).forEach((s,i)=>{const e=document.createElement('span'),b=document.createElement('b');b.textContent=String((c.dots?c.dots.at+2:1)+i);e.append(b,' '+s);nextLine.appendChild(e);});
 acts.replaceChildren();if(c.actions&&c.actions.length){for(const a of c.actions){const b=document.createElement('button');b.type='button';b.textContent=a.label;if(a.primary)b.className='go';b.onclick=()=>console.log('baton:card:act:'+a.id);acts.appendChild(b);}const e=document.createElement('em');e.innerHTML='<kbd>Esc</kbd> stops';acts.appendChild(e);}
 const dots=$('dots');dots.replaceChildren();if(c.dots)for(let i=0;i<c.dots.of;i++){const d=document.createElement('i');d.className=i<c.dots.at?'done':i===c.dots.at?'now':'';dots.appendChild(d);}
 $('bar').getAnimations().forEach(a=>a.cancel());placeCard();};
// The page has no bridge to main: console lines are the message, and main answers by taking the mouse while it is over the card.
card.addEventListener('mouseenter',()=>console.log('baton:card:hover:1'));
card.addEventListener('mouseleave',()=>console.log('baton:card:hover:0'));
card.addEventListener('click',e=>{if(!e.target.closest('button'))console.log('baton:card:act:stop');});
$('cp').onclick=()=>{console.log('baton:card:copy');$('cp').textContent='Copied';setTimeout(()=>{$('cp').textContent='Copy';},1200);};
window.timer=(ms)=>{const b=$('bar');b.getAnimations().forEach(a=>a.cancel());b.animate([{transform:'scaleX(1)'},{transform:'scaleX(0)'}],{duration:ms,easing:'linear',fill:'forwards'});};
window.bubble=(text)=>{const b=$('bub');if(!text){b.classList.remove('on');return;}b.textContent=text;const p=landed||at;b.style.left=clamp(p.x+22,12,innerWidth-312)+'px';b.style.top=clamp(p.y+30,12,innerHeight-90)+'px';b.classList.add('on');};
window.back=(to)=>{$('bub').classList.remove('on');card.classList.remove('on');hide();landed=null;if(to&&!calm)flight(to,()=>ptr.classList.remove('on'));else ptr.classList.remove('on');};
window.clearAll=()=>{$('bub').classList.remove('on');cancelAnimationFrame(anim);landed=null;ptr.classList.remove('on');hide();$('trail').classList.remove('on','fade');window.card(null);};
</script></body></html>`;

export interface OverlayCard {
  readonly kicker: string;
  readonly text: string;
  readonly hint?: string;
  /** "2 of 3" when an answer runs to pages. */
  readonly page?: string;
  /** Plan or lesson progress. */
  readonly dots?: { readonly at: number; readonly of: number };
  /** The steps after this one, small, in one line. */
  readonly next?: ReadonlyArray<string>;
  /** Waiting for him, a problem, or finished: the card's edge and kicker say so. */
  readonly state?: "waiting" | "error" | "done";
  /** Buttons on the card; each reports its id through `onAction`. */
  readonly actions?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly primary?: boolean;
  }>;
}

export interface PointerOverlay {
  /** Fly to a global desktop point and label it. False when that is not the display he is on. */
  readonly point: (to: { x: number; y: number }, label: string | null) => Promise<boolean>;
  /** A short bubble at the pointer, or none: what changed, and how to undo it. */
  readonly bubble: (text: string | null) => Promise<void>;
  /** The card: beside the pointer once it lands, otherwise low on the stage display. */
  readonly card: (card: OverlayCard | null) => Promise<void>;
  /** Run the card's countdown line, so a hold is something he can see. */
  readonly timer: (ms: number) => Promise<void>;
  /** Clicky's exit: the words fade and the pointer flies home to his cursor. */
  readonly retreat: () => Promise<void>;
  /** Her own cursor glides to a desktop point with a few words and fades soon after; answers the glide's length. */
  readonly glide: (to: { x: number; y: number }, label: string) => Promise<number>;
  readonly clear: () => Promise<void>;
  /** Run `fn` with the layer out of the picture where content protection cannot do it. */
  readonly hiddenFor: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly dispose: () => void;
}

const IDLE_CLOSE_MS = 120_000;
const RETREAT_MS = 900;
/** How long her cursor stays after her last action before it fades. */
const GLIDE_LINGER_MS = 1_400;

export const createPointerOverlay = (
  platform: string,
  onAction: (id: string) => void = () => undefined,
): PointerOverlay => {
  const windows = new Map<number, { win: Electron.BrowserWindow; ready: Promise<void> }>();
  let stage: Electron.Display | null = null;
  let shown: OverlayCard | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let glideAt: Electron.Display | null = null;
  let glideFade: ReturnType<typeof setTimeout> | null = null;

  const forDisplay = (display: Electron.Display) => {
    const existing = windows.get(display.id);
    if (existing !== undefined && !existing.win.isDestroyed()) return existing;
    const win = new Electron.BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A transparent layer can read as occluded, and that would stop the flight mid-air.
        backgroundThrottling: false,
      },
    });
    let cardHover = false;
    win.setAlwaysOnTop(true, "screen-saver");
    markCompanionWindow(win);
    // Forwarded, so the page still sees the pointer over its card and can ask for the mouse.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.on("console-message", (...args: ReadonlyArray<unknown>) => {
      const first = args[0] as { message?: unknown } | undefined;
      const message = typeof args[2] === "string" ? args[2] : first?.message;
      if (message === "baton:card:hover:1") {
        cardHover = true;
        win.setIgnoreMouseEvents(false);
      } else if (message === "baton:card:hover:0") {
        cardHover = false;
        win.setIgnoreMouseEvents(true, { forward: true });
      } else if (message === "baton:card:copy" && shown !== null)
        Electron.clipboard.writeText(shown.text);
      else if (typeof message === "string" && message.startsWith("baton:card:act:"))
        onAction(message.slice("baton:card:act:".length));
    });
    // Made on the primary's scale; set again so a 125 % display's window is the display's size.
    win.setBounds(display.bounds);
    // The layer covers the whole display: after any protection change it must go back to letting clicks through (unless the card is hovered).
    protectFromCapture(win, () => {
      if (win.isDestroyed()) return;
      if (cardHover) win.setIgnoreMouseEvents(false);
      else win.setIgnoreMouseEvents(true, { forward: true });
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const bottom = display.bounds.y + display.bounds.height;
    const inset = bottom - (display.workArea.y + display.workArea.height) + CARD_ABOVE_WORK_AREA;
    const ready = loadDocument(win, OVERLAY_DOCUMENT)
      .then((loaded) =>
        loaded ? win.webContents.executeJavaScript(`window.inset(${inset})`) : undefined,
      )
      .then(() => (win.isDestroyed() ? undefined : win.showInactive()))
      .catch(() => undefined);
    const entry = { win, ready };
    windows.set(display.id, entry);
    return entry;
  };
  const closeWindows = () => {
    for (const { win } of windows.values()) if (!win.isDestroyed()) win.destroy();
    windows.clear();
  };
  const stopIdle = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
  };
  const run = async (display: Electron.Display, script: string) => {
    stopIdle();
    const { win, ready } = forDisplay(display);
    await ready;
    if (!win.isDestroyed()) await win.webContents.executeJavaScript(script);
  };
  const local = (display: Electron.Display, p: { x: number; y: number }) => ({
    x: p.x - display.bounds.x,
    y: p.y - display.bounds.y,
  });
  const cursorDisplay = () =>
    Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
  const each = (script: string) =>
    Promise.all(
      [...windows.values()].map(({ win, ready }) =>
        ready.then(() =>
          win.isDestroyed() ? undefined : win.webContents.executeJavaScript(script),
        ),
      ),
    ).then(() => undefined);
  const showCard = (display: Electron.Display, card: OverlayCard | null) =>
    run(display, `window.card(${JSON.stringify(card)})`);

  const clear = async () => {
    stage = null;
    shown = null;
    await each("window.clearAll()");
    stopIdle();
    idle = setTimeout(closeWindows, IDLE_CLOSE_MS);
  };

  return {
    point: async (to, label) => {
      // Pointing takes the cursor over from an action's glide, so the glide's fade must not hide it.
      if (glideFade !== null) clearTimeout(glideFade);
      glideFade = null;
      glideAt = null;
      const target = Electron.screen.getDisplayNearestPoint(to);
      const cursor = Electron.screen.getCursorScreenPoint();
      const here = Electron.screen.getDisplayNearestPoint(cursor).id === target.id;
      // Coming from another display it enters at the edge nearest his cursor.
      const raw = local(target, cursor);
      const from = {
        x: Math.max(0, Math.min(raw.x, target.bounds.width)),
        y: Math.max(0, Math.min(raw.y, target.bounds.height)),
      };
      if (stage !== null && stage.id !== target.id) {
        const left = windows.get(stage.id);
        if (left !== undefined && !left.win.isDestroyed()) {
          void left.win.webContents.executeJavaScript("window.clearAll()");
        }
      }
      stage = target;
      await run(
        target,
        `window.fly(${JSON.stringify(from)},${JSON.stringify(local(target, to))},${JSON.stringify(label)})`,
      );
      // The card moves with the pointer, or the answer is left behind on the other display.
      if (shown !== null) await showCard(target, shown);
      return here;
    },
    card: async (card) => {
      shown = card;
      stage ??= cursorDisplay();
      await showCard(stage, card);
    },
    bubble: async (text) => {
      if (stage !== null) await run(stage, `window.bubble(${JSON.stringify(text)})`);
    },
    timer: async (ms) => {
      if (stage !== null) await run(stage, `window.timer(${Math.round(ms)})`);
    },
    retreat: async () => {
      if (stage === null) return clear();
      const display = stage;
      const cursor = Electron.screen.getCursorScreenPoint();
      const home =
        cursorDisplay().id === display.id
          ? { x: cursor.x - display.bounds.x + 35, y: cursor.y - display.bounds.y + 25 }
          : null;
      shown = null;
      await run(display, `window.back(${JSON.stringify(home)})`);
      await new Promise((r) => setTimeout(r, RETREAT_MS));
      await clear();
    },
    glide: async (to, label) => {
      const target = Electron.screen.getDisplayNearestPoint(to);
      if (glideAt !== null && glideAt.id !== target.id) {
        const left = windows.get(glideAt.id);
        if (left !== undefined && !left.win.isDestroyed())
          void left.win.webContents.executeJavaScript("window.fadeOut()");
      }
      glideAt = target;
      if (glideFade !== null) clearTimeout(glideFade);
      stopIdle();
      const { win, ready } = forDisplay(target);
      await ready;
      if (win.isDestroyed()) return 0;
      const ms: unknown = await win.webContents.executeJavaScript(
        `window.glide(${JSON.stringify(local(target, to))},${JSON.stringify(label)})`,
      );
      glideFade = setTimeout(() => {
        glideFade = null;
        if (!win.isDestroyed()) void win.webContents.executeJavaScript("window.fadeOut()");
        glideAt = null;
        if (stage === null) idle = setTimeout(closeWindows, IDLE_CLOSE_MS);
      }, GLIDE_LINGER_MS);
      return typeof ms === "number" ? ms : 0;
    },
    clear,
    hiddenFor: (fn) => hiddenForCapture(fn, platform),
    dispose: () => {
      stopIdle();
      closeWindows();
    },
  };
};
