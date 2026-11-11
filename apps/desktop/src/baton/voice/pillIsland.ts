/**
 * Dictation's island in the pill's page (PILL-V2 "E"): his words as recognised, then the cleanup played over them
 * after the paste. A port of the prototype's engine (tessaya-ops drafts/pill/v2/proto/src/template_final.html);
 * each frame is a function of the time, drawn only while something moves.
 */
import { pillEngine } from "./pillTimeline.ts";

/** The pill window's width; the island is never wider. */
export const ISLAND_WIDTH = 420;
/** The window grows upward to this while the island is up: the head, 12 lines and their padding, over the margin. */
export const ISLAND_HEIGHT = 280;
/** The window's margin under the capsule, plain or island. */
export const PILL_BELOW = 6;
/** The pill window's own height: the tallest capsule (34 px) and a little air. */
export const PILL_HEIGHT = 40;
/** The capsule's bottom edge, from the top of the pill's own window: where a window grown downward hangs it. */
export const PILL_LINE = PILL_HEIGHT - PILL_BELOW;

/**
 * The island in each design. Tessaya and Quiet: one surface, #p, that fills the window and shows only the capsule
 * its clip-path cuts (drawn each frame by drawI), so it grows without animating its size. Lively: the pill's pebbles
 * stay as they are and the words sit on a card of their own above them, cut the same way.
 */
export const ISLAND_CSS = `
#vc{display:none;position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
#p.isl #vc{display:block}
#p.isl{left:0;top:0;bottom:auto;width:100%!important;height:100%!important;translate:none;transition:none;clip-path:inset(100%)}
#p.isl #row{position:absolute;left:0;top:0;bottom:auto;translate:none;width:0;height:0;padding:0;animation:none}
#p.isl #row>*{position:absolute;left:0;top:0;margin:0}
#p.isl #row>#wv{display:contents}
#p.isl #wv>*{position:absolute;left:0;top:0;margin:0}
#p.isl :is(#mk,#gl,#d,#t,#c,#st,#bal){display:none!important}
#p.isl[data-esc=on] #dx{color:var(--fail)}
:root[data-design=lively] #p.isl{left:50%;top:auto;bottom:${PILL_BELOW}px;width:auto!important;height:auto!important;translate:-50% 0;clip-path:none}
:root[data-design=lively] #p.isl #row{position:relative;width:auto;height:auto}
:root[data-design=lively] #p.isl #row>*,:root[data-design=lively] #p.isl #wv>*{position:relative}
:root[data-design=lively] #p.isl #row>#wv{display:flex}
:root[data-design=lively] #p.isl #vc{left:50%;top:auto;bottom:calc(100% + 6px);translate:-50% 0;width:${ISLAND_WIDTH - 8}px;height:${ISLAND_HEIGHT - PILL_BELOW - 34 - 6}px;background:var(--surf);clip-path:inset(100%)}
:root[data-design=lively] body.down #p.isl{top:${PILL_LINE}px;bottom:auto;translate:-50% -100%}
:root[data-design=lively] body.down #p.isl #vc{bottom:auto;top:calc(100% + 6px)}
#vp{display:none;position:absolute;left:0;top:0;overflow:hidden;font:400 16px/22px var(--font);pointer-events:none}
:root[data-design=tessaya] #vp,:root[data-design=tessaya] #mE{font:420 20px/26px var(--said);letter-spacing:-.005em}
:root[data-design=lively] #vp,:root[data-design=lively] #mE{line-height:23px}
#p.isl #vp{display:block}
#vp span{position:absolute;left:0;top:0;white-space:pre}
#vp span.m span{position:static}
#vp span.m .slot{position:relative;display:inline-block;vertical-align:top;height:1em}
#vp span.m .g{position:absolute;left:0;top:0;transform-origin:0 85%}
#mE{position:absolute;visibility:hidden;left:0;top:0;font:400 16px/22px var(--font)}
#mE span{display:inline-block;vertical-align:top;white-space:pre}
`;

