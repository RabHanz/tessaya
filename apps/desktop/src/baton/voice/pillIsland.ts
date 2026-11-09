/**
 * Dictation's island in the pill's page (PILL-V2 "E"): his words as recognised, then the cleanup played over them
 * after the paste. A port of the prototype's engine (tessaya-ops drafts/pill/v2/proto/src/template_final.html);
 * each frame is a function of the time, drawn only while something moves.
 */
import { pillEngine } from "./pillTimeline.ts";

/** The pill window's width; the island is never wider. */
export const ISLAND_WIDTH = 420;
/** The window grows upward to this while the island is up: the head, 12 lines and their padding, over the margin. */
export const ISLAND_HEIGHT = 320;

export const ISLAND_CSS = `
:root{--glass:rgba(20,20,26,.58);--glass-solid:#14141a;--edge:rgba(255,255,255,.13);--itext:#fff;--grey:rgba(255,255,255,.46);--isoft:rgba(255,255,255,.62);--ibar:#ececef;--glow:rgba(236,236,239,.55);--accent:#5FB3B3}
@media (prefers-color-scheme:light){:root{--glass:rgba(255,255,255,.82);--glass-solid:#fff;--edge:rgba(0,0,0,.16);--itext:#0f1012;--grey:rgba(15,16,18,.6);--isoft:rgba(15,16,18,.74);--ibar:#16171a;--glow:transparent;--accent:#14505A}}
#p.isl{position:absolute;left:0;bottom:28px;display:block;width:124px;height:34px;max-width:none;padding:0;border:0;border-radius:17px;overflow:hidden;background:var(--glass);box-shadow:inset 0 0 0 1px var(--edge);--text:var(--itext);--soft:var(--isoft);color:var(--text)}
#p.isl[data-phase=dictating]{--bar:var(--ibar)}
html.glass-reduced #p.isl,html.glass-off #p.isl{background:var(--glass-solid)}
#p.isl>#mk,#p.isl>#d,#p.isl>#st,#p.isl>#t,#p.isl>#c{display:none!important}
#p.isl .db{position:absolute;left:0;top:0;display:flex;width:28px;height:28px;margin:0;border-radius:8px;color:var(--soft)}
#p.isl .db:hover{background:transparent;color:var(--text)}
#p.isl #dv{color:var(--text)}
#p.isl[data-esc=on] #dx{color:var(--red)}
#p.isl #w{position:absolute;left:0;top:0;display:block}
#vp{display:none;position:absolute;left:0;top:0;overflow:hidden;font:500 14px/20px var(--sans);pointer-events:none}
#p.isl #vp{display:block}
#vp span{position:absolute;left:0;top:0;white-space:pre}
#vp span.m span{position:static}
#vp span.m .slot{position:relative;display:inline-block;vertical-align:top;height:1em}
#vp span.m .g{position:absolute;left:0;top:0;transform-origin:0 85%}
#mE{position:absolute;visibility:hidden;left:0;top:0;font:500 14px/20px var(--sans)}
#mE span{display:inline-block;vertical-align:top;white-space:pre}
`;

export const ISLAND_HTML = `<div id="vp" aria-hidden="true"></div>`;
export const ISLAND_MEASURE = `<div id="mE" aria-hidden="true"></div>`;

