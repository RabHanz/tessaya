/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off
/**
 * The pill: small dark glass above the taskbar of the active display, up only while something is
 * happening (D112). It never takes focus or the mouse and stays out of screenshots. The bars read a
 * live level, his voice or Baton's; the sounds are made in the page from pillSounds.ts. The window
 * is built ahead and hidden so a wake shows at once, and goes as soon as it would be the last one
 * open, because a window left open stops "last window closed" quitting the app.
 */
import { protectFromCapture } from "../captureProtection.ts";
import * as Electron from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  PLACES,
  cursorOverCapsule,
  defaultPosition,
  baseOf,
  frostBounds,
  createLowerHold,
  grownBounds,
  parseSpots,
  pickScreen,
  placePosition,
  positionOf,
  sharedSpot,
  snapPosition,
  spotFrom,
  type Area,
  type PlaceId,
  type Spot,
} from "./pillPlacement.ts";
import { markCompanionWindow } from "../lastAppWindow.ts";
import { loadDocument } from "./loadDocument.ts";
import { onAudioServiceGone } from "./voicePlayer.ts";
import { applyLookScript, lookClasses, type Glass, type Motion } from "../home/look.ts";
import { PILL_FACES } from "../home/fonts.ts";
import { MARK_REVERSED_PATH } from "./trayArt.ts";
import { isPillClick } from "./pillGesture.ts";
import {
  ISLAND_CSS,
  ISLAND_HEIGHT,
  ISLAND_HTML,
  ISLAND_MEASURE,
  ISLAND_SCRIPT,
  PILL_BELOW,
  PILL_HEIGHT,
  PILL_LINE,
} from "./pillIsland.ts";
import { ICON, LOOK_TOKENS_CSS, applyLookScript as pillLookScript } from "./pillLook.ts";
import { onPillLook, pillLook, refreshPillTheme } from "./pillTheme.ts";
import { waveEngine } from "@t3tools/tessaya-shared/waveform";
import {
  CUE_TAIL_MS,
  PILL_PARTIAL,
  PILL_SOUNDS,
  THINKING_AFTER_MS,
  THINKING_EVERY_MS,
  endCueOn,
  soundMs,
  type PillSound,
} from "./pillSounds.ts";
import {
  IDLE_TURN,
  SILENT_AFTER_MS,
  reduceTurn,
  turnHoldsEscape,
  turnLimitMs,
  turnView,
  type TurnEvent,
  type TurnPhase,
  type TurnState,
  type WaveMode,
} from "@t3tools/tessaya-shared/voiceTurn";
import { cueFor, momentOf } from "@t3tools/tessaya-shared/companion";
import type { PersonaBody } from "../companion/desktopMascot.ts";
import { PILL_FACE_SCRIPT, studioScripts } from "../companion/pillFace.ts";

// As wide as the island's words; outside the capsule the window is click-through (hitTest).
const WIDTH = 420;
/** The tallest capsule and a little air: the Move pill check mark sits beside the capsule, not above it. */
const HEIGHT = PILL_HEIGHT;
/** The capsule's bottom 58 px above the work area, clear of a dictation bar in Wispr's place, so both can show. */
const ABOVE_WORK_AREA = 58 - PILL_BELOW;
/** The capsule's top 24 px below the work area's top. */
const TOP_MARGIN = 24 - (HEIGHT - PILL_BELOW - 22);
const DRAG_MS = 16;
const FOREGROUND_WAIT_MS = 300;
// The hit test runs fast only while the cursor is near the capsule; the resting bar can stay up all day.
const HIT_MS = 40;
const FAR_HIT_MS = 250;
const NEAR_PX = 120;
/** No heartbeat from the page for this long means the release was lost. */
const BEAT_TIMEOUT_MS = 700;
/** Below this the microphone is dead rather than quiet. */
const DEAD_LEVEL = 0.03;
/** Baton's own voice level reaches the bars at most this often. */
const SPEECH_MS = 20;
/** Longer than any cleanup (opening 0.75 s, hold, 1.4 s motion, fade): replaced by the page's own figure. */
const PROVISIONAL_HOLD_MS = 4_500;
/** The closing sound plays out before the window hides. */
const CLOSE_MS = 280;
// The frost waits for the island to hold still this long: resizing an acrylic window every frame jitters on Windows.
const FROST_SETTLE_MS = 160;

/** The phases that show a waveform and no word: his voice or Baton's, live. */
const WAVE_PHASES = ["listening", "speaking", "dictating"];

/** A verified speaker with no name yet. */
const PERSON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.6" r="2.7" fill="currentColor"/><path d="M3.2 13.6c.6-2.7 2.5-4.2 4.8-4.2s4.2 1.5 4.8 4.2z" fill="currentColor"/></svg>`;
const MARK = `<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="${MARK_REVERSED_PATH}"/></svg>`;

/**
 * The pill, in the design and the theme of Settings → Appearance (pillLook.ts): Tessaya, Quiet or Lively, coloured
 * by the app's theme. Each state is the drafts' (tessaya-ops drafts/pill-styles): the dictation pill with its dot
 * and waveform, hands-free ✕ / waveform / ✓, processing dots, "Press Esc again", and Tessaya's own listening,
 * working and speaking pills. A change of state morphs it by clip-path alone (Tessaya, Quiet) or pops its pebbles
 * (Lively); the waveform is the only thing drawn every frame, and only while it is live.
 */