export const ISLAND_HTML = `<div id="vc"><div id="vp" aria-hidden="true"></div></div>`;
export const ISLAND_MEASURE = `<div id="mE" aria-hidden="true"></div>`;

/**
 * D's words as a field lays them out: from the caret's place on its line (`indent`), each word on the line while it
 * fits in the text box's `width`, else at the start of the next. A word wider than the box keeps a line of its own.
 * Self-contained: it runs in the ghost's page too.
 */
export const flowWords = (
  widths: ReadonlyArray<number>,
  space: number,
  width: number,
  indent: number,
  line: number,
): Array<{ x: number; y: number; w: number }> => {
  let x = indent;
  let y = 0;
  return widths.map((w) => {
    if (x > 0 && x + w > width) {
      x = 0;
      y += line;
    }
    const at = { x, y, w };
    x += w + space;
    return at;
  });
};

/**
 * How far D's text scrolls up so its last line stays in the field, in whole lines, as a textarea does: its first line
 * starts `top` down the box, and the box is `height` tall.
 */
export const ghostScroll = (lines: number, top: number, line: number, height: number): number => {
  const over = top + lines * line - height;
  return over <= 0 ? 0 : Math.ceil(over / line) * line;
};

/**
 * "E" draws the words in the pill's capsule (needs the page's `$` and `isCalm`, and #p, #dx, #dv, #w); "D" draws
 * them where they will land, in a ghost window over his field (`setField` gives its font, line and width).
 */
