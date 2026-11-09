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
import { LISTENING_WEBP, STING_WEBP } from "./pillMotionArt.ts";
import { TRAY_PNG } from "./trayArt.ts";
import { isPillClick } from "./pillGesture.ts";
import {
  ISLAND_CSS,
  ISLAND_HEIGHT,
  ISLAND_HTML,
  ISLAND_MEASURE,
  ISLAND_SCRIPT,
} from "./pillIsland.ts";
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
  type TurnState,
  type WaveMode,
} from "@t3tools/baton-shared/voiceTurn";
import { PILL_BANDS, createBandGain, frameBands } from "@t3tools/baton-shared/voiceBands";

const WIDTH = 420;
// Room above the capsule for the Move pill check mark; the margins take it back, so the capsule sits where it did.
const HEIGHT = 80;
/** Clear of a dictation bar in Wispr's place at the bottom edge, so both can show. */
const ABOVE_WORK_AREA = 30;
const TOP_MARGIN = -4;
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

/**
 * The pill: black in every theme, 24 px tall, nothing it does not need. A live waveform while he or
 * Baton is speaking; otherwise one short word; soft text only for an error or where words go. No
 * icon, no button, no shadow beyond a hairline. The bars are a canvas that animates only while a live waveform is up.
 */
export const PILL_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--ink:#0d0d11;--line:rgba(255,255,255,.14);--text:#f6f6f8;--soft:#9d9da8;--blue:#9dc1ff;--woad:#5FB3B3;--green:#3fce8e;--amber:#ffb454;--red:#ff7b7b;
--sans:"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
html,body{height:100%;margin:0;overflow:hidden;background:transparent;font:600 12px/1 var(--sans);-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;cursor:default}
body{box-sizing:border-box;display:flex;align-items:flex-end;justify-content:center;padding-bottom:28px}
#p{box-sizing:border-box;display:flex;align-items:center;gap:7px;height:24px;max-width:${WIDTH - 16}px;padding:0 11px;border-radius:999px;background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,0) 55%),var(--ink);border:1px solid var(--line);box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 0 0 1px rgba(0,0,0,.5);color:var(--text);position:relative;touch-action:none;opacity:0;transform:translateY(4px);transition:opacity .12s,transform .16s cubic-bezier(.2,.8,.2,1),border-color .15s}
#p.on{opacity:1;transform:none}
body.moving #p{cursor:grab;border:1px dashed var(--blue)}
body.moving #p.drag{cursor:grabbing}
#ok{display:none;position:absolute;left:50%;bottom:54px;transform:translateX(-50%);box-sizing:border-box;width:24px;height:24px;padding:0;margin:0;border-radius:50%;border:1px solid var(--line);background:var(--ink);color:var(--green);cursor:pointer;align-items:center;justify-content:center}
body.moving #ok{display:flex}
#ok:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
#p.drag::before{content:"";position:absolute;inset:-10px}
#p.rest{margin-bottom:9px;height:6px;width:36px;padding:0;gap:0;border-color:rgba(255,255,255,.4);background:rgba(13,13,17,.78)}
#p.rest[data-rest=muted]{border-color:var(--amber)}
#p.rest[data-rest=off]{border-style:dashed;border-color:rgba(255,255,255,.3);background:rgba(13,13,17,.4);box-shadow:none}
#p.rest>*{display:none}
#mk{display:none;width:20px;height:20px;flex:none}
#p[data-mark=on] #mk[src]{display:block}
@keyframes br{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
#p:hover #mk[src]{animation:br 2.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){#mk{animation:none!important}}
html.motion-reduced #mk,html.motion-off #mk{animation:none!important}
#w{display:none;width:54px;height:16px;flex:none}
#p[data-wave=on] #w{display:block}
#d{display:none;align-items:center;gap:4px;height:14px;flex:none}
#d b{display:block;width:4px;height:4px;border-radius:50%;background:#fff;opacity:.25;animation:step 1350ms steps(1,end) infinite}
#d b:nth-child(2){animation-delay:450ms}
#d b:nth-child(3){animation-delay:900ms}
@keyframes step{0%{opacity:1}33.33%{opacity:.25}100%{opacity:.25}}
#p[data-dots=on] #d{display:flex}
#st{display:none;color:var(--soft);font-weight:500;padding-left:2px;border-left:1px solid var(--line);padding-left:7px}
#p[data-phase=speaking] #st,#p[data-phase=working] #st{display:block}
/* While Tessaya works the pill is its only sign on screen, and a click on it stops the work. */
#p[data-phase=working] #st{order:1}
#t{white-space:nowrap}
#t:empty,#c:empty{display:none}
#c{color:var(--soft);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* Dictation's bars are neutral; Woad, Tessaya's accent, is only for a conversation the wake word started; red only for an error. */
#p[data-phase=dictating]{--bar:#ececef}
#p[data-phase=listening],#p[data-phase=thinking],#p[data-phase=speaking],#p[data-phase=working]{--bar:var(--woad)}
#p[data-tone=good] #t{color:var(--green)}
#p[data-tone=off] #t{color:var(--soft)}
#p[data-phase=error]{border-color:var(--red)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:reduce){#p{transition:none}#d b{animation:none;opacity:.7}}
html.motion-reduced #p,html.motion-off #p{transition:none}html.motion-reduced #d b,html.motion-off #d b{animation:none;opacity:.7}
html.glass-reduced #p.rest,html.glass-off #p.rest{background:var(--ink)}
.db{display:none;position:relative;box-sizing:border-box;width:18px;height:18px;padding:0;margin:0 -2px;border-radius:50%;border:0;background:transparent;color:var(--soft);cursor:pointer;align-items:center;justify-content:center;flex:none}
.db::before{content:"";position:absolute;inset:-5px;border-radius:50%}
.db:hover{background:rgba(255,255,255,.12);color:var(--text)}
#dv{color:var(--text)}
.db:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
#p[data-phase=dictating][data-voice=on] .db{display:flex}
/* The tall window grew downward (no room above it): everything hangs from the top, at the same place. */
body.down{align-items:flex-start;padding-bottom:0;padding-top:28px}
body.down #ok{bottom:auto;top:2px}
body.down #p.rest{margin-bottom:0;margin-top:9px}
body.down #p.isl{bottom:auto;top:18px}
${ISLAND_CSS}</style></head><body><button id="ok" type="button" aria-label="Save pill position" title="Save pill position"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div id="p" role="status" aria-live="polite"><img id="mk" alt="" width="20" height="20"><button id="dx" class="db" type="button" aria-label="Discard the dictation" title="Discard (Esc)"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8M8 2 2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><canvas id="w" width="54" height="16" aria-hidden="true"></canvas><button id="dv" class="db" type="button" aria-label="Insert the dictation" title="Insert"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><span id="d"><b></b><b></b><b></b></span><span id="st">Stop</span><span id="t"></span><span id="c"></span><span id="sr" class="sr"></span>${ISLAND_HTML}</div>${ISLAND_MEASURE}
<script>
const $=i=>document.getElementById(i),N=${PILL_BANDS},SOUNDS=${JSON.stringify(PILL_SOUNDS)},PARTIAL=${PILL_PARTIAL},WAVE=${JSON.stringify(WAVE_PHASES)};
const reduce=matchMedia('(prefers-reduced-motion:reduce)'),root=document.documentElement.classList;
const isCalm=()=>reduce.matches||root.contains('motion-reduced')||root.contains('motion-off');
const ART={sting:'data:image/webp;base64,${STING_WEBP}',listening:'data:image/webp;base64,${LISTENING_WEBP}',still:'data:image/png;base64,${TRAY_PNG["white-40"]}'};
// The mark only in a conversation the wake word started, never while he dictates.
const MARKED=['listening','thinking','speaking','working'];
let shown='none',stinging=false,want='still',stingTimer=0;
// One image at a time, swapped for a new element so an animation starts from its first frame; gone when nothing is up.
const setMark=name=>{if(name===shown)return;shown=name;const m=$('mk'),n=m.cloneNode();if(name==='none')n.removeAttribute('src');else n.src=ART[name];m.replaceWith(n);};
// The waveform: one bar per band, low bands at the centre. A message only raises a bar's target; the frame loop
// rises to it fast and falls back slowly, and runs only while a live waveform is up and motion is allowed.
const cv=$('w'),g=cv.getContext('2d'),W=54,H=16,RIPPLE_MS=2000,SWEEP_MS=8000;
// Sharp at any scale, fractional ones too; refitted when the window moves to a display of another scale.
const fit=()=>{const r=devicePixelRatio||1;cv.width=Math.round(W*r);cv.height=Math.round(H*r);g.setTransform(r,0,0,r,0,0);if(mode!=='off'&&!raf)drawBars(null,0);matchMedia('(resolution: '+r+'dppx)').addEventListener('change',fit,{once:true});};
const slot=Array.from({length:N},(_,b)=>Math.round((N-1)/2+(b%2?1:-1)*(Math.floor(b/2)+.5)));
const taper=slot.map(x=>{const d=Math.abs(x-(N-1)/2)/((N-1)/2);return 1-.35*d*d;});
const tgt=new Float32Array(N),lvl=new Float32Array(N);
let ctx=null,mode='off',raf=0,last=0,since=0,color='#fff',glow='#fff',bw=2.5,look='';
const take=v=>{if(mode!=='live'||isCalm())return;const t=performance.now();for(let i=0;i<N;i++){const x=v.length===1?v[0]/255*(.45+.55*Math.abs(Math.sin(t/90+i*1.9))):v[i]/255;if(x>tgt[i])tgt[i]=x;}kick();};
// Up to 60 fps while something moves: a ripple for the first 2 s, his voice, or the tidy sweep (bounded). Settled, it draws the rest once and stops.
const paint=t=>{raf=0;if(mode==='off')return;if(isCalm()){lvl.fill(0);drawBars(null,0);return;}
 const dt=last?Math.min(64,t-last):16;if(last&&dt<15){raf=requestAnimationFrame(paint);return;}last=t;
 const up=1-Math.exp(-dt/22),down=1-Math.exp(-dt/170);let e=0,pending=0;
 for(let i=0;i<N;i++){pending+=tgt[i];lvl[i]+=(tgt[i]-lvl[i])*(tgt[i]>lvl[i]?up:down);tgt[i]=0;e+=lvl[i];}
 const age=t-since;
 if(mode==='sweep'?age>SWEEP_MS:age>RIPPLE_MS&&pending===0&&e<.005*N){lvl.fill(0);drawBars(null,0);return;}
 drawBars(t,e/N);raf=requestAnimationFrame(paint);};
const drawBars=(t,e)=>{g.clearRect(0,0,W,H);g.fillStyle=color;g.shadowColor=glow;g.shadowBlur=mode==='live'&&e>.04?Math.min(8,14*e):0;const step=W/N,fade=t===null?0:Math.max(0,1-(t-since)/RIPPLE_MS);
 for(let b=0;b<N;b++){const x=slot[b];let rest=.16,alpha=1;
  if(mode==='live'&&fade>0)rest=.16+.07*fade*Math.sin(t/240-x*.6);
  // Tidying: the bars lie low and a slow light runs across them, left to right.
  if(mode==='sweep'){rest=.2;alpha=t===null?.6:.3+.7*Math.max(0,Math.cos(Math.PI*(x/(N-1)-(t%1500)/1500*1.6+.3)))**3;}
  const h=Math.max(2,(rest+(1-rest)*lvl[b]*taper[b])*H);g.globalAlpha=alpha;g.beginPath();g.roundRect(x*step+(step-bw)/2,(H-h)/2,bw,h,bw/2);g.fill();}
 g.globalAlpha=1;};
const kick=()=>{if(!raf&&mode!=='off'&&!isCalm()){last=0;raf=requestAnimationFrame(paint);}};
// Reduced motion: drawn once, still, and no loop.
const setMode=m=>{const p=$('p'),isl=p.classList.contains('isl'),key=p.dataset.phase+'/'+p.dataset.tone+'/'+isl;if(key!==look){look=key;const cs=getComputedStyle(p);color=cs.getPropertyValue('--bar').trim()||'#fff';glow=isl?cs.getPropertyValue('--glow').trim()||'transparent':color;bw=p.dataset.phase==='speaking'?3:2.5;}
 if(m!==mode)since=performance.now();mode=m;if(m==='off'){lvl.fill(0);tgt.fill(0);cancelAnimationFrame(raf);raf=0;return;}if(isCalm()){lvl.fill(0);drawBars(null,0);}else kick();};
fit();
const note=(n,start)=>{for(const[f,g]of[[n.hz,n.gain],[n.hz*2,n.gain*PARTIAL]]){const o=ctx.createOscillator(),a=ctx.createGain(),t=start+n.at;o.type='sine';o.frequency.value=f;a.gain.setValueAtTime(0,t);a.gain.linearRampToValueAtTime(g,t+.004);a.gain.exponentialRampToValueAtTime(g*.002,t+n.len);o.connect(a).connect(ctx.destination);o.start(t);o.stop(t+n.len+.02);}};
const ipcRenderer=window.pillIpc||{send(){}};
ipcRenderer.onBands?.(take);
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
// The capsule's box goes to the main process, which decides by the cursor position when the window takes the mouse, so a missed forwarded mousemove cannot leave the pill dead.
// The island resizes every frame while it moves: only a change of a few pixels is worth a message.
let sentRect='';const sendRect=()=>{const r=grab.getBoundingClientRect(),o=$('ok').getBoundingClientRect(),k=moving()&&o.width>0;
 const x=k?Math.min(r.left,o.left):r.left,y=k?Math.min(r.top,o.top):r.top,w=(k?Math.max(r.right,o.right):r.right)-x,h=(k?Math.max(r.bottom,o.bottom):r.bottom)-y,key=[x,y,w,h].map(n=>Math.round(n/3)).join();if(key===sentRect)return;sentRect=key;ipcRenderer.send('baton-pill:rect',x,y,w,h);};
new ResizeObserver(sendRect).observe(grab);addEventListener('load',sendRect);
for(const t of['pointerdown','pointerup','pointermove','pointercancel'])addEventListener(t,e=>ipcRenderer.send('baton-pill:pointer',t,e.clientX,e.clientY,e.target&&e.target.id||e.target.tagName,e.buttons),true);
let bypass=false;const setBypass=e=>{const b=e.altKey||e.shiftKey;if(b!==bypass){bypass=b;ipcRenderer.send('baton-pill:bypass',b);}};
${ISLAND_SCRIPT}
addEventListener('pointermove',setBypass);addEventListener('pointerdown',setBypass);addEventListener('keydown',setBypass);addEventListener('keyup',setBypass);
window.pill={
 show(v){const p=$('p'),wave=WAVE.includes(v.phase);const marked=MARKED.includes(v.phase);p.dataset.mark=marked?'on':'off';want=!marked?'none':isCalm()||v.phase!=='listening'?'still':'listening';if(!stinging)setMark(want);p.dataset.tone=v.tone;p.dataset.phase=v.phase;
  // Dictation's island: a new one for each recording; any other phase puts the plain pill back.
  if(v.island!==true)island.stop();else if(v.fresh===true||!island.on())island.start();p.className=island.on()?'on isl':'on';p.dataset.esc=island.on()&&/Esc again/.test(v.caption||'')?'on':'off';p.dataset.wave=wave?'on':'off';p.dataset.dots=v.phase==='thinking'||v.phase==='working'?'on':'off';p.setAttribute('aria-label',v.label);if($('sr').textContent!==v.label)$('sr').textContent=v.label;
  setMode(!wave||v.wave==='flat'?'off':v.wave);if(island.on()&&v.wave==='sweep')island.release();
  // A word only when the waveform does not say it; soft text only for where words go or an error.
  $('t').textContent=wave||v.phase==='ended'||v.phase==='thinking'?'':v.label;
  p.dataset.voice=v.voice?'on':'off';
  $('c').textContent=v.phase==='ended'?'Say the wake word':v.phase==='dictating'?(v.caption||''):(v.caption&&/^to /.test(v.caption)?v.caption:'');},
 rest(why){island.stop();const p=$('p');p.className='on rest';p.dataset.mark='off';clearTimeout(stingTimer);stinging=false;setMark('none');delete p.dataset.phase;delete p.dataset.tone;p.dataset.wave='off';p.dataset.dots='off';p.dataset.rest=why||'sleeping';setMode('off');},
 hide(){if(I)I.until=0;$('p').className=island.on()?'isl':'';$('p').dataset.mark='off';setMode('off');clearTimeout(stingTimer);stinging=false;setMark('none');},
 sting(){if(isCalm())return;clearTimeout(stingTimer);stinging=true;shown='';setMark('sting');stingTimer=setTimeout(()=>{stinging=false;setMark(want);},2050);},
 move(){island.stop();const p=$('p');p.className='on';p.dataset.mark='off';p.dataset.wave='off';setMode('off');p.dataset.dots='off';p.dataset.tone='voice';p.dataset.phase='move';$('t').textContent='Drag to move';$('c').textContent='';sendRect();},
 moving(on){document.body.classList.toggle('moving',on);if(on)$('ok').focus();sendRect();},
 why(w){const p=$('p');if(p.classList.contains('rest'))p.dataset.rest=w;},
 words(text){island.words(text);},
 cleanup(raw,clean){const ms=island.cleanup(raw,clean);if(ms>0){setMode('off');drawBars(null,0);}return ms;},
 sound(name,gain){ctx??=new AudioContext();const t=ctx.currentTime+.01;for(const n of SOUNDS[name])note({...n,gain:n.gain*gain},t);return ctx.state+':'+SOUNDS[name].length;},
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
  /** Where the window goes for a spot of the 80 px pill; tall, it grows without moving the capsule. */
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
  /** The 80 px pill's bounds, whatever the window's height: what places, saves and anchors use. */
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
    if (frost !== null && !frost.isDestroyed() && frost.isVisible()) frost.hide();
  };
  /** Hidden while the island moves, laid under the capsule once it holds still; the tint shows meanwhile. */
  const settleFrost = () => {
    hideFrost();
    if (!tall || input.frosted?.() !== true || (input.look?.().glass ?? "on") !== "on") return;
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
  };

  const raise = () => {
    hold.raised();
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
        `window.pill.show(${JSON.stringify({ ...view, phase: state.phase, voice: input.voiceDictating?.() === true, island, fresh })})`,
      );
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

  const bandGain = createBandGain();
  const bandBytes = new Uint8Array(PILL_BANDS);
  const levelByte = new Uint8Array(1);
  /** The bars are wanted: a live waveform on a visible pill, with motion on (the page draws them still otherwise). */
  const barsWanted = () =>
    wave === "live" &&
    window !== null &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.webContents.isLoading() &&
    (input.look?.().motion ?? "full") === "full";
  /** Bars as bytes over IPC, one message a microphone frame (50 a second); one byte is a level without bands. */
  const sendBars = (bars: ArrayLike<number>) => {
    const out = bars.length === 1 ? levelByte : bandBytes;
    for (let i = 0; i < out.length; i += 1)
      out[i] = Math.round(Math.max(0, Math.min(1, bars[i] ?? 0)) * 255);
    window?.webContents.send("baton-pill:bands", out);
  };

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
    micLevel: (value, shown = value, frame) => {
      loudest = Math.max(loudest, value);
      if ((state.phase !== "listening" && state.phase !== "dictating") || !barsWanted()) return;
      sendBars(frame === undefined ? [shown] : bandGain(frameBands(frame), shown));
    },
    speechLevel: (value) => {
      const now = performance.now();
      if (state.phase !== "speaking" || now - lastSpeech < SPEECH_MS || !barsWanted()) return;
      lastSpeech = now;
      sendBars([value]);
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