/** Needs the page's `$`, `isCalm`, `setMode`, `drawBars` and `sendRect`. */
export const ISLAND_SCRIPT = `
const {clamp,prog,EMPH,DECEL,ACCEL,MD,FLOW,EXPAND_MS,SMOOTH,springAt,align,cleanupTimes,stepWidth}=(${pillEngine.toString()})();
const PH=34,PBASE=124,LIVE_LINES=5,PAD=12,LINE=20,MAXW=${ISLAND_WIDTH},TMAX=MAXW-32,FLOW01=[{at:0,to:0},{at:0,to:1}];
let ALL_LINES=7,I=null,iraf=0;
const vp=$('vp'),mE=$('mE');
const measure=(words,width)=>{mE.textContent='';mE.style.width=width===null?'auto':width+'px';mE.style.whiteSpace=width===null?'nowrap':'normal';
 return words.map((w,i)=>{if(i)mE.appendChild(document.createTextNode(' '));const s=document.createElement('span');s.textContent=w;mE.appendChild(s);return s;});};
const lay=(words,width)=>measure(words,width).map(s=>({x:s.offsetLeft,y:s.offsetTop}));
const layLine=words=>measure(words,null).map(s=>s.offsetLeft);
const oneLine=words=>{measure(words,null);return mE.offsetWidth;};
const linesOf=pos=>pos.length?Math.round(pos[pos.length-1].y/LINE)+1:0;
const hOf=lines=>lines>0?Math.min(ALL_LINES,lines)*LINE+PAD:0;
const wOf=t=>Math.max(PBASE,t+32);
const mk=t=>{const s=document.createElement('span');s.textContent=t;vp.appendChild(s);return s;};
const textC='var(--text)',greyC='var(--grey)';
const mixC=p=>p>=1?textC:p<=0?greyC:'color-mix(in srgb,'+textC+' '+Math.round(p*100)+'%,'+greyC+')';
const place=(s,x,y,o,blur=0,extra='')=>{s.style.transform='translate('+x.toFixed(2)+'px,'+y.toFixed(2)+'px)'+extra;s.style.opacity=o.toFixed(3);s.style.filter=blur>.05?'blur('+blur.toFixed(2)+'px)':'';};
const hide=s=>{if(s)s.style.opacity='0';};
const kickI=until=>{if(!I)return;I.until=Math.max(I.until,until);if(!iraf)iraf=requestAnimationFrame(tickI);};
const tickI=()=>{iraf=0;if(!I)return;const t=performance.now();drawI(t);if(t<I.until)iraf=requestAnimationFrame(tickI);};
// A newer partial keeps the words it shares with the last one; the rest appear as they arrive.
const setWords=(next,now)=>{let k=0;while(k<next.length&&k<I.raw.length&&next[k]===I.raw[k])k++;
 if(k===next.length&&k===I.raw.length)return;
 for(const s of I.rawS.splice(k))s.remove();I.appear.length=k;
 for(let i=k;i<next.length;i++){I.rawS.push(mk(next[i]));I.appear.push(now);}
 I.raw=next;I.tw=stepWidth(I.tw,oneLine(next),TMAX);const pos=lay(next,I.tw),lines=linesOf(pos);
 I.steps.push({t:now,n:next.length,width:I.tw,pos,lines});
 I.W.push({at:now,to:wOf(I.tw)});I.Hh.push({at:now,to:Math.min(LIVE_LINES,lines)*LINE+PAD});I.Sc.push({at:now,to:Math.max(0,lines-LIVE_LINES)*LINE});
 kickI(now+1200);};
const island={
 on:()=>I!==null,
 start(){island.stop();I={raw:[],appear:[],rawS:[],steps:[],tw:0,W:[{at:0,to:PBASE}],Hh:[{at:0,to:0}],Sc:[{at:0,to:0}],R:null,C:null,P:Infinity,rawLines:0,until:0};kickI(performance.now()+50);},
 stop(){I=null;cancelAnimationFrame(iraf);iraf=0;vp.textContent='';const p=$('p');for(const k of['left','width','height','borderRadius'])p.style[k]='';
  for(const id of['dx','dv','w']){const s=$(id).style;s.opacity='';s.transform='';s.color='';}},
 words(text){if(!I||I.R!==null)return;setWords(text.split(/\\s+/).filter(Boolean),performance.now());},
 // His ✓ (or the key's release): the pill opens to every line and the view scrolls back to the top, 0.75 s.
 release(){if(!I||I.R!==null)return;const now=performance.now();I.R=now;I.rawLines=I.steps.length?I.steps[I.steps.length-1].lines:0;
  ALL_LINES=Math.max(7,Math.min(12,I.rawLines));I.HhLive=I.Hh.slice();I.ScLive=I.Sc.slice();kickI(now+EXPAND_MS+100);},
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
  ALL_LINES=Math.max(7,Math.min(12,Math.max(rawLines,usedA.length,linesB)));
  const C=cleanupTimes(Math.max(rawLines>LIVE_LINES?EXPAND_MS:0,now-I.R));
  Object.assign(I,{C,P:I.R+C.PASTE,toks,rawP,linesB,clean,drops:ops.filter(o=>o.op==='drop').map(o=>o.i)});
  // One span per new spelling, one landing copy per wrapped or inserted word; a punctuation or case change morphs
  // only the characters that change, in a slot whose width follows them.
  toks.forEach(k=>{if(k.sub)k.subS=mk(k.text);if(k.i===null||k.change)k.landS=mk(k.text);
   if(k.punct){const a=raw[k.i],b=k.text;let pre=0;while(pre<a.length&&pre<b.length&&a[pre]===b[pre])pre++;
    let suf=0;while(suf<a.length-pre&&suf<b.length-pre&&a[a.length-1-suf]===b[b.length-1-suf])suf++;
    const el=document.createElement('span');el.className='m';const part=t=>{const x=document.createElement('span');x.textContent=t;return x;};
    const slot=part(''),o=part(a.slice(pre,a.length-suf)),n=part(b.slice(pre,b.length-suf));slot.className='slot';o.className='g';n.className='g';
    slot.append(o,n);el.append(part(a.slice(0,pre)),slot,part(a.slice(a.length-suf)));vp.appendChild(el);
    k.morph={el,slot,o,n,wo:o.offsetWidth,wn:n.offsetWidth,end:suf===0};}});
  kickI(I.P+C.OUT_D+50);return Math.ceil(I.P+C.OUT_D-now);},
};
const morphAt=(M,q)=>{M.slot.style.width=(M.wo+(M.wn-M.wo)*q).toFixed(2)+'px';
 if(M.end){M.o.style.transform='scale('+(1-.4*q).toFixed(3)+')';M.n.style.transform='scale('+(.6+.4*q).toFixed(3)+')';}
 else{M.o.style.transform='translateY('+(-.35*q).toFixed(3)+'em)';M.n.style.transform='translateY('+(.35*(1-q)).toFixed(3)+'em)';}
 M.o.style.opacity=String(1-q);M.n.style.opacity=String(q);};
const drawI=t=>{const L=I,calm=isCalm(),p_=$('p'),C=L.C,R=L.R===null?Infinity:L.R,P=L.P;
 // The one progress: after the hold, a single curve from 0 to 1 that the words and the capsule all follow.
 const pc=C?t-R-C.MOVE_T:0,pp=!C?0:t>=P?1:pc<=0?0:pc>=C.MOVE_D||calm?1:clamp(springAt(FLOW01,pc,false,FLOW),0,1.02);
 const w=springAt(L.W,t,calm);let h,sc;
 if(t<R){h=Math.max(0,springAt(L.Hh,t,calm));sc=springAt(L.Sc,t,calm);}
 else{const hRaw=hOf(L.rawLines);
  if(C&&t>=R+C.MOVE_T){h=hRaw+(hOf(L.linesB)-hRaw)*pp;sc=0;}
  // From ✓ the capsule opens and the scroll returns to the top on one curve from where they were.
  else{const qo=calm?1:SMOOTH(prog(t,R,EXPAND_MS)),hAtR=Math.max(0,springAt(L.HhLive,R,calm));h=hAtR+(hRaw-hAtR)*qo;sc=springAt(L.ScLive,R,calm)*(1-qo);}}
 const ww=w;
 p_.style.left=((MAXW-ww)/2).toFixed(2)+'px';p_.style.width=ww.toFixed(2)+'px';p_.style.height=(PH+h).toFixed(2)+'px';p_.style.borderRadius=(PH/2-clamp(h/24))+'px';
 const tuck=t<R?0:t<P?(calm?1:EMPH(prog(t,R,MD.medium2))):(calm?0:1-EMPH(prog(t,P,MD.medium2)));
 for(const id of['dx','w','dv'])$(id).style.opacity=String(1-.65*tuck);
 $('dv').style.color=t>=R?'var(--accent)':'';
 $('dx').style.transform='translate(5px,3px)';$('dv').style.transform='translate('+(ww-33).toFixed(2)+'px,3px)';$('w').style.transform='translate('+(ww/2-27).toFixed(2)+'px,9px)';
 const vh=(ALL_LINES+2)*20;vp.style.width=TMAX+'px';vp.style.height=vh+'px';vp.style.transform='translate(16px,'+(PH-4)+'px)';
 vp.style.clipPath='inset(0 '+Math.max(0,16+TMAX-(ww-14)).toFixed(2)+'px '+Math.max(0,vh-(h-PAD+4)).toFixed(2)+'px 0)';
 // The top edge fades while lines are scrolled out of view above it.
 const mkd=clamp(sc/LINE);vp.style.maskImage=vp.style.webkitMaskImage=mkd>.01?'linear-gradient(180deg,rgba(0,0,0,'+(1-.75*mkd).toFixed(3)+') 0,#000 14px)':'';
 if(!C){// While he talks, and after ✓ until the clean text: the newest partial's layout, each word arriving with a decelerated fade, rise and unblur.
  let s=L.steps[0];for(const x of L.steps)if(x.t<=t)s=x;if(!s)return;
  L.rawS.forEach((sp,i)=>{if(t<L.appear[i]||i>=s.n){hide(sp);return;}const p=calm?1:DECEL(prog(t,L.appear[i],MD.medium4));sp.style.color=textC;sp.style.backgroundImage='';place(sp,s.pos[i].x,s.pos[i].y-sc+6*(1-p),p,3*(1-p));});
  return;}
 const c=t-R,fade=t<P?1:calm?0:1-ACCEL(prog(t,P,C.OUT_D));
 // Reduced motion: his raw words until the cut, then the clean paragraph, with no movement between.
 if(calm){const clean=c>=C.CUT;L.rawS.forEach(hide);L.toks.forEach(k=>{hide(k.subS);hide(k.landS);if(k.morph)hide(k.morph.el);});
  if(!clean)L.rawS.forEach((sp,i)=>{sp.style.backgroundImage='';sp.style.color=c>=C.LIT&&!L.drops.includes(i)?textC:greyC;place(sp,L.rawP[i].x,L.rawP[i].y,fade);});
  else L.toks.forEach(k=>{const s=k.landS||k.subS||L.rawS[k.i];s.textContent=k.text;s.style.color=textC;place(s,k.B.x,k.B.y,fade);});
  return;}
 // Only the words being cut fade to grey (350 ms, once the opening has settled); kept words never dip.
 const grey=EMPH(prog(c,C.X,C.GREY)),subLit=EMPH(prog(c,C.HOLD_END-150,MD.medium2));
 // Once the grey has settled a strike draws across each cut word (250 ms); the cut fades them 240 ms before the motion.
 for(const i of L.drops){const sp=L.rawS[i],st=EMPH(prog(c,C.X+C.GREY,C.STRIKE)),q=ACCEL(prog(c,C.CUT,C.CUT_D));
  sp.style.backgroundImage=st>0?'linear-gradient(currentColor,currentColor)':'';sp.style.backgroundRepeat='no-repeat';sp.style.backgroundPosition='0 58%';sp.style.backgroundSize=(st*100).toFixed(1)+'% 1.5px';sp.style.color=mixC(1-grey);
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
   sp.style.opacity='0';hide(k.subS);k.morph.el.style.color=textC;place(k.morph.el,x,y,fade);morphAt(k.morph,morphQ);continue;}
  const vis=k.sub?[[sp,1-so,mixC(1-grey)],[k.subS,si,mixC(subLit)]]:[[sp,1,textC]];
  if(k.change){const dir=k.B.y<k.from.y?-1:1;
   for(const [s,op,cl] of vis){s.style.color=cl;place(s,k.from.x+dir*10*out_,k.from.y-sc,op*(1-out_)*fade,3*out_);}
   const in_=inOf(k);
   if(k.morph){hide(k.landS);k.morph.el.style.color=vis[vis.length-1][2];place(k.morph.el,k.B.x-dir*8*(1-in_),k.B.y,in_*fade,3*(1-in_));morphAt(k.morph,morphQ);continue;}
   k.landS.style.color=vis[vis.length-1][2];place(k.landS,k.B.x-dir*8*(1-in_),k.B.y,in_*fade,3*(1-in_));continue;}
  const x=k.from.x+(k.B.x-k.from.x)*p,y=k.from.y+(k.B.y-k.from.y)*p-sc;
  for(const [s,op,cl] of vis){s.style.color=cl;place(s,x,y,op*fade);}}};
`;