export const wordsScript = (variant: "E" | "D"): string => `
const {clamp,prog,EMPH,DECEL,ACCEL,MD,FLOW,EXPAND_MS,SMOOTH,springAt,align,cleanupTimes,stepWidth}=(${pillEngine.toString()})();
const D=${variant === "D"},LIVE_LINES=D?99:5,MAXW=${ISLAND_WIDTH},FLOW01=[{at:0,to:0},{at:0,to:1}];
// E's measures come from the design on show (islandLook, at each start); D only uses PH and PAD for nothing.
let PH=26,PBASE=76,PAD=8,PADX=12,WT=0,TMAX=MAXW-24,IS={lively:false,cr:20};
const SHRINK_MS=D?0:600;
const flowWords=${flowWords.toString()},ghostScroll=${ghostScroll.toString()};
let ALL_LINES=7,I=null,iraf=0,LINE=20,FW=0,INDENT=0,TOP=0,BOXH=0,FONT=14,EMPTY=false;
// D: the field's own font, line height, text width, where the caret sits on its line, and the text box it scrolls in.
const setField=(fontPx,linePx,width,indent,top,height)=>{LINE=linePx;FW=width;INDENT=indent;TOP=top;BOXH=height;FONT=fontPx;for(const el of[vp,mE])el.style.font='400 '+fontPx+'px/'+linePx+'px var(--sans)';};
const scD=lines=>ghostScroll(lines,TOP,LINE,BOXH);
const vp=$('vp'),mE=$('mE');
const measure=(words,width)=>{mE.textContent='';mE.style.width=width===null?'auto':width+'px';mE.style.whiteSpace=width===null?'nowrap':'normal';mE.style.textIndent=width===null?'0':INDENT+'px';
 return words.map((w,i)=>{if(i)mE.appendChild(document.createTextNode(' '));const s=document.createElement('span');s.textContent=w;mE.appendChild(s);return s;});};
// D lays the words out itself (flowWords) from their measured widths, so they wrap as his field does.
const layD=(words,width)=>{const sp=measure(words,null),ws=sp.map(s=>s.offsetWidth);
 const gap=sp.length>1?sp[1].offsetLeft-sp[0].offsetLeft-ws[0]:FONT*.28;return flowWords(ws,gap,width,INDENT,LINE);};
const lay=(words,width)=>D?layD(words,width):measure(words,width).map(s=>({x:s.offsetLeft,y:s.offsetTop}));
const layLine=words=>measure(words,null).map(s=>s.offsetLeft);
const oneLine=words=>{measure(words,null);return mE.offsetWidth;};
const linesOf=pos=>pos.length?Math.round(pos[pos.length-1].y/LINE)+1:0;
// The lines the window has room for (a short screen gives the island less).
const roomLines=()=>D?99:Math.max(1,Math.floor((innerHeight-${PILL_BELOW}-PH-PAD-6)/LINE));
const hOf=lines=>lines>0?Math.min(ALL_LINES,lines)*LINE+PAD:0;
const wOf=t=>Math.max(PBASE,t+2*PADX);
const mk=t=>{const s=document.createElement('span');s.textContent=t;vp.appendChild(s);return s;};
const textC=D?'var(--field-ink)':'var(--text)',greyC=D?'var(--ghost-drop)':'var(--grey)',liveC=D?'var(--ghost)':textC;
const mix=a=>p=>p>=1?a:p<=0?greyC:'color-mix(in srgb,'+a+' '+Math.round(p*100)+'%,'+greyC+')',mixC=mix(textC),mixL=mix(liveC);
const place=(s,x,y,o,blur=0,extra='')=>{s.style.transform='translate('+x.toFixed(2)+'px,'+y.toFixed(2)+'px)'+extra;s.style.opacity=o.toFixed(3);s.style.filter=blur>.05?'blur('+blur.toFixed(2)+'px)':'';};
const hide=s=>{if(s)s.style.opacity='0';};
const kickI=until=>{if(!I)return;I.until=Math.max(I.until,until);if(!iraf)iraf=requestAnimationFrame(tickI);};
const tickI=()=>{iraf=0;if(!I)return;const t=performance.now();drawI(t);if(t<I.until)iraf=requestAnimationFrame(tickI);};
// A newer partial keeps the words it shares with the last one; the rest appear as they arrive.
const setWords=(next,now)=>{let k=0;while(k<next.length&&k<I.raw.length&&next[k]===I.raw[k])k++;
 if(k===next.length&&k===I.raw.length)return;
 for(const s of I.rawS.splice(k))s.remove();I.appear.length=k;
 for(let i=k;i<next.length;i++){I.rawS.push(mk(next[i]));I.appear.push(now);}
 I.raw=next;I.tw=D?FW:stepWidth(I.tw,oneLine(next),TMAX);const pos=lay(next,I.tw),lines=linesOf(pos);
 I.steps.push({t:now,n:next.length,width:I.tw,pos,lines});
 I.W.push({at:now,to:wOf(I.tw)});I.Hh.push({at:now,to:Math.min(LIVE_LINES,lines)*LINE+PAD});I.Sc.push({at:now,to:D?scD(lines):Math.max(0,lines-LIVE_LINES)*LINE});
 kickI(now+1200);};
const island={
 on:()=>I!==null,
 hasWords:()=>I!==null&&I.raw.length>0,
 // The design or theme changed under it: measured again, drawn again.
 restyle(){if(!I||D)return;islandLook();drawI(performance.now());kickI(performance.now()+50);},
 start(){island.stop();if(!D)islandLook();I={raw:[],appear:[],rawS:[],steps:[],tw:0,W:[{at:0,to:PBASE}],Hh:[{at:0,to:0}],Sc:[{at:0,to:0}],R:null,C:null,P:Infinity,rawLines:0,until:0};
  // Drawn now, not a frame later: the island is centred from its first frame.
  if(!D)drawI(performance.now());kickI(performance.now()+50);},
 stop(){I=null;cancelAnimationFrame(iraf);iraf=0;vp.textContent='';if(D){vp.appendChild(Object.assign(document.createElement('i'),{id:'cr'}));return;}const p=$('p');p.style.clipPath='';$('vc').style.clipPath='';VIS=null;box={W:0,H:0,w:0,h:0,r:0};
  for(const id of['dx','dv','w','mic']){const s=$(id).style;s.opacity='';s.transform='';}},
 words(text){if(!I||I.R!==null)return;setWords(text.split(/\\s+/).filter(Boolean),performance.now());},
 // His ✓ (or the key's release): the pill opens to every line and the view scrolls back to the top, 0.75 s.
 release(){if(!I||I.R!==null)return;const now=performance.now();I.R=now;I.rawLines=I.steps.length?I.steps[I.steps.length-1].lines:0;
  ALL_LINES=Math.min(roomLines(),Math.max(7,Math.min(12,I.rawLines)));I.HhLive=I.Hh.slice();I.ScLive=I.Sc.slice();kickI(now+EXPAND_MS+100);},
 // The pasted text: the cleanup plays from here. Returns how long it will be on screen, in ms (0: nothing to show).
 cleanup(rawText,cleanText){if(!I||I.raw.length===0)return 0;if(I.R===null)island.release();
  const raw=rawText.split(/\\s+/).filter(Boolean),clean=cleanText.split(/\\s+/).filter(Boolean);if(raw.length===0||clean.length===0)return 0;
  const now=performance.now();setWords(raw,now);
  const last=I.steps[I.steps.length-1],TW=last.width,rawP=last.pos,rawLines=last.lines;I.rawLines=rawLines;
  const ops=align(raw,clean),toks=[];
  ops.forEach(o=>{if(o.op==='keep'||o.op==='sub')toks.push({j:o.j,i:o.i,sub:o.op==='sub',punct:o.op==='keep'&&raw[o.i]!==clean[o.j]});else if(o.op==='ins')toks.push({j:o.j,i:null});});
  toks.forEach(k=>{k.text=clean[k.j];if(k.i!==null)k.from=rawP[k.i];});
  // Each line keeps its own words and closes its gaps; an emptied line closes up.
  let ln=0;toks.forEach(k=>{if(k.i!==null)ln=Math.round(rawP[k.i].y/LINE);k.lineA0=ln;});
  const usedA=[...new Set(toks.map(k=>k.lineA0))].sort((a,b)=>a-b);
  for(const l of usedA){const row=toks.filter(k=>k.lineA0===l);const xs=layLine(row.map(k=>k.text));row.forEach((k,n)=>{k.A={x:xs[n],y:usedA.indexOf(l)*LINE};});}
  // The clean paragraph in its natural wrap.
  const posB=lay(clean,TW);toks.forEach(k=>{k.B=posB[k.j];});const linesB=linesOf(posB);
  const lineOf=y=>Math.round(y/LINE);
  toks.forEach(k=>{k.change=k.i!==null&&lineOf(k.from.y)!==lineOf(k.B.y);});
  // A word sliding home just in front of an arriving one would be in its way: it crossfades into place too.
  for(let changed=true;changed;){changed=false;toks.forEach((k,n)=>{if(!(k.change||k.i===null))return;const o=toks[n-1];
   if(o&&o.i!==null&&!o.change&&lineOf(o.B.y)===lineOf(k.B.y)&&Math.abs(o.from.x-o.B.x)>10){o.change=true;changed=true;}});}
  // A word arriving at a line comes in once the words sliding home in front of it have cleared its spot, never before 0.4.
  const wOf2=k=>k.text.length*8;
  toks.forEach(k=>{if(!(k.change||k.i===null)){k.inP=0;return;}let p0=.4;
   for(const o of toks){if(o===k||o.change||o.i===null||lineOf(o.B.y)!==lineOf(k.B.y)||o.B.x>=k.B.x)continue;
    const dx=o.from.x-o.B.x;if(lineOf(o.from.y)!==lineOf(o.B.y)||dx<=0)continue;
    p0=Math.max(p0,1-(k.B.x-4-o.B.x-wOf2(o))/dx);}
   k.inP=Math.min(.85,p0);});
  ALL_LINES=Math.min(roomLines(),Math.max(7,Math.min(12,Math.max(rawLines,usedA.length,linesB))));
  const C=cleanupTimes(Math.max(rawLines>LIVE_LINES?EXPAND_MS:0,now-I.R));
  Object.assign(I,{C,P:I.R+C.PASTE,toks,rawP,linesB,clean,drops:ops.filter(o=>o.op==='drop').map(o=>o.i)});
  // Once the words have gone the capsule springs back to the plain pill, as the prototype ends.
  I.W.push({at:I.P+C.OUT_D,to:PBASE});
  // One span per new spelling, one landing copy per wrapped or inserted word; a punctuation or case change morphs
  // only the characters that change, in a slot whose width follows them.
  toks.forEach(k=>{if(k.sub)k.subS=mk(k.text);if(k.i===null||k.change)k.landS=mk(k.text);
   if(k.punct){const a=raw[k.i],b=k.text;let pre=0;while(pre<a.length&&pre<b.length&&a[pre]===b[pre])pre++;
    let suf=0;while(suf<a.length-pre&&suf<b.length-pre&&a[a.length-1-suf]===b[b.length-1-suf])suf++;
    const el=document.createElement('span');el.className='m';const part=t=>{const x=document.createElement('span');x.textContent=t;return x;};
    const slot=part(''),o=part(a.slice(pre,a.length-suf)),n=part(b.slice(pre,b.length-suf));slot.className='slot';o.className='g';n.className='g';
    slot.append(o,n);el.append(part(a.slice(0,pre)),slot,part(a.slice(a.length-suf)));vp.appendChild(el);
    k.morph={el,slot,o,n,wo:o.offsetWidth,wn:n.offsetWidth,end:suf===0};}});
  kickI(I.P+C.OUT_D+SHRINK_MS);return Math.ceil(I.P+C.OUT_D+SHRINK_MS-now);},
};
// D's caret, after the last word: it follows the end of the text, still (no blink).
const caretAt=(pos,o)=>{const cr=$('cr');if(!cr)return;if(!pos||pos.w===undefined){cr.style.opacity='0';return;}
 cr.style.height=LINE+'px';place(cr,pos.x+pos.w+1,pos.y,o);};
const morphAt=(M,q)=>{M.slot.style.width=(M.wo+(M.wn-M.wo)*q).toFixed(2)+'px';
 if(M.end){M.o.style.transform='scale('+(1-.4*q).toFixed(3)+')';M.n.style.transform='scale('+(.6+.4*q).toFixed(3)+')';}
 else{M.o.style.transform='translateY('+(-.35*q).toFixed(3)+'em)';M.n.style.transform='translateY('+(.35*(1-q)).toFixed(3)+'em)';}
 M.o.style.opacity=String(1-q);M.n.style.opacity=String(q);};
// E: the design's measures, read from the page as the island starts (the pill's row is already the dictation pill).
let VIS=null;
const islandLook=()=>{const p=$('p'),row=$('row'),design=document.documentElement.dataset.design;
 const lively=design==='lively',had=p.classList.contains('isl');
 // Measured as the plain pill: the island starts as exactly the pill he sees.
 p.classList.remove('isl');const rr=row.getBoundingClientRect(),size=id=>{const e=$(id);return [e.offsetWidth,e.offsetHeight];};
 const parts={dx:size('dx'),dv:size('dv'),mic:size('mic'),w:size('w')};if(had)p.classList.add('isl');
 LINE=parseFloat(getComputedStyle(mE).lineHeight)||22;PADX=16;
 WT=lively?16:design==='tessaya'?4:2;PAD=lively?32:WT+14;
 PH=lively?Math.round(rr.height)+6:Math.round(rr.height);PBASE=Math.round(rr.width);
 TMAX=(design==='quiet'?380:design==='lively'?390:410)-2*PADX;
 IS={lively,cr:design==='quiet'?22:lively?24:20,...parts,cw:$('vc').offsetWidth,ch:$('vc').offsetHeight};};
const paintE=(ww,h,sc,tuck)=>{const p_=$('p'),vc=$('vc'),down=document.body.classList.contains('down'),BH=innerHeight;
 for(const id of['dx','dv'])$(id).style.opacity=String(1-.65*tuck);
 let vx,vy,vw,vh0,bot;
 if(!IS.lively){
  const vis=PH+h,top=down?${PILL_LINE}-PH:BH-${PILL_BELOW}-vis,x0=(MAXW-ww)/2,r=PH/2+(IS.cr-PH/2)*clamp(h/24);
  p_.style.clipPath='inset('+top.toFixed(2)+'px '+x0.toFixed(2)+'px '+(BH-top-vis).toFixed(2)+'px '+x0.toFixed(2)+'px round '+r.toFixed(2)+'px)';
  rimTo(x0,top,ww,vis,r);VIS={x:x0,y:top,w:ww,h:vis};
  // The head is the pill's own row: ✕ and ✓ at its ends, the dot and the waveform as in the pill; with words and no ✓/✕
  // the waveform moves to the card's corner as the drafts' one-line card has it.
  const k=p_.dataset.voice==='on'?0:clamp(h/LINE),cy=(e)=>top+(PH-e[1])/2;
  $('dx').style.transform='translate('+(x0+4).toFixed(2)+'px,'+cy(IS.dx).toFixed(2)+'px)';
  $('dv').style.transform='translate('+(x0+ww-4-IS.dv[0]).toFixed(2)+'px,'+cy(IS.dv).toFixed(2)+'px)';
  $('mic').style.transform='translate('+(x0+12).toFixed(2)+'px,'+cy(IS.mic).toFixed(2)+'px)';$('mic').style.opacity=String(1-k);
  const wx=x0+(ww-IS.w[0])/2,wy=cy(IS.w);
  $('w').style.transform='translate('+(wx+(x0+PADX-wx)*k).toFixed(2)+'px,'+(wy+(top+10-wy)*k).toFixed(2)+'px)';
  vx=x0+PADX;vy=top+PH+WT;vw=ww;bot=h-PAD+4;}
 else{
  // Lively: the pebbles stay put; the card above them (below them when the window grew down) is cut to the words.
  const cx=(IS.cw-ww)/2,ct=down?0:IS.ch-h;
  vc.style.clipPath='inset('+ct.toFixed(2)+'px '+cx.toFixed(2)+'px '+(IS.ch-ct-h).toFixed(2)+'px '+cx.toFixed(2)+'px round 24px)';
  const pr=p_.getBoundingClientRect(),cr=vc.getBoundingClientRect();
  const x=Math.min(pr.left,cr.left+cx),y=h>0?Math.min(pr.top,cr.top+ct):pr.top;
  VIS={x,y,w:Math.max(pr.right,cr.left+cx+ww)-x,h:Math.max(pr.bottom,h>0?cr.top+ct+h:0)-y};
  vx=cx+PADX;vy=ct+WT;vw=ww;bot=h-PAD+4;}
 const vh=(ALL_LINES+2)*LINE;vp.style.width=TMAX+'px';vp.style.height=vh+'px';vp.style.transform='translate('+vx.toFixed(2)+'px,'+vy.toFixed(2)+'px)';
 vp.style.clipPath='inset(0 '+Math.max(0,TMAX-(vw-2*PADX)).toFixed(2)+'px '+Math.max(0,vh-bot).toFixed(2)+'px 0)';
 // The top edge fades while lines are scrolled out of view above it.
 const mkd=clamp(sc/LINE);vp.style.maskImage=vp.style.webkitMaskImage=mkd>.01?'linear-gradient(180deg,rgba(0,0,0,'+(1-.75*mkd).toFixed(3)+') 0,#000 14px)':'';
 sendRect();};
const drawI=t=>{const L=I,calm=isCalm(),C=L.C,R=L.R===null?Infinity:L.R,P=L.P;
 // The one progress: after the hold, a single curve from 0 to 1 that the words and the capsule all follow.
 const pc=C?t-R-C.MOVE_T:0,pp=!C?0:t>=P?1:pc<=0?0:pc>=C.MOVE_D||calm?1:clamp(springAt(FLOW01,pc,false,FLOW),0,1.02);
 const w=springAt(L.W,t,calm);let h,sc;
 if(t<R){h=Math.max(0,springAt(L.Hh,t,calm));sc=springAt(L.Sc,t,calm);}
 else{const hRaw=hOf(L.rawLines);
  if(C&&t>=P){h=Math.max(0,springAt([{at:0,to:hOf(L.linesB)},{at:P+C.OUT_D,to:0}],t,calm));sc=0;}
  else if(C&&t>=R+C.MOVE_T){h=hRaw+(hOf(L.linesB)-hRaw)*pp;sc=0;}
  // From ✓ the capsule opens and the scroll returns to the top on one curve from where they were.
  else{const qo=calm?1:SMOOTH(prog(t,R,EXPAND_MS)),hAtR=Math.max(0,springAt(L.HhLive,R,calm));h=hAtR+(hRaw-hAtR)*qo;sc=springAt(L.ScLive,R,calm)*(1-qo);}}
 // Spoken dictation's ✓ and ✕ sit either side of the waveform: the capsule is wider only while they show.
 const ww=D?w:Math.max(w,PBASE);
 if(D){vp.style.width=FW+'px';
  // The text scrolls as a field does: the newest line stays in the box, and the cleanup's lines settle the same way.
  const sD=t<R||!C?springAt(L.Sc,t,calm):scD(L.rawLines)+(scD(L.linesB)-scD(L.rawLines))*pp;vp.style.transform='translateY('+(TOP-sD).toFixed(2)+'px)';sc=0;
  // His own text cannot scroll with it, so once it does the field's lines under it are covered, as a textarea's would go;
  // an empty field's placeholder is covered from the start (EMPTY), and shows again when the ghost window goes.
  const bg=$('bg');if(bg)bg.style.opacity=String(Math.max(EMPTY?1:0,clamp(sD/LINE))*(C&&t>=P?1-ACCEL(prog(t,P,C.OUT_D)):1));
  // A line scrolled half past the box's top fades over half a line, not cut in half; only the words fade, never #bg.
  // vp is tall enough to hold the box in its own coordinates, so its mask reaches every word on show.
  const top=sD-TOP;vp.style.height=(sD+BOXH).toFixed(2)+'px';
  vp.style.maskImage=vp.style.webkitMaskImage=sD>0?'linear-gradient(180deg,transparent 0,transparent '+top.toFixed(2)+'px,#000 '+(top+LINE/2).toFixed(2)+'px)':'';}else{
 const tuck=t<R?0:t<P?(calm?1:EMPH(prog(t,R,MD.medium2))):(calm?0:1-EMPH(prog(t,P,MD.medium2)));
 paintE(ww,h,sc,tuck);}
 if(!C){// While he talks, and after ✓ until the clean text: the newest partial's layout, each word arriving with a decelerated fade, rise and unblur.
  let s=L.steps[0];for(const x of L.steps)if(x.t<=t)s=x;if(!s)return;
  L.rawS.forEach((sp,i)=>{if(t<L.appear[i]||i>=s.n){hide(sp);return;}const p=calm?1:DECEL(prog(t,L.appear[i],MD.medium4));sp.style.color=liveC;sp.style.backgroundImage='';place(sp,s.pos[i].x,s.pos[i].y-sc+6*(1-p),p,3*(1-p));});
  if(D)caretAt(s.pos[s.n-1],1);
  return;}
 const c=t-R,fade=t<P?1:calm?0:1-ACCEL(prog(t,P,C.OUT_D));
 if(D){const e=L.toks.reduce((a,k)=>k.j>a.j?k:a,L.toks[0]);caretAt(pp>0?e&&e.B:L.rawP[L.rawP.length-1],fade);}
 // Reduced motion: his raw words until the cut, then the clean paragraph, with no movement between.
 if(calm){const clean=c>=C.CUT;L.rawS.forEach(hide);L.toks.forEach(k=>{hide(k.subS);hide(k.landS);if(k.morph)hide(k.morph.el);});
  if(!clean)L.rawS.forEach((sp,i)=>{sp.style.backgroundImage='';sp.style.color=c>=C.LIT&&!L.drops.includes(i)?textC:greyC;place(sp,L.rawP[i].x,L.rawP[i].y,fade);});
  else L.toks.forEach(k=>{const s=k.landS||k.subS||L.rawS[k.i];s.textContent=k.text;s.style.color=textC;place(s,k.B.x,k.B.y,fade);});
  return;}
 // Only the words being cut fade to grey (350 ms, once the opening has settled); kept words never dip.
 const grey=EMPH(prog(c,C.X,C.GREY)),subLit=EMPH(prog(c,C.HOLD_END-150,MD.medium2));
 // Once the grey has settled a strike draws across each cut word (250 ms); the cut fades them 240 ms before the motion.
 for(const i of L.drops){const sp=L.rawS[i],st=EMPH(prog(c,C.X+C.GREY,C.STRIKE)),q=ACCEL(prog(c,C.CUT,C.CUT_D));
  sp.style.backgroundImage=st>0?'linear-gradient(currentColor,currentColor)':'';sp.style.backgroundRepeat='no-repeat';sp.style.backgroundPosition='0 58%';sp.style.backgroundSize=(st*100).toFixed(1)+'% 1.5px';sp.style.color=mixL(1-grey);
  place(sp,L.rawP[i].x,L.rawP[i].y-sc-5*q,(1-q)*fade,6*q,' scale('+(1-.14*q).toFixed(3)+')');}
 // A word changing lines leaves its old spot with the cut and arrives at its new one over the second half of the motion.
 const p=pp,out_=EMPH(prog(c,C.CUT,C.CUT_D)),inOf=k=>clamp((p-k.inP)/Math.max(.15,1-k.inP));
 for(const k of L.toks){
  if(k.i===null){const in_=inOf(k);k.landS.style.color=textC;place(k.landS,k.B.x+8*(1-in_),k.B.y,in_*fade,3*(1-in_));continue;}
  const sp=L.rawS[k.i];sp.style.backgroundImage='';
  // A new spelling is crisp: the new one is in full within 200 ms while the old fades under it.
  const swAt=k.sub?C.SWAP:C.LIT,so=EMPH(prog(c,swAt+100,MD.medium2-100)),si=DECEL(prog(c,swAt,MD.short4));
  const morphQ=k.morph?EMPH(prog(c,C.MOVE_T+C.P02,380)):0;
  if(k.morph&&!k.change){const x=k.from.x+(k.B.x-k.from.x)*p,y=k.from.y+(k.B.y-k.from.y)*p-sc;
   sp.style.opacity='0';hide(k.subS);k.morph.el.style.color=liveC;place(k.morph.el,x,y,fade);morphAt(k.morph,morphQ);continue;}
  const vis=k.sub?[[sp,1-so,mixC(1-grey)],[k.subS,si,mixC(subLit)]]:[[sp,1,liveC]];
  if(k.change){const dir=k.B.y<k.from.y?-1:1;
   for(const [s,op,cl] of vis){s.style.color=cl;place(s,k.from.x+dir*10*out_,k.from.y-sc,op*(1-out_)*fade,3*out_);}
   const in_=inOf(k);
   if(k.morph){hide(k.landS);k.morph.el.style.color=vis[vis.length-1][2];place(k.morph.el,k.B.x-dir*8*(1-in_),k.B.y,in_*fade,3*(1-in_));morphAt(k.morph,morphQ);continue;}
   k.landS.style.color=vis[vis.length-1][2];place(k.landS,k.B.x-dir*8*(1-in_),k.B.y,in_*fade,3*(1-in_));continue;}
  // Words first heard in the final piece (after ✓) arrive with the same fade as live words, never all at once.
  const x=k.from.x+(k.B.x-k.from.x)*p,y=k.from.y+(k.B.y-k.from.y)*p-sc,late=L.appear[k.i]>R?DECEL(prog(t,L.appear[k.i],MD.medium4)):1;
  for(const [s,op,cl] of vis){s.style.color=cl;place(s,x,y,op*fade*late);}}};
`;

export const ISLAND_SCRIPT = wordsScript("E");