export const PILL_DOCUMENT = `<!doctype html><html data-design="tessaya" data-theme="dark" data-wave="mound"><head><meta charset="utf-8"><style>
${PILL_FACES.tessaya}${PILL_FACES.lively}${LOOK_TOKENS_CSS}
html,body{height:100%;margin:0;overflow:hidden;background:transparent;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;cursor:default}
body{font:var(--w-cap) 12px/1 var(--font);color:var(--fg)}
:root[data-design=lively] body{font-variation-settings:"opsz" 14}
#p{position:absolute;left:50%;bottom:${PILL_BELOW}px;translate:-50% 0;box-sizing:border-box;background:var(--surf);color:var(--fg);touch-action:none;opacity:0;transform:translateY(4px);
 transition:opacity .12s,transform .16s cubic-bezier(.2,.8,.2,1),clip-path var(--morph-ms) var(--morph);--text:var(--fg);--grey:color-mix(in srgb,var(--fg) 46%,transparent)}
#p.on{opacity:1;transform:none}
#p.snap{transition:opacity .12s,transform .16s cubic-bezier(.2,.8,.2,1)}
/* The tall window grew downward (no room above it): the capsule hangs from the same line. */
body.down #p:not(.isl){bottom:auto;top:${PILL_LINE}px;translate:-50% -100%}
#rim{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none}
#rim rect{fill:url(#sheen);stroke:var(--rim);stroke-width:.5}
#rim stop{stop-color:var(--sheen)}#rim stop+stop{stop-opacity:0}
#p[data-s=error] #rim rect{stroke:var(--fail)}
#p.rest[data-rest=muted] #rim rect{stroke:var(--t-warning)}
#p.rest[data-rest=off]{opacity:.5}
:root[data-design=lively] #p{background:none;clip-path:none!important;width:auto!important;height:auto!important}
:root[data-design=lively] #rim{display:none}
#row{position:absolute;left:50%;bottom:0;translate:-50% 0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;height:30px;padding:0 12px;white-space:nowrap}
:root[data-design=quiet] #row{height:28px}
#p[data-s=hands] #row{height:34px;padding:0 4px}
:root[data-design=quiet] #p[data-s=hands] #row{height:32px}
#p[data-s=esc] #row{padding:0 12px 0 10px}
:root[data-design=quiet] #p[data-s=esc] #row{padding:0 12px}
#p:is([data-s=aListen],[data-s=aThink],[data-s=aSpeak]) #row{padding:0 4px 0 11px}
#p[data-s=process] #row{width:88px}
:root[data-design=quiet] #p[data-s=process] #row{width:80px}
#p.rest #row{width:40px;height:8px;padding:0}
:root[data-design=quiet] #p.rest #row{width:36px;height:6px}
#wv{display:contents}
:root[data-design=lively] #row{position:relative;left:auto;bottom:auto;translate:none;width:auto!important;height:auto!important;padding:0!important;gap:6px}
:root[data-design=lively] #wv{display:flex;align-items:center;justify-content:center;gap:8px;box-sizing:border-box;height:34px;padding:0 12px;border-radius:12px;background:var(--surf);box-shadow:var(--pb-shadow);font-weight:700}
:root[data-design=lively] #p[data-s=process] #wv{width:84px}
:root[data-design=lively] #p.rest #wv{width:24px;height:10px;padding:0;border-radius:5px}
:root[data-design=lively] #p.rest[data-rest=muted] #wv{background:var(--t-warningSurface)}
:root[data-design=lively] #p[data-s=error] #wv{background:var(--fail-bg)}
#row>:not(#wv),#wv>*{display:none;flex:none}
:root[data-design=lively] #row>#wv{display:flex}
#p[data-s=listen] :is(#mic,#w,#bal),#p[data-s=hands] :is(#dx,#w,#dv),#p[data-s=process] #d,#p[data-s=esc] :is(#gl,#t),
#p[data-s=aListen] :is(#mk,#mic,#w,#st),#p[data-s=aThink] :is(#mk,#t,#d,#st),#p[data-s=aSpeak] :is(#mk,#w,#st),
#p[data-s=text] :is(#t,#c),#p[data-s=error] :is(#gl,#t,#c){display:block}
#p[data-s=process] #d,#p[data-s=aThink] #d,#p[data-s=hands] :is(#dx,#dv),#p[data-s=esc] #gl,#p[data-s=error] #gl,#p:is([data-s=aListen],[data-s=aThink],[data-s=aSpeak]) #st{display:grid}
:root[data-design=lively] #p[data-s=hands] #wv>#w{display:block}
#mic,#bal{width:6px;height:6px;border-radius:50%;background:var(--mic)}
:root[data-design=quiet] :is(#mic,#bal){width:5px;height:5px}
:root[data-design=lively] :is(#mic,#bal){width:7px;height:7px}
#bal{visibility:hidden}
#mk{width:16px;height:16px;color:var(--fg)}
:root[data-design=quiet] #mk{width:15px;height:15px}:root[data-design=lively] #mk{width:17px;height:17px}
#mk.sting{animation:sting .6s var(--pop) both}
@keyframes sting{0%{scale:.4;opacity:0}60%{scale:1.2;opacity:1}100%{scale:1}}
/* Who she knows she is talking to: still, beside her mark, only while the session is verified (speakerIdentity.ts). */
#who{place-items:center;box-sizing:border-box;width:16px;height:16px;margin-left:-3px;border-radius:50%;background:var(--raised);color:var(--fg);font:var(--w-cap) 9px/1 var(--font)}
#who svg{width:11px;height:11px}
:root[data-design=quiet] #who{width:15px;height:15px;background:none;box-shadow:inset 0 0 0 1px var(--grey);color:var(--fg2);font-size:8.5px}
:root[data-design=lively] #who{width:17px;height:17px;margin-left:-2px;background:var(--pri);color:var(--on-pri);font-size:9.5px}
#p[data-who]:is([data-s=aListen],[data-s=aThink],[data-s=aSpeak]) #who{display:grid}
#gl{place-items:center;width:18px;height:18px;color:var(--fail)}#gl svg{width:16px;height:16px}
:root[data-design=quiet] #p[data-s=esc] #gl{display:none}
:root[data-design=lively] #gl{width:34px;height:34px;border-radius:12px;background:var(--fail-bg);box-shadow:var(--pb-shadow)}:root[data-design=lively] #gl svg{width:15px;height:15px}
#t{white-space:nowrap}#t:empty,#c:empty{display:none!important}
#c{color:var(--fg2);font-weight:500;overflow:hidden;text-overflow:ellipsis;max-width:260px}
#p[data-tone=good] #t{color:var(--t-accent)}#p[data-tone=off] #t{color:var(--fg2)}
#p[data-s=error] #t{color:var(--fail)}
:root[data-design=tessaya] #p[data-s=error] #t{color:var(--fg)}
#d{align-items:center;grid-auto-flow:column;gap:4px}
#d b{display:block;width:5px;height:5px;border-radius:50%;background:var(--pri);opacity:.3;animation:step 1.2s steps(1,end) infinite}
:root[data-design=quiet] #d b{width:4px;height:4px;background:var(--fg)}
:root[data-design=lively] #d{gap:5px}:root[data-design=lively] #d b{width:7px;height:7px;opacity:.35;animation-name:stepL}
#d b:nth-child(2){animation-delay:.4s}#d b:nth-child(3){animation-delay:.8s}
@keyframes step{0%{opacity:1}33.33%{opacity:.3}100%{opacity:.3}}
@keyframes stepL{0%{opacity:1;translate:0 -4px}33.33%{opacity:.35;translate:0 0}100%{opacity:.35;translate:0 0}}
#st{place-items:center;box-sizing:border-box;min-height:24px;padding:0 10px;border-radius:12px;background:var(--raised);color:var(--fg);font-size:12px;line-height:24px}
#st svg{display:none;width:15px;height:15px}
:root[data-design=quiet] #st{min-height:22px;line-height:22px;padding:0 9px;border-radius:999px}
:root[data-design=lively] #st{width:34px;height:34px;padding:0;border-radius:12px;background:var(--raised);box-shadow:var(--pb-shadow);font-size:0}
:root[data-design=lively] #st svg{display:block}:root[data-design=lively] #st span{display:none}
.db{position:relative;box-sizing:border-box;place-items:center;width:26px;height:26px;padding:0;margin:0;border:0;border-radius:13px;background:none;color:var(--fg2);cursor:pointer;transition:border-radius .2s var(--pop),scale .2s var(--pop)}
.db::before{content:"";position:absolute;inset:-4px}
.db svg{width:13px;height:13px}
.db:hover{background:var(--raised);color:var(--fg)}.db:active{border-radius:7px;scale:.92}
.db:focus-visible{outline:2px solid var(--pri);outline-offset:1px}
#dv{width:28px;border-radius:9px;background:var(--pri);color:var(--on-pri)}#dv:hover{background:var(--pri);color:var(--on-pri)}
:root[data-design=quiet] .db{width:24px;height:24px;border-radius:50%}:root[data-design=quiet] .db::before{inset:-5px;border-radius:50%}
:root[data-design=quiet] .db svg{width:12px;height:12px}:root[data-design=quiet] .db:hover{background:none}:root[data-design=quiet] .db:active{border-radius:50%;scale:.86}
:root[data-design=quiet] #dv{width:24px;border-radius:50%}:root[data-design=quiet] #dv:hover{background:var(--pri)}
:root[data-design=lively] .db{width:34px;height:34px;border-radius:12px;background:var(--raised);color:var(--fg);box-shadow:var(--pb-shadow)}:root[data-design=lively] .db::before{inset:0}
:root[data-design=lively] .db svg{width:15px;height:15px}:root[data-design=lively] .db:active{border-radius:17px;scale:.9;rotate:-6deg}
:root[data-design=lively] #dv{width:34px;border-radius:12px;background:var(--pri);color:var(--on-pri)}
/* Pieces arrive on a state change only: Tessaya rises into place, Quiet blur-fades in, Lively's pebbles squash and stretch.
   Hands-free: ✓ first, the waveform stretches out of it, then ✕. */
:root[data-design=tessaya] #row.pop{animation:inT var(--pop-ms) var(--pop) both}
@keyframes inT{from{opacity:0;transform:translateY(6px)}}
:root[data-design=quiet] #row.pop{animation:inQ .24s ease-out both}
@keyframes inQ{from{opacity:0;scale:.94;filter:blur(4px)}}
:root:not([data-design=lively]) #p[data-s=hands] #row.pop>*{animation:popS var(--pop-ms) var(--pop) both}
:root:not([data-design=lively]) #p[data-s=hands] #row.pop>#wv>#w{animation:stretch var(--pop-ms) var(--pop) 70ms both;transform-origin:100% 50%}
:root:not([data-design=lively]) #p[data-s=hands] #row.pop>#dx{animation-delay:150ms}
@keyframes popS{from{opacity:0;scale:.3}}
@keyframes stretch{from{opacity:0;scale:.2 1}}
:root[data-design=lively] #row.pop>*{animation:squash .52s cubic-bezier(.3,.7,.4,1) both}
:root[data-design=lively] #p[data-s=hands] #row.pop>#wv{animation-delay:80ms}
:root[data-design=lively] #p[data-s=hands] #row.pop>#dx{animation-delay:170ms}
@keyframes squash{0%{opacity:0;scale:.3}55%{opacity:1;scale:1.14 .86}78%{scale:.96 1.05}100%{scale:1}}
:root[data-design=lively] #p:not(.on) #row>*{animation:drop .16s ease-in both}
@keyframes drop{to{opacity:0;translate:0 8px;scale:.85}}
#p.isl #row{animation:none!important}
body.moving #p{cursor:grab}body.moving #p.drag{cursor:grabbing}
body.moving #rim rect{stroke:var(--t-accent);stroke-width:1;stroke-dasharray:3 2}
:root[data-design=lively] body.moving #wv{outline:1px dashed var(--t-accent);outline-offset:1px}
#ok{display:none;position:absolute;left:0;top:0;box-sizing:border-box;width:22px;height:22px;padding:0;margin:0;border-radius:50%;border:.5px solid var(--rim);background:var(--surf);color:var(--t-accent);cursor:pointer;align-items:center;justify-content:center}
body.moving #ok{display:flex}
#ok:focus-visible{outline:2px solid var(--t-accent);outline-offset:1px}
#p.drag::before{content:"";position:absolute;inset:-10px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:reduce){#p,#p *{transition:none!important;animation:none!important}#d b{opacity:.7}}
html.motion-reduced #p,html.motion-reduced #p *,html.motion-off #p,html.motion-off #p *{transition:none!important;animation:none!important}
html.motion-reduced #d b,html.motion-off #d b{opacity:.7}
${ISLAND_CSS}</style></head><body><button id="ok" type="button" aria-label="Save pill position" title="Save pill position"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div id="p" role="status" aria-live="polite" data-s="listen"><svg id="rim" aria-hidden="true"><defs><linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0"/><stop offset=".42"/></linearGradient></defs><rect/></svg><div id="row"><button id="dx" class="db" type="button" aria-label="Discard the dictation" title="Discard (Esc)">${ICON.x}</button><span id="gl" aria-hidden="true"></span><div id="wv"><span id="mk">${MARK}</span><span id="who" aria-hidden="true"></span><i id="mic" title="Microphone on"></i><canvas id="w" width="64" height="20" aria-hidden="true"></canvas><span id="t"></span><span id="d"><b></b><b></b><b></b></span><span id="c"></span><i id="bal" aria-hidden="true"></i></div><button id="dv" class="db" type="button" aria-label="Insert the dictation" title="Insert">${ICON.check}</button><span id="st"><span>Stop</span>${ICON.stop}</span></div><span id="sr" class="sr"></span>${ISLAND_HTML}</div>${ISLAND_MEASURE}
<script>
const $=i=>document.getElementById(i),SOUNDS=${JSON.stringify(PILL_SOUNDS)},PARTIAL=${PILL_PARTIAL},WAVE=${JSON.stringify(WAVE_PHASES)},PILL_LINE=${PILL_LINE};
const reduce=matchMedia('(prefers-reduced-motion:reduce)'),root=document.documentElement.classList;
const isCalm=()=>reduce.matches||root.contains('motion-reduced')||root.contains('motion-off');
const GLYPH={esc:${JSON.stringify(ICON.x)},error:${JSON.stringify(ICON.alert)}};
const PERSON=${JSON.stringify(PERSON)};
const design=()=>document.documentElement.dataset.design||'tessaya';
// A damped spring sampled into CSS linear(): spring motion with no script per frame (stiffness, damping ratio).
const spring=(k,ratio)=>{const c=2*ratio*Math.sqrt(k);let x=0,v=0,t=0;const dt=1/600,pts=[];
 while(t<2.5){const a=-k*(x-1)-c*v;v+=a*dt;x+=v*dt;t+=dt;pts.push(x);if(t>.15&&Math.abs(x-1)<.0015&&Math.abs(v)<.02)break;}
 const out=['0'];for(let i=1;i<40;i++)out.push(pts[Math.round(i/40*(pts.length-1))].toFixed(4));out.push('1');return{ease:'linear('+out.join(',')+')',ms:Math.round(t*1000)};};
const SPRINGS={tessaya:{morph:[240,.74],pop:[480,.66]},quiet:{morph:[200,.82],pop:[420,.78]},lively:{morph:[340,.66],pop:[520,.56]}};
let morphMs=300;
const setSprings=()=>{for(const[n,[k,r]]of Object.entries(SPRINGS[design()]||SPRINGS.tessaya)){const s=spring(k,r);document.body.style.setProperty('--'+n,s.ease);document.body.style.setProperty('--'+n+'-ms',s.ms+'ms');if(n==='morph')morphMs=s.ms;}};
setSprings();
// The faces load on first use: loaded now, so the island measures his first words in the face it draws them in.
for(const f of['420 20px Newsreader','600 12px "Schibsted Grotesk"','700 16px "Bricolage Grotesque"'])document.fonts.load(f);
// The waveform (waveform.ts): RMS dBFS in from the main process, adaptive gain and an envelope, drawn by the design's
// renderer. The loop runs only while a live waveform is up, moving, and motion is allowed; still, it is drawn once.
const WE=(${waveEngine.toString()})(),LV=WE.createLevel(),cv=$('w'),g=cv.getContext('2d'),ZERO=()=>0;
const WS={tessaya:{pill:[64,20],aListen:[56,20],aSpeak:[64,20]},quiet:{pill:[60,16],aListen:[52,16],aSpeak:[52,16]},lively:{pill:[64,22],aListen:[56,22],aSpeak:[72,22]}};
let cw=64,ch=20,wmode='off',wkind='dict',db=-100,raf=0,last=0,cols=null;
const probe=document.createElement('i');probe.style.display='none';$('p').appendChild(probe);
const px=Object.assign(document.createElement('canvas'),{width:1,height:1}).getContext('2d',{willReadFrequently:true});
// Theme colours arrive as hex, oklch or a mix: the page resolves each, and one painted pixel gives its sRGB.
const rgbOf=v=>{probe.style.color='var('+v+')';const c=getComputedStyle(probe).color;px.clearRect(0,0,1,1);px.fillStyle='#000';px.fillStyle=c;px.fillRect(0,0,1,1);const d=px.getImageData(0,0,1,1).data;return[d[0],d[1],d[2]];};
const colours=()=>cols??=({c1:rgbOf('--wave'),c2:rgbOf('--wave2'),c3:rgbOf('--wave3'),dark:document.documentElement.dataset.theme!=='light'});
const drawW=t=>{g.clearRect(0,0,cw,ch);if(wmode==='off')return;const r=WE[document.documentElement.dataset.wave]||WE.mound;r(g,cw,ch,wmode==='live'&&!isCalm()?LV.at:ZERO,wkind,colours(),t);};
const fit=()=>{const r=devicePixelRatio||1;cv.width=Math.round(cw*r);cv.height=Math.round(ch*r);cv.style.width=cw+'px';cv.style.height=ch+'px';g.setTransform(r,0,0,r,0,0);drawW(performance.now());matchMedia('(resolution: '+r+'dppx)').addEventListener('change',fit,{once:true});};
const sizeW=s=>{const t=WS[design()]||WS.tessaya,[w,h]=t[s]||t.pill;if(w===cw&&h===ch)return;cw=w;ch=h;fit();};
fit();
// Quiet and settled (no voice in the history, and none coming): one last still frame, and the loop stops until he speaks.
const settled=()=>{if(db>LV.state().floor+5)return false;for(let a=0;a<12;a++)if(LV.at(a)>.002)return false;return true;};
const loop=t=>{raf=0;if(wmode!=='live'||isCalm())return;LV.tick(db,last?(t-last)/1000:.016);last=t;drawW(t);if(settled()){last=0;return;}raf=requestAnimationFrame(loop);};
const kick=()=>{if(!raf&&wmode==='live'&&!isCalm())raf=requestAnimationFrame(loop);};
const setMode=(m,kind)=>{if(kind)wkind=kind;if(m==='live'&&wmode!=='live')LV.reset();wmode=m;cancelAnimationFrame(raf);raf=0;last=0;drawW(performance.now());kick();};
const note=(n,start)=>{for(const[f,g]of[[n.hz,n.gain],[n.hz*2,n.gain*PARTIAL]]){const o=ctx.createOscillator(),a=ctx.createGain(),t=start+n.at;o.type='sine';o.frequency.value=f;a.gain.setValueAtTime(0,t);a.gain.linearRampToValueAtTime(g,t+.004);a.gain.exponentialRampToValueAtTime(g*.002,t+n.len);o.connect(a).connect(ctx.destination);o.start(t);o.stop(t+n.len+.02);}};
let ctx=null;
const ipcRenderer=window.pillIpc||{send(){}};
ipcRenderer.onLevel?.(v=>{if(typeof v!=='number')return;db=v;if(!raf&&wmode==='live'&&v>LV.state().floor+5)kick();});
// The morph (Tessaya, Quiet): the box jumps once to cover the old and new shapes, then only its clip-path moves between
// them on the design's spring; the hairline is drawn at the new shape. Once it has settled the box takes the new size.
const rimR=document.querySelector('#rim rect');
const rimTo=(x,y,w,h,r)=>{for(const[k,v]of[['x',x+.25],['y',y+.25],['width',Math.max(0,w-.5)],['height',Math.max(0,h-.5)],['rx',Math.max(0,r-.25)]])rimR.setAttribute(k,v.toFixed(2));};
const ins=(W,H,w,h,r)=>'inset('+(H-h)+'px '+(W-w)/2+'px 0px '+(W-w)/2+'px round '+r+'px)';
let box={W:0,H:0,w:0,h:0,r:0},settleT=0,sKey='';
const snapP=fn=>{const p=$('p');p.classList.add('snap');fn();void p.offsetWidth;p.classList.remove('snap');};
const morph=(key,instant)=>{const p=$('p'),row=$('row');if(island.on())return;
 if(key!==sKey){sKey=key;row.classList.remove('pop');void row.offsetWidth;if(!instant)row.classList.add('pop');}
 if(design()==='lively'){p.style.clipPath='';box={W:0,H:0,w:0,h:0,r:0};return sendRect();}
 const w=row.offsetWidth,h=row.offsetHeight,r=p.classList.contains('rest')?h/2:h/2;
 if(w===box.w&&h===box.h)return;
 const now=instant||isCalm()||box.w===0,W=now?w:Math.max(w,box.w),H=now?h:Math.max(h,box.h),from=now?{w,h,r}:box;
 snapP(()=>{p.style.width=W+'px';p.style.height=H+'px';p.style.clipPath=ins(W,H,from.w,from.h,from.r);});
 p.style.clipPath=ins(W,H,w,h,r);rimTo((W-w)/2,H-h,w,h,r);box={W,H,w,h,r};clearTimeout(settleT);
 const settle=()=>snapP(()=>{p.style.width=w+'px';p.style.height=h+'px';p.style.clipPath=ins(w,h,w,h,r);rimTo(0,0,w,h,r);box={W:w,H:h,w,h,r};sendRect();});
 if(now)settle();else settleT=setTimeout(settle,morphMs+60);};
new ResizeObserver(()=>morph(sKey,false)).observe($('row'));
// The design or the theme changed (pillTheme.ts): new springs, colours and waveform size, the shape taken at once.
window.onLook=()=>{setSprings();cols=null;sizeW($('p').dataset.ws||'pill');box={W:0,H:0,w:0,h:0,r:0};if(island.on())island.restyle();else morph(sKey,true);drawW(performance.now());};
const isClick=${isPillClick.toString()};
let drag=false,beat=0,down=null;
const grab=$('p'),moving=()=>document.body.classList.contains('moving');
// Only the capsule takes the mouse; everything around it in this window stays click-through.
grab.addEventListener('mouseenter',()=>ipcRenderer.send('baton-pill:hover',true));
grab.addEventListener('mouseleave',()=>{if(!drag)ipcRenderer.send('baton-pill:hover',false);});
// A drag is a captured pointer: it ends when the pointer is released, cancelled or lost, never because the cursor left the capsule.
const endDrag=why=>{if(!drag)return;drag=false;clearInterval(beat);grab.classList.remove('drag');ipcRenderer.send('baton-pill:drag',false,why);};
// Locked, a press and release on the capsule is always a click, which dismisses. Moving, it only drags.
grab.addEventListener('pointerdown',e=>{if(e.button!==0||drag)return;down={x:e.screenX,y:e.screenY,t:performance.now()};ipcRenderer.send('baton-pill:press',true);try{grab.setPointerCapture(e.pointerId);}catch(_){}});
grab.addEventListener('pointermove',e=>{if(down===null||drag||!moving())return;if(isClick(e.screenX-down.x,e.screenY-down.y,0))return;drag=true;grab.classList.add('drag');ipcRenderer.send('baton-pill:drag',true);beat=setInterval(()=>ipcRenderer.send('baton-pill:beat'),120);});
grab.addEventListener('pointerup',e=>{const d=down;down=null;ipcRenderer.send('baton-pill:press',false);if(drag)return endDrag('up');if(d===null||moving()||grab.classList.contains('rest'))return;
 ipcRenderer.send('baton-pill:click',e.screenX-d.x,e.screenY-d.y,performance.now()-d.t);});
$('ok').addEventListener('click',()=>ipcRenderer.send('baton-pill:moving',false));
// Spoken dictation's own ends: kept off the capsule's press, so they are never a drag or a dismiss.
for(const[id,insert]of[['dv',true],['dx',false]]){const b=$(id);b.addEventListener('pointerdown',e=>e.stopPropagation());b.addEventListener('pointerup',e=>e.stopPropagation());b.addEventListener('click',e=>{e.stopPropagation();ipcRenderer.send('baton-pill:dictation',insert);});}
addEventListener('keydown',e=>{if(e.key==='Escape'&&moving())ipcRenderer.send('baton-pill:moving',false);});
grab.addEventListener('pointercancel',()=>{down=null;ipcRenderer.send('baton-pill:press',false);endDrag('cancel');});
grab.addEventListener('lostpointercapture',()=>{down=null;ipcRenderer.send('baton-pill:press',false);endDrag('lost');});
grab.addEventListener('dblclick',()=>{if(grab.classList.contains('rest'))ipcRenderer.send('baton-pill:reset');});
grab.addEventListener('contextmenu',e=>{e.preventDefault();ipcRenderer.send('baton-pill:menu');});
// What is on screen: the island's capsule as drawn, the settled shape of the plain pill, or Lively's pebbles.
const visibleRect=()=>{if(island.on()&&VIS)return VIS;const r=grab.getBoundingClientRect();
 if(design()==='lively'||box.w===0)return{x:r.left,y:r.top,w:r.width,h:r.height};
 return{x:r.left+(box.W-box.w)/2,y:r.top+box.H-box.h,w:box.w,h:box.h};};
// The capsule's box goes to the main process, which decides by the cursor position when the window takes the mouse, so a missed forwarded mousemove cannot leave the pill dead.
// The island moves every frame: only a change of a few pixels is worth a message.
let sentRect='';const sendRect=()=>{const v=visibleRect(),ok=$('ok').style;
 // Moving, the check mark sits just right of the capsule, inside the short window.
 if(moving()){ok.left=(v.x+v.w+6)+'px';ok.top=(v.y+(v.h-22)/2)+'px';}
 const o=$('ok').getBoundingClientRect(),k=moving()&&o.width>0;
 const x=k?Math.min(v.x,o.left):v.x,y=k?Math.min(v.y,o.top):v.y,w=(k?Math.max(v.x+v.w,o.right):v.x+v.w)-x,h=(k?Math.max(v.y+v.h,o.bottom):v.y+v.h)-y,key=[x,y,w,h].map(n=>Math.round(n/3)).join();if(key===sentRect)return;sentRect=key;ipcRenderer.send('baton-pill:rect',x,y,w,h);};
new ResizeObserver(sendRect).observe(grab);addEventListener('load',sendRect);
for(const t of['pointerdown','pointerup','pointermove','pointercancel'])addEventListener(t,e=>ipcRenderer.send('baton-pill:pointer',t,e.clientX,e.clientY,e.target&&e.target.id||e.target.tagName,e.buttons),true);
let bypass=false;const setBypass=e=>{const b=e.altKey||e.shiftKey;if(b!==bypass){bypass=b;ipcRenderer.send('baton-pill:bypass',b);}};
${ISLAND_SCRIPT}
addEventListener('pointermove',setBypass);addEventListener('pointerdown',setBypass);addEventListener('keydown',setBypass);addEventListener('keyup',setBypass);
// The drafts' state for what the turn shows. Dictation: the dot and waveform held, ✕ / waveform / ✓ hands-free, dots
// while it is processed, the Esc warning; Tessaya's own: listening, working and speaking, each with Stop.
const stateOf=(v,isl)=>{if(v.phase==='dictating'){if(isl)return v.voice?'hands':'listen';
  if(v.wave==='sweep')return'process';if(/Esc again/.test(v.caption||''))return'esc';if(v.caption)return'text';return v.voice?'hands':'listen';}
 return v.phase==='listening'?'aListen':v.phase==='thinking'||v.phase==='working'?'aThink':v.phase==='speaking'?'aSpeak':v.phase==='error'?'error':'text';};
window.pill={
 show(v){const p=$('p'),was=p.classList.contains('on');p.dataset.tone=v.tone;p.dataset.phase=v.phase;p.dataset.voice=v.voice?'on':'off';
  // Dictation's island: a new one for each recording; processing with no words yet, the Esc warning or any other
  // phase puts the plain pill back.
  const plain=v.island!==true||(!island.hasWords()&&(v.wave==='sweep'||/Esc again/.test(v.caption||'')));
  const s=stateOf(v,!plain);p.dataset.s=s;
  if(v.who==null)delete p.dataset.who;else{p.dataset.who='';if(v.who)$('who').textContent=v.who;else $('who').innerHTML=PERSON;}
  if(plain)island.stop();
  p.className=plain?'on':'on isl';
  if(!plain&&(v.fresh===true||!island.on()))island.start();
  p.dataset.esc=island.on()&&/Esc again/.test(v.caption||'')?'on':'off';p.setAttribute('aria-label',v.label);if($('sr').textContent!==v.label)$('sr').textContent=v.label;
  if(island.on()&&v.wave==='sweep')island.release();
  $('t').textContent=s==='esc'?(v.caption||''):s==='text'&&v.phase==='dictating'?(v.caption||''):s==='aThink'||s==='error'||s==='text'?v.label:'';
  $('c').textContent=v.phase==='ended'?'Say the wake word':s==='text'&&v.caption&&/^to /.test(v.caption)?v.caption:'';
  $('gl').innerHTML=GLYPH[s]||'';
  const ws=s==='aListen'||s==='aSpeak'?s:'pill';p.dataset.ws=ws;sizeW(ws);
  const live=WAVE.includes(v.phase)&&v.wave==='live'&&(s==='listen'||s==='hands'||s==='aListen'||s==='aSpeak');
  setMode(live?'live':WAVE.includes(v.phase)?'flat':'off',v.phase==='speaking'?'assist':'dict');
  morph(s,!was);},
 rest(why){island.stop();const p=$('p'),was=p.classList.contains('on');p.className='on rest';delete p.dataset.phase;delete p.dataset.tone;p.dataset.s='rest';p.dataset.rest=why||'sleeping';setMode('off');morph('rest',!was);},
 hide(){if(I)I.until=0;$('p').className=island.on()?'isl':'';setMode('off');},
 sting(){if(isCalm())return;const m=$('mk');m.classList.remove('sting');void m.offsetWidth;m.classList.add('sting');},
 move(){island.stop();const p=$('p');p.className='on';setMode('off');p.dataset.tone='voice';p.dataset.phase='move';p.dataset.s='text';$('t').textContent='Drag to move';$('c').textContent='';morph('move',false);sendRect();},
 moving(on){document.body.classList.toggle('moving',on);if(on)$('ok').focus();sendRect();},
 why(w){const p=$('p');if(p.classList.contains('rest'))p.dataset.rest=w;},
 words(text){island.words(text);},
 cleanup(raw,clean){const ms=island.cleanup(raw,clean);if(ms>0)setMode('flat');return ms;},
 sound(name,gain){ctx??=new AudioContext();const t=ctx.currentTime+.01;for(const n of SOUNDS[name])note({...n,gain:n.gain*gain},t);return ctx.state+':'+SOUNDS[name].length;},
 // Frosted (Quiet over acrylic): the thinner tint, only while the acrylic is under it.
 frost(on){root.toggle('frost',on);},
};
</script></body></html>`;

export const markersDocument = (
  dots: ReadonlyArray<{ id: string; label: string; x: number; y: number }>,
): string =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:transparent;font:600 12px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
.d{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:rgba(31,111,91,.35);border:2px solid #1f6f5b;box-sizing:border-box}
.d.on{background:#1f6f5b;transform:scale(1.5)}
.l{position:absolute;transform:translate(-50%,14px);color:#1f6f5b;background:rgba(255,253,249,.92);padding:2px 8px;border-radius:6px;border:1px solid #e6e1d6;white-space:nowrap;opacity:0}
.l.on{opacity:1}</style><body></body><script>
const dots=${JSON.stringify(dots)};
for(const d of dots){const e=document.createElement('div');e.className='d';e.id='d-'+d.id;e.style.left=d.x+'px';e.style.top=d.y+'px';document.body.appendChild(e);
const l=document.createElement('div');l.className='l';l.id='l-'+d.id;l.textContent=d.label;l.style.left=d.x+'px';l.style.top=d.y+'px';document.body.appendChild(l);}
window.hi=id=>{for(const d of dots){document.getElementById('d-'+d.id).classList.toggle('on',d.id===id);document.getElementById('l-'+d.id).classList.toggle('on',d.id===id);}};
</script>`;

/** The Settings button sends the word it showed, so a click that first blurred the pill (and locked it) stays a lock. */
export const wantsMoving = (shown: unknown): boolean => shown !== "lock";

export interface VoicePill {
  readonly on: (event: TurnEvent, options?: { readonly silent?: boolean }) => void;
  /** His microphone, while listening or dictating. */
  /** `value` is the raw level (a dead mic is told by it); `shown`, what the bars draw (`createSpeechGain`). */
  readonly micLevel: (value: number, shown?: number, frame?: Int16Array) => void;
  /** A short sound for a lesson or a drive (start, a step done, waiting, an error, finished); honours the cues setting. */
  readonly cue: (name: "start" | "stepDone" | "waiting" | "error" | "finished") => void;
  /** Baton's own voice, while it speaks. */
  readonly speechLevel: (value: number) => void;
  /** His words so far, as the recogniser hears them, while he dictates. */
  readonly words: (text: string) => void;
  /** The pasted words: the pill plays their cleanup over what he said, then goes. */
  readonly cleanup: (raw: string, clean: string) => void;
  /** Build the window now, so the first wake is as quick as the rest. */
  readonly warm: () => void;
  /** The small mark at rest, off unless he asks. */
  readonly setRest: (on: boolean) => void;
  /** Why it is not hearing him, so the rest bar can say so: asleep, muted, or off. */
  readonly setReason: (reason: "sleeping" | "muted" | "off") => void;
  /** The edge setting changed (it is read live): put the pill where it now says. */
  readonly reposition: () => void;
  /** The target window changed: if the pill is up on another screen, it moves to the target's. */
  readonly retarget: () => void;
  /** Puts it on a named place of the display it is on and keeps it there. */
  readonly moveTo: (place: PlaceId) => void;
  /** Move pill: unlocked, the whole pill drags and its clicks do nothing; locked again by Esc or its check mark. */
  readonly setMoving: (on: boolean) => void;
  readonly moving: () => boolean;
  /** The named place it is nearest to, for the settings control. */
  readonly place: () => PlaceId;
  /** Whether he (or Settings) has put it somewhere on this display. */
  readonly placed: () => boolean;
  /** Forgets the saved place: back to the default edge. */
  readonly putBack: () => void;
  /** Where the pill's capsule is, or would appear: what the card sits beside. */
  readonly anchor: () => Electron.Rectangle;
  readonly state: () => TurnState;
  readonly dispose: () => void;
}

const loadSpots = (file: string): Readonly<Record<string, Spot>> => {
  try {
    return parseSpots(JSON.parse(NodeFS.readFileSync(file, "utf8")));
  } catch {
    return {};
  }
};

export const createVoicePill = (input: {
  /** 0 off, 0.5 quiet, 1 normal. */
  readonly cueGain: () => number;
  /** What the page said when a cue was played: its audio state and how many notes it scheduled (the proof logs it). */
  readonly onCuePlayed?: (name: string, result: string) => void;
  /** Holds a cue until he is quiet (true), or says to drop it (false); then tells the mic path it will sound. */
  readonly cueGate?: {
    readonly quiet: () => Promise<boolean>;
    readonly playing: (ms: number) => void;
  };
  readonly rest: () => boolean;
  /** The motion and glass he chose in Settings: the pill's page follows them. */
  readonly look?: () => { readonly motion: Motion; readonly glass: Glass };
  /** Extra items at the end of the right-click menu. */
  readonly menuItems?: () => ReadonlyArray<Electron.MenuItemConstructorOptions>;
  /** BATON_TEST_DIR: a PNG of the pill's own page at every state change, taken from inside the app. */
  readonly captureDir?: string;
  readonly edge: () => "bottom" | "top";
  /** Where `baton-pill.json` is kept: the places he dragged it to. */
  readonly stateDir: string;
  readonly holdEscape: (onPress: () => void) => () => void;
  readonly onChange?: (state: TurnState) => void;
  /** The persona whose face goes in place of the mark for this phase, or null for the mark (tessaya-shared/companion). */
  readonly face?: (phase: TurnPhase) => PersonaBody | null;
  /** The verified speaker's initial beside her mark (`pillWho`): null for none, "" for a person with no name yet. */
  readonly who?: () => string | null;
  /** Her characters' folder (COMPANION_DIR): the face needs the studio's scripts. */
  readonly companionDir?: string;
  /** Move pill went on or off, from wherever, so the tray's tick follows. */
  readonly onMoving?: (on: boolean) => void;
  /** The window he was in (null when unknown), so locking the pill hands focus back to it. */
  readonly foreground?: () => Promise<number | null>;
  readonly focusWindow?: (window: number) => void;
  /** Esc while it is up. */
  readonly onDismiss: () => void;
  /** Spoken dictation's ✓ (true: insert) or ✕ (false: throw away), shown while `voiceDictating`. */
  readonly onDictation?: (insert: boolean) => void;
  readonly voiceDictating?: () => boolean;
  /** The dictation pill is saying something after the words (Discarded, an offer): the plain pill, not the island. */
  readonly dictationMessage?: () => boolean;
  /** Settings → Dictation → Show words as you speak (on unless he turns it off). */
  readonly showWords?: () => boolean;
  /** Settings → On screen → Frosted glass, where Windows can draw it (`acrylicSupported`); else the island's tint. */
  readonly frosted?: () => boolean;
  /** The target window's rect in DIP (null when unknown): the pill goes on its screen. */
  readonly workArea?: () => Area | null;
  /** Each wake, from the event to the window on screen. */
  readonly onShown?: (ms: number) => void;
  /** How each drag ended, for the turn log: a drag that fails shows up there. */
  readonly onDrag?: (outcome: {
    readonly reason: string;
    readonly dx: number;
    readonly dy: number;
    readonly ms: number;
  }) => void;
}): VoicePill => {
  let state: TurnState = IDLE_TURN;
  let window: Electron.BrowserWindow | null = null;
  let ready: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let silentTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let loudest = 0;
  /** The view's waveform: bands are worked out and sent only while it is live. */
  let wave: WaveMode = "flat";
  let lastSpeech = 0;
  let releaseEscape: (() => void) | null = null;
  let why: "sleeping" | "muted" | "off" = "sleeping";
  const spotsFile = NodePath.join(input.stateDir, "baton-pill.json");
  let spots = loadSpots(spotsFile);
  let dragTimer: ReturnType<typeof setInterval> | null = null;
  let bypassSnap = false;
  let lastBeat = 0;
  let dragStarted: { readonly at: number; readonly x: number; readonly y: number } | null = null;
  let loadRetries = 0;
  let shots = 0;
  let markers: Electron.BrowserWindow | null = null;
  let markerPlace: PlaceId | null = null;
  let capsule = { x: 302, y: 40, width: 132, height: 41 };
  /** Acrylic under the island's capsule, a window of its own: the pill's is larger than the capsule. */
  let frost: Electron.BrowserWindow | null = null;
  let frostTimer: ReturnType<typeof setTimeout> | null = null;
  let takingMouse = false;
  let overTicks = 0;
  let hitTimer: ReturnType<typeof setTimeout> | null = null;
  let moving = false;
  let releaseMoveEscape: (() => void) | null = null;
  let movedFrom: Promise<number | null> = Promise.resolve(null);
  /** A press on the capsule is held: the window keeps the mouse even if the cursor slides off its edge. */
  let pressing = false;
  /** Dictation's island is up: the window is ISLAND_HEIGHT tall, grown from where it sits (`grownBounds`). */
  let tall = false;
  /** The tall window grew downward (no room above): the page anchors its capsule at the top. */
  let down = false;
  /** The cleanup plays until its hold ends: the pill goes only after it, unless ✕ or Esc ends it first. */
  const hold = createLowerHold({
    now: () => Date.now(),
    after: (ms, run) => {
      const t = setTimeout(run, ms);
      return () => clearTimeout(t);
    },
    lower: () => lower(),
  });
  let releaseHoldEscape: (() => void) | null = null;
  const dropHoldEscape = () => {
    releaseHoldEscape?.();
    releaseHoldEscape = null;
  };
  /** ✕, ✓ or Esc during the cleanup: it is pasted already, so the pill just goes. */
  const endCleanup = () => {
    dropHoldEscape();
    hold.holdUntil(0);
    if (turnView(state) === null) lower();
  };
  /** Where the window goes for a spot of the base pill; tall, it grows without moving the capsule. */
  const boundsAt = (at: { readonly x: number; readonly y: number }): Electron.Rectangle => {
    const base = { x: at.x, y: at.y, width: WIDTH, height: HEIGHT };
    if (!tall) return base;
    const grown = grownBounds(
      base,
      ISLAND_HEIGHT,
      Electron.screen.getDisplayMatching(base).workArea,
    );
    if (grown.down !== down) {
      down = grown.down;
      call(`document.body.classList.toggle('down',${down})`);
    }
    return grown.bounds;
  };
  /** The base pill's bounds, whatever the window's height: what places, saves and anchors use. */
  const baseBounds = (target: Electron.BrowserWindow): Electron.Rectangle =>
    baseOf(target.getBounds(), HEIGHT, tall && down);
  const setTall = (on: boolean) => {
    if (on && (moving || dragTimer !== null)) return;
    if (on === tall) return;
    const target = window;
    const base = target === null || target.isDestroyed() ? null : baseBounds(target);
    tall = on;
    if (base !== null && target!.isVisible()) target!.setBounds(boundsAt(base));
    settleFrost();
  };
  const hideFrost = () => {
    if (frostTimer !== null) clearTimeout(frostTimer);
    frostTimer = null;
    if (frost !== null && !frost.isDestroyed() && frost.isVisible()) {
      frost.hide();
      call("window.pill.frost(false)");
    }
  };
  /** Hidden while the island moves, laid under the capsule once it holds still; the tint shows meanwhile. */
  const settleFrost = () => {
    hideFrost();
    // Only Quiet is drawn over acrylic: Tessaya and Lively look the same on Windows 10 and 11.
    if (
      !tall ||
      input.frosted?.() !== true ||
      pillLook().design !== "quiet" ||
      (input.look?.().glass ?? "on") !== "on"
    )
      return;
    frostTimer = setTimeout(() => {
      frostTimer = null;
      const target = window;
      if (!tall || target === null || target.isDestroyed() || !target.isVisible()) return;
      const bounds = frostBounds(target.getBounds(), capsule);
      if (bounds === null) return;
      if (frost === null || frost.isDestroyed()) {
        frost = new Electron.BrowserWindow({
          ...bounds,
          backgroundMaterial: "acrylic",
          roundedCorners: true,
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
        frost.setAlwaysOnTop(true, "screen-saver");
        frost.setIgnoreMouseEvents(true);
        markCompanionWindow(frost);
        protectFromCapture(frost);
      } else frost.setBounds(bounds);
      frost.showInactive();
      call("window.pill.frost(true)");
      target.moveTop();
    }, FROST_SETTLE_MS);
    frostTimer.unref();
  };
  const trace = (record: Record<string, unknown>) => {
    if (input.captureDir === undefined) return;
    try {
      NodeFS.mkdirSync(input.captureDir, { recursive: true });
      NodeFS.appendFileSync(
        NodePath.join(input.captureDir, "pill-pointer.ndjson"),
        JSON.stringify({ at: Date.now(), ...record }) + "\n",
      );
    } catch {
      // A test aid only.
    }
  };
  const stopHitTest = () => {
    if (hitTimer !== null) clearTimeout(hitTimer);
    hitTimer = null;
    takingMouse = false;
    pressing = false;
  };
  const startHitTest = () => {
    if (hitTimer !== null) return;
    const tick = () => {
      const near = hitTest();
      if (hitTimer === null) return;
      hitTimer = setTimeout(tick, near ? HIT_MS : FAR_HIT_MS);
      hitTimer.unref();
    };
    hitTimer = setTimeout(tick, HIT_MS);
    hitTimer.unref();
  };
  /** The window takes the mouse exactly while the cursor is over the capsule, decided here, not by forwarded events. */
  /** Whether the cursor is near enough that the next check should come soon. */
  const hitTest = (): boolean => {
    const target = window;
    if (target === null || target.isDestroyed()) {
      stopHitTest();
      return false;
    }
    // Hidden for a moment (a screen grab hides every Tessaya window): keep the timer, or the pill comes back click-through.
    if (!target.isVisible()) return false;
    if (dragTimer !== null || pressing) return true;
    const cursor = Electron.screen.getCursorScreenPoint();
    const b = target.getBounds();
    const over = cursorOverCapsule(cursor, b, capsule);
    const near = over || cursorOverCapsule(cursor, b, capsule, NEAR_PX);
    const stale = over && ++overTicks % 12 === 0;
    if (over === takingMouse && !stale) return near;
    takingMouse = over;
    if (over) target.setIgnoreMouseEvents(false);
    else target.setIgnoreMouseEvents(true, { forward: true });
    trace({ kind: "pill_hit", over, cursor, bounds: b, capsule });
    return near;
  };
  const margins = () => ({ top: TOP_MARGIN, bottom: ABOVE_WORK_AREA });

  /** The screen where the work is (pickScreen), read as the pill appears or its target changes. */
  const workScreen = (): Electron.Display =>
    pickScreen(Electron.screen.getAllDisplays(), Electron.screen.getPrimaryDisplay(), {
      window: input.workArea?.() ?? null,
      cursor: Electron.screen.getCursorScreenPoint(),
    });
  /** Where it goes on this display: his one place if he moved it, else the default. */
  const placeFor = (display: Electron.Display) => {
    const size = { width: WIDTH, height: HEIGHT };
    const spot = sharedSpot(spots);
    return spot === undefined
      ? defaultPosition(display.workArea, size, input.edge(), {
          top: TOP_MARGIN,
          bottom: ABOVE_WORK_AREA,
        })
      : positionOf(display.workArea, size, spot);
  };
  const saveSpots = () => {
    try {
      NodeFS.writeFileSync(spotsFile, JSON.stringify(spots));
    } catch {
      // The place is a nicety; losing it must never matter.
    }
  };

  /** The named places and the grid, drawn on the display while it is dragged. */
  const openMarkers = (display: Electron.Display) => {
    closeMarkers();
    const area = display.workArea;
    const size = { width: WIDTH, height: HEIGHT };
    const dots = PLACES.map((place) => {
      const at = placePosition(area, size, place.id, margins());
      return {
        id: place.id,
        label: place.label,
        x: at.x - area.x + WIDTH / 2,
        y: at.y - area.y + HEIGHT / 2,
      };
    });
    const win = new Electron.BrowserWindow({
      ...area,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      resizable: false,
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "screen-saver");
    markCompanionWindow(win);
    protectFromCapture(win);
    const page = markersDocument(dots);
    void loadDocument(win, page).then((loaded) => {
      if (loaded && !win.isDestroyed()) win.showInactive();
    });
    markers = win;
    markerPlace = null;
  };
  const closeMarkers = () => {
    if (markers !== null && !markers.isDestroyed()) markers.destroy();
    markers = null;
  };
  const stopDrag = (save: boolean, reason = "up") => {
    if (dragTimer === null) return;
    // A new grab starts from a clean mouse state: the next hit test switches it on again.
    takingMouse = false;
    clearInterval(dragTimer);
    dragTimer = null;
    closeMarkers();
    if (window === null || window.isDestroyed()) return;
    const bounds = baseBounds(window);
    if (dragStarted !== null) {
      input.onDrag?.({
        reason,
        dx: bounds.x - dragStarted.x,
        dy: bounds.y - dragStarted.y,
        ms: Date.now() - dragStarted.at,
      });
      dragStarted = null;
    }
    if (!save) return;
    const display = Electron.screen.getDisplayMatching(bounds);
    spots = { any: spotFrom(display.workArea, bounds, bounds) };
    saveSpots();
  };

  /** Focusable only while moving, so Tab reaches the check mark; locked it never takes focus. */
  const applyMoving = (target: Electron.BrowserWindow) => {
    if (target.isDestroyed()) return;
    const on = moving;
    const gaveBack = !on && target.isFocused();
    if (gaveBack) target.blur();
    target.setFocusable(on);
    // Windows can give a window that becomes focusable a taskbar button; Electron has no getter, so set it again.
    target.setSkipTaskbar(true);
    if (on) target.focus();
    void target.webContents.executeJavaScript(`window.pill.moving(${on})`).catch(() => undefined);
    if (gaveBack)
      void movedFrom.then((was) => {
        if (was !== null && !moving) input.focusWindow?.(was);
      });
  };
  const setMoving = (on: boolean) => {
    if (on === moving) return;
    moving = on;
    if (on) {
      setTall(false);
      releaseMoveEscape = input.holdEscape(() => setMoving(false));
      // Never waits on a busy helper: no answer in 300 ms means focus is not handed back.
      movedFrom = Promise.race([
        input.foreground?.().catch(() => null) ?? Promise.resolve(null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FOREGROUND_WAIT_MS).unref()),
      ]);
      raise();
      if (state.phase === "idle") call("window.pill.move()");
    } else {
      releaseMoveEscape?.();
      releaseMoveEscape = null;
      stopDrag(true);
    }
    const target = window;
    // The window he was in is read before the pill takes the focus from it.
    void Promise.all([ready, movedFrom]).then(() => {
      if (target !== null && window === target) applyMoving(target);
    });
    if (!on && state.phase === "idle") lower();
    input.onMoving?.(on);
  };

  const this_anchor = () => {
    if (window !== null && !window.isDestroyed()) return baseBounds(window);
    return { ...placeFor(workScreen()), width: WIDTH, height: HEIGHT };
  };

  const call = (code: string, done?: (result: unknown) => void) => {
    const target = window;
    void ready.then(() => {
      if (target !== null && !target.isDestroyed()) {
        const now = input.look?.();
        const prefix =
          now === undefined ? "" : `${applyLookScript(lookClasses(now.motion, now.glass))};`;
        void target.webContents
          .executeJavaScript(`${prefix}${code}`)
          .then((result: unknown) => done?.(result))
          .catch(() => undefined);
      }
    });
  };

  const build = () => {
    if (window !== null && !window.isDestroyed()) return;
    pressing = false;
    const created = new Electron.BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      // Local page of ours only, isolated: its preload gives it the drag and click messages and nothing else.
      webPreferences: {
        autoplayPolicy: "no-user-gesture-required",
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: NodePath.join(__dirname, "pillPreload.cjs"),
      },
    });
    created.setAlwaysOnTop(true, "screen-saver");
    markCompanionWindow(created);
    created.setIgnoreMouseEvents(true, { forward: true });
    // Out of screenshots and recordings by design, which also hides it from OS-level capture tools; a test
    // run (BATON_TEST_DIR) lets them see it.
    protectFromCapture(created);
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window = created;
    // Dragged, placed again or moved to another screen: the frost follows once the window stops.
    created.on("move", settleFrost);
    created.on("closed", () => {
      hideFrost();
      if (frost !== null && !frost.isDestroyed()) frost.destroy();
      frost = null;
    });
    // Clicking into another app ends Move pill, so Esc is not kept from every app.
    created.on("blur", () => {
      if (moving && window === created) setMoving(false);
    });
    ready = loadDocument(created, PILL_DOCUMENT).then((loaded) => {
      if (loaded && window === created && moving) {
        applyMoving(created);
        raise();
        if (state.phase === "idle") call("window.pill.move()");
      }
      // A pill that failed to load would stay blank: build it again, and show what it should.
      if (loaded || window !== created) return;
      if (!created.isDestroyed()) created.destroy();
      window = null;
      if (loadRetries >= 2) return;
      loadRetries += 1;
      build();
      if (turnView(state) !== null) on({ type: "window_open" });
    });
    // The design and the app's theme, before anything is shown.
    call(pillLookScript(pillLook()));
  };

  const raise = () => {
    hold.raised();
    void refreshPillTheme();
    build();
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
    const target = window;
    const display = workScreen();
    void ready.then(() => {
      if (target === null || target.isDestroyed()) return;
      if (target.isVisible()) return startHitTest();
      const at = placeFor(display);
      target.setBounds(boundsAt(at));
      takingMouse = false;
      target.setIgnoreMouseEvents(true, { forward: true });
      target.showInactive();
      startHitTest();
    });
  };

  const lower = () => {
    if (window === null || window.isDestroyed()) return;
    if (hold.defer()) return;
    dropHoldEscape();
    if (moving) return call("window.pill.move()");
    if (input.rest()) {
      raise();
      call(`window.pill.rest(${JSON.stringify(why)})`);
      setTall(false);
      return;
    }
    hideFrost();
    call("window.pill.hide()");
    const closing = window;
    hideTimer = setTimeout(() => {
      if (!closing.isDestroyed()) closing.hide();
      tall = false;
      hideFrost();
      down = false;
      stopHitTest();
    }, CLOSE_MS);
  };

  const setEscape = (next: boolean) => {
    if (next === (releaseEscape !== null)) return;
    if (next) releaseEscape = input.holdEscape(input.onDismiss);
    else {
      releaseEscape?.();
      releaseEscape = null;
    }
  };

  onAudioServiceGone(() => call("try{ctx&&ctx.close()}catch{}ctx=null"));
  const sound = (name: PillSound) => {
    const gain = input.cueGain();
    if (gain <= 0) return;
    const play = () => {
      input.cueGate?.playing(soundMs(name) + CUE_TAIL_MS);
      call(`window.pill.sound(${JSON.stringify(name)},${gain})`, (result) =>
        input.onCuePlayed?.(name, String(result)),
      );
    };
    if (input.cueGate === undefined) return play();
    void input.cueGate.quiet().then((ok) => {
      if (ok) play();
    });
  };
  let thinkTimer: ReturnType<typeof setTimeout> | null = null;
  /** A quiet note after a long wait, then no more than one every eight seconds, until something else happens. */
  const thinkingCue = (after: number) => {
    if (thinkTimer !== null) clearTimeout(thinkTimer);
    thinkTimer = setTimeout(() => {
      if (state.phase !== "thinking" && state.phase !== "working") return;
      sound("thinking");
      thinkingCue(THINKING_EVERY_MS);
    }, after);
  };

  /** The persona whose face is in the pill now, or null for the mark. */
  let faceOf: PersonaBody | null = null;
  /** Pill pages that have the studio's scripts: a rebuilt window loads them again. */
  const faceLoaded = new WeakSet<object>();
  const showFace = (was: TurnPhase) => {
    const persona = input.face?.(state.phase) ?? null;
    const target = window;
    if (persona === null || target === null || input.companionDir === undefined) return hideFace();
    if (!faceLoaded.has(target)) {
      const scripts = studioScripts(input.companionDir);
      if (scripts === null) return hideFace();
      faceLoaded.add(target);
      call(`${scripts};\n${PILL_FACE_SCRIPT}`);
    }
    faceOf = persona;
    call(`window.pillFace.show(${JSON.stringify(persona)})`);
    const moment = momentOf(state.phase);
    const cue = moment === null ? null : cueFor(moment, "calm");
    if (cue !== null) call(`window.pillFace.cue(${JSON.stringify(cue)})`);
    if ((state.phase === "speaking") !== (was === "speaking"))
      call(`window.pillFace.speak(${state.phase === "speaking"})`);
  };
  const hideFace = () => {
    if (faceOf !== null) call("window.pillFace&&window.pillFace.hide()");
    faceOf = null;
  };

  const on = (event: TurnEvent, options?: { readonly silent?: boolean }) => {
    const previous = state;
    state = reduceTurn(state, event);
    const mute = options?.silent === true;
    const sound_ = mute ? () => undefined : sound;
    const waiting = (phase: string) => phase === "thinking" || phase === "working";
    if (thinkTimer !== null && !waiting(state.phase)) {
      clearTimeout(thinkTimer);
      thinkTimer = null;
    }
    if (waiting(state.phase) && !waiting(previous.phase) && !mute) thinkingCue(THINKING_AFTER_MS);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (silentTimer !== null) clearTimeout(silentTimer);
    silentTimer = null;
    const view = turnView(state);
    wave = view?.wave ?? "flat";
    if (view === null) {
      setEscape(false);
      hideFace();
      if (previous.phase !== "idle") {
        if (endCueOn(previous.phase, null)) sound_("end");
        lower();
      }
    } else {
      // Dictation's island while he records and until it is pasted; any other phase ends a cleanup still playing.
      // Tidying continues the island it follows (spoken dictation lowers the pill between ✓ and its flush).
      const island = state.phase === "dictating" && input.dictationMessage?.() !== true;
      const fresh = island && previous.phase !== "dictating" && view.wave !== "sweep";
      const words = island && input.showWords?.() !== false;
      // A new dictation or any other phase ends a cleanup still playing.
      if (!island || fresh) {
        dropHoldEscape();
        hold.holdUntil(0);
      }
      if (words) setTall(true);
      raise();
      if (!words) setTall(false);
      setEscape(turnHoldsEscape(state));
      call(
        `window.pill.show(${JSON.stringify({ ...view, phase: state.phase, voice: input.voiceDictating?.() === true, island, fresh, who: input.who?.() ?? null })})`,
      );
      showFace(previous.phase);
      if (event.type === "wake") {
        call("window.pill.sting()");
        loudest = 0;
        sound_("wake");
        const at = performance.now();
        void ready.then(() => input.onShown?.(performance.now() - at));
      }
      if (state.phase === "error" && previous.phase !== "error") sound_("error");
      if (endCueOn(previous.phase, state.phase)) sound_("end");
      if (state.phase === "listening" && !state.heard) {
        silentTimer = setTimeout(() => {
          if (loudest < DEAD_LEVEL) on({ type: "silent" });
        }, SILENT_AFTER_MS);
      }
      // The core ends an open window, so Listening and spoken dictation stay as long as it lasts.
      if (!(state.open && (state.phase === "dictating" || state.phase === "listening"))) {
        timer = setTimeout(() => on({ type: "dismissed" }), turnLimitMs(state.phase));
      }
    }
    if (previous !== state) input.onChange?.(state);
    if (input.captureDir !== undefined && previous.phase !== state.phase) {
      const dir = input.captureDir;
      const phase = state.phase;
      const n = (shots += 1);
      // After the page has had a moment to paint what it was just told.
      setTimeout(() => {
        const target = window;
        if (target === null || target.isDestroyed()) return;
        void target.webContents
          .capturePage()
          .then((image) => {
            NodeFS.mkdirSync(dir, { recursive: true });
            NodeFS.writeFileSync(NodePath.join(dir, `pill-${phase}-${n}.png`), image.toPNG());
          })
          .catch(() => undefined);
      }, 400).unref();
    }
  };

  const wave_ = waveEngine();
  /** The waveform is wanted: a live waveform on a visible pill, with motion on (the page draws them still otherwise). */
  const barsWanted = () =>
    wave === "live" &&
    window !== null &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.webContents.isLoading() &&
    (input.look?.().motion ?? "full") === "full";
  /** The level in dBFS over IPC, one number a microphone frame (50 a second); the page smooths and draws it. */
  const sendLevel = (db: number) => window?.webContents.send("baton-pill:level", db);

  // A new design, waveform or theme repaints the pill in place.
  const stopLook = onPillLook((look) => call(pillLookScript(look)));

  const closeIfLast = () => {
    const others = Electron.BrowserWindow.getAllWindows().filter(
      (w) => w !== window && !w.isDestroyed() && w.isFocusable(),
    );
    if (others.length === 0 && window !== null && !window.isDestroyed()) {
      window.destroy();
      window = null;
    }
  };
  const follow = (_: unknown, win: Electron.BrowserWindow) => void win.once("closed", closeIfLast);
  Electron.app.on("browser-window-created", follow);
  for (const win of Electron.BrowserWindow.getAllWindows()) win.once("closed", closeIfLast);

  const mine = (event: Electron.IpcMainEvent) =>
    window !== null && event.sender === window.webContents;
  Electron.ipcMain.on(
    "baton-pill:rect",
    (event, x: unknown, y: unknown, w: unknown, h: unknown) => {
      if (!mine(event) || ![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)))
        return;
      if ((w as number) > 0 && (h as number) > 0) {
        capsule = { x: x as number, y: y as number, width: w as number, height: h as number };
        settleFrost();
      }
    },
  );
  Electron.ipcMain.on(
    "baton-pill:pointer",
    (event, type: unknown, x: unknown, y: unknown, target: unknown, buttons: unknown) => {
      if (mine(event)) trace({ kind: "pill_pointer", type, x, y, target, buttons });
    },
  );
  Electron.ipcMain.on("baton-pill:hover", (event, over: unknown) => {
    if (!mine(event) || window === null || window.isDestroyed()) return;
    trace({ kind: "pill_hover", over });
  });
  Electron.ipcMain.on("baton-pill:beat", (event) => {
    if (mine(event)) lastBeat = Date.now();
  });
  Electron.ipcMain.on("baton-pill:drag", (event, on: unknown, why: unknown) => {
    trace({ kind: "pill_drag", on, why, mine: mine(event), bounds: window?.getBounds() });
    if (!mine(event) || window === null || window.isDestroyed()) return;
    if (on === true && !moving) return;
    if (on !== true) return stopDrag(why !== "cancel", typeof why === "string" ? why : "up");
    stopDrag(false);
    const start = Electron.screen.getCursorScreenPoint();
    const from = window.getBounds();
    lastBeat = Date.now();
    dragStarted = { at: Date.now(), x: from.x, y: from.y };
    const target = window;
    openMarkers(Electron.screen.getDisplayMatching(from));
    dragTimer = setInterval(() => {
      if (target.isDestroyed()) return stopDrag(false);
      // The page says it is still holding the pointer every 120 ms; a lost release cannot leave this stuck.
      if (Date.now() - lastBeat > BEAT_TIMEOUT_MS) return stopDrag(true, "timeout");
      const cursor = Electron.screen.getCursorScreenPoint();
      const display = Electron.screen.getDisplayNearestPoint(cursor);
      const area = display.workArea;
      const snapped = snapPosition(
        area,
        { width: from.width, height: from.height },
        { x: from.x + cursor.x - start.x, y: from.y + cursor.y - start.y },
        { bypass: bypassSnap, margins: margins() },
      );
      if (snapped.place !== markerPlace && markers !== null && !markers.isDestroyed()) {
        markerPlace = snapped.place;
        void markers.webContents
          .executeJavaScript(`window.hi(${JSON.stringify(snapped.place)})`)
          .catch(() => undefined);
      }
      target.setBounds({
        x: snapped.x,
        y: snapped.y,
        width: from.width,
        height: from.height,
      });
    }, DRAG_MS);
    dragTimer.unref();
  });
  Electron.ipcMain.on("baton-pill:press", (event, on: unknown) => {
    if (mine(event)) pressing = on === true;
  });
  Electron.ipcMain.on("baton-pill:moving", (event, on: unknown) => {
    if (mine(event) && on === false) setMoving(false);
  });
  Electron.ipcMain.on("baton-pill:click", (event, dx: unknown, dy: unknown, ms: unknown) => {
    if (!mine(event) || moving) return;
    input.onDrag?.({
      reason: "click",
      dx: Number(dx) || 0,
      dy: Number(dy) || 0,
      ms: Number(ms) || 0,
    });
    input.onDismiss();
  });
  Electron.ipcMain.on("baton-pill:dictation", (event, insert: unknown) => {
    if (!mine(event)) return;
    if (hold.holding()) return endCleanup();
    input.onDictation?.(insert === true);
  });
  Electron.ipcMain.on("baton-pill:bypass", (event, on: unknown) => {
    if (mine(event)) bypassSnap = on === true;
  });
  const moveTo = (id: PlaceId) => {
    if (window === null || window.isDestroyed()) {
      build();
    }
    const target = window;
    if (target === null || target.isDestroyed()) return;
    const display = Electron.screen.getDisplayMatching(target.getBounds());
    const size = { width: WIDTH, height: HEIGHT };
    const at = placePosition(display.workArea, size, id, margins());
    spots = { any: spotFrom(display.workArea, size, at) };
    saveSpots();
    target.setBounds(boundsAt(at));
  };
  Electron.ipcMain.on("baton-pill:menu", (event) => {
    if (!mine(event) || window === null || window.isDestroyed()) return;
    Electron.Menu.buildFromTemplate([
      ...(["centre", "top", "bottom"] as const).map((id) => ({
        label: `Move to ${PLACES.find((p) => p.id === id)!.label.toLowerCase()}`,
        click: () => moveTo(id),
      })),
      { type: "separator" as const },
      { label: "Put it back", click: () => Electron.ipcMain.emit("baton-pill:reset", event) },
      ...(input.menuItems === undefined
        ? []
        : [{ type: "separator" as const }, ...input.menuItems()]),
    ]).popup({ window });
  });
  Electron.ipcMain.on("baton-pill:reset", (event) => {
    if (!mine(event) || window === null || window.isDestroyed()) return;
    const display = Electron.screen.getDisplayMatching(window.getBounds());
    spots = {};
    saveSpots();
    window.setBounds(boundsAt(placeFor(display)));
  });

  return {
    on,
    cue: (name) => sound(name),
    micLevel: (value, _shown, frame) => {
      loudest = Math.max(loudest, value);
      if ((state.phase !== "listening" && state.phase !== "dictating") || !barsWanted()) return;
      // The frame's own RMS: the page's gain adapts to his voice, so the shown level is not needed.
      sendLevel(frame === undefined ? wave_.dbOf(value) : wave_.frameDb(frame));
    },
    speechLevel: (value) => {
      const now = performance.now();
      if (state.phase !== "speaking" || now - lastSpeech < SPEECH_MS || !barsWanted()) return;
      lastSpeech = now;
      sendLevel(wave_.dbOf(value));
    },
    words: (text) => {
      if (state.phase !== "dictating" || input.showWords?.() === false) return;
      call(`window.pill.words(${JSON.stringify(text)})`);
    },
    cleanup: (raw, clean) => {
      if (input.showWords?.() === false || !tall) return;
      // Held a little past the longest cleanup until the page says how long this one plays.
      hold.holdUntil(Date.now() + PROVISIONAL_HOLD_MS);
      releaseHoldEscape ??= input.holdEscape(endCleanup);
      call(`window.pill.cleanup(${JSON.stringify(raw)},${JSON.stringify(clean)})`, (ms) => {
        if (typeof ms === "number" && ms > 0) hold.holdUntil(Date.now() + ms);
        else endCleanup();
      });
    },
    warm: build,
    setRest: (next) => {
      if (state.phase !== "idle") return;
      if (next) {
        raise();
        call(`window.pill.rest(${JSON.stringify(why)})`);
      } else lower();
    },
    setReason: (next) => {
      why = next;
      if (state.phase === "idle" && input.rest()) call(`window.pill.why(${JSON.stringify(next)})`);
    },
    reposition: () => {
      if (moving && window !== null && !window.isDestroyed()) {
        // Hiding would take the focus and end the move: it goes to its new place still movable.
        const display = Electron.screen.getDisplayMatching(window.getBounds());
        return window.setBounds(boundsAt(placeFor(display)));
      }
      if (window !== null && !window.isDestroyed()) {
        call("window.pill.hide()");
        window.hide();
      }
      stopHitTest();
      if (input.rest() && state.phase === "idle") {
        raise();
        call(`window.pill.rest(${JSON.stringify(why)})`);
      }
    },
    moveTo,
    setMoving,
    moving: () => moving,
    placed: () => sharedSpot(spots) !== undefined,
    putBack: () => {
      const display = Electron.screen.getDisplayMatching(this_anchor());
      spots = {};
      saveSpots();
      if (window !== null && !window.isDestroyed()) window.setBounds(boundsAt(placeFor(display)));
    },
    place: () => {
      const b = this_anchor();
      const display = Electron.screen.getDisplayMatching(b);
      const near = (["centre", "top", "bottom"] as const)
        .map((id) => {
          const at = placePosition(display.workArea, b, id, margins());
          return { id, d: Math.hypot(at.x - b.x, at.y - b.y) };
        })
        .sort((a, c) => a.d - c.d)[0]!;
      return near.id;
    },
    anchor: () => {
      // The capsule itself while it is up, so a card clears the island however tall it is.
      if (window !== null && !window.isDestroyed() && window.isVisible()) {
        const b = window.getBounds();
        return {
          x: b.x + capsule.x,
          y: b.y + capsule.y,
          width: capsule.width,
          height: capsule.height,
        };
      }
      if (window !== null && !window.isDestroyed()) return baseBounds(window);
      return { ...placeFor(workScreen()), width: WIDTH, height: HEIGHT };
    },
    retarget: () => {
      if (
        window === null ||
        window.isDestroyed() ||
        !window.isVisible() ||
        moving ||
        dragTimer !== null
      )
        return;
      const display = workScreen();
      if (display.id === Electron.screen.getDisplayMatching(window.getBounds()).id) return;
      window.setBounds(boundsAt(placeFor(display)));
    },
    state: () => state,
    dispose: () => {
      stopLook();
      if (timer !== null) clearTimeout(timer);
      if (silentTimer !== null) clearTimeout(silentTimer);
      closeMarkers();
      if (hitTimer !== null) clearInterval(hitTimer);
      releaseMoveEscape?.();
      Electron.app.removeListener("browser-window-created", follow);
      setEscape(false);
      stopDrag(false);
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
};
