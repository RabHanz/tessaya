import { FONT_FACES } from "./fonts.ts";
import { PALETTE_CSS } from "./palette.ts";

/**
 * Woad (#14505A, #5FB3B3 on dark) is the one primary accent; each page group adds a hint dye and three semantic colours say state.
 * Glass: one still ambient field fills the window; the sidebar and top bar sit on it with no tint of their own, the page is one
 * translucent sheet (no backdrop blur: it would only blur our own field, at a GPU cost on every repaint), and cards inside are lit, not outlined (rim light above, soft shade below). Blur only on layers that never move. Motion is transform and opacity, once, behind html.live.
 * The "spring" easing is critically damped: it settles with no overshoot.
 */
/** The dark theme: a near-black ground, panels one step lighter, hairline rules, edge light instead of shadow. */
export const DARK_TOKENS = `[data-theme=dark]{
  --ground:#111214;--side:#15161a;--panel:#1a1b1f;--sunk:#202127;--ink:#ebebe8;--soft:#a6a8b0;--faint:#8c8f98;
  --line:#2a2c32;--line-strong:#3b3e46;--accent:#5FB3B3;--accent-deep:#12292D;--accent-wash:#163035;--accent-ink:#0F1B1E;
  --warn:#e3a553;--warn-wash:#33270f;--bad:#f08a80;--bad-wash:#3b1f1c;
  --hover:rgba(255,255,255,.055);--row-hover:rgba(255,255,255,.035);--quiet:#2a2c32;--accent-edge:#2D5A5F;--accent-text:#5FB3B3;
  --focus:#5FB3B3;--on-ink:#15161a;--on-deep:#EEEDE4;--on-deep-soft:#9FD0D0;--btn-deep-bg:#EEEDE4;--btn-deep-fg:#0F1B1E;
  --card:#1e1f24;--field:#141518;--indigo:#9DB0FF;--damson:#CBA3DD;--lichen:#B9D075;--leaf:#6CCB9A;
  --card-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 10px 28px -18px rgba(0,0,0,.7);--field-shadow:inset 0 1px 2px rgba(0,0,0,.4);
  --edge:rgba(255,255,255,.09);--panel-shadow:inset 0 1px 0 rgba(255,255,255,.05);--veil:rgba(0,0,0,.6);
  --modal-shadow:0 0 0 1px rgba(255,255,255,.08),0 30px 80px -20px rgba(0,0,0,.7);--arrow:%23a6a8b0;color-scheme:dark;
  --glass-card:rgba(255,255,255,.045);--glass-hi:rgba(255,255,255,.1);--glass-rim:rgba(255,255,255,.075);--rule:rgba(255,255,255,.07);
  --glass-shade:0 1px 1px rgba(0,0,0,.25),0 14px 34px -18px rgba(0,0,0,.8);--sheet-shade:0 30px 70px -40px rgba(0,0,0,.9);
  --glow-a:22%;--glow-b:16%;--sheen:linear-gradient(165deg,rgba(255,255,255,.06),rgba(255,255,255,0) 30%);
}`;

/** Entrance stagger: at most four blocks and three rows play at once. */
export const STAGGER_BLOCKS = 4;
export const STAGGER_ROWS = 3;
const delays = (selector: string, n: number, extra = "0ms") =>
  Array.from(
    { length: n },
    (_, i) =>
      `html.live ${selector}:nth-child(${i + 1}){animation-delay:calc(${i} * var(--stagger) + ${extra})}`,
  ).join("");

export const APP_CSS = `
${FONT_FACES}
:root{
  --ground:#ece6da;--side:#e7e0d2;--panel:#fbf9f4;--sunk:#f3efe6;--ink:#17181b;--soft:#565961;--faint:#666972;
  --line:#dedbd4;--line-strong:#c9c5bc;--accent:#14505A;--accent-deep:#0E3A42;--accent-wash:#E3EEEF;--accent-ink:#ffffff;
  --warn:#9a5a12;--warn-wash:#f6e8d2;--bad:#a3342c;--bad-wash:#f4e0dd;
  --serif:"Newsreader",Georgia,"Iowan Old Style",Cambria,serif;
  --sans:"Schibsted Grotesk","Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  --ease:cubic-bezier(.2,.8,.2,1);--r:20px;--rc:18px;
  --hover:rgba(23,24,27,.05);--row-hover:rgba(248,247,244,.7);--quiet:#e6e4de;--accent-edge:#B7D2D5;--accent-text:#14505A;
  --focus:#14505A;--on-ink:#ffffff;--on-deep:#EEEDE4;--on-deep-soft:#BFD6D8;--btn-deep-bg:#f8f7f4;--btn-deep-fg:#17181b;
  --card:#fffdf9;--field:#f4f0e7;--indigo:#2F4A9E;--damson:#6A2F7E;--lichen:#4F6B1F;--leaf:#1F7A4D;
  --card-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 1px 2px rgba(23,40,45,.05),0 10px 26px -18px rgba(23,40,45,.28);
  --field-shadow:inset 0 1px 2px rgba(23,40,45,.07);--edge:rgba(255,255,255,.7);
  --panel-shadow:0 1px 0 rgba(255,255,255,.8) inset,0 16px 44px -30px rgba(23,40,45,.4);--veil:rgba(23,24,27,.38);
  --modal-shadow:0 30px 80px -20px rgba(23,40,45,.5);--arrow:%23565961;color-scheme:light;
  --hue:var(--accent);--hue-text:var(--accent-text);
  --side-fill:color-mix(in srgb,var(--side) 56%,transparent);--glass-fill:color-mix(in srgb,var(--panel) 58%,transparent);--sheet-fill:color-mix(in srgb,var(--panel) 80%,transparent);
  --blur:blur(12px);--scrim:blur(7px);
  --glass-panel:color-mix(in srgb,var(--panel) 76%,transparent);--sheen:linear-gradient(165deg,rgba(255,255,255,.55),rgba(255,255,255,0) 34%);--glass-card:rgba(255,255,255,.6);--glass-hi:rgba(255,255,255,.95);
  --glass-rim:rgba(255,255,255,.6);--rule:color-mix(in srgb,var(--line) 75%,transparent);
  --glass-shade:0 1px 2px rgba(23,40,45,.06),0 14px 32px -18px rgba(23,40,45,.36);--sheet-shade:0 24px 60px -40px rgba(23,40,45,.45);
  --glow-a:26%;--glow-b:18%;
  --field:radial-gradient(70% 60% at 0% 0%,color-mix(in srgb,var(--accent) var(--glow-a),transparent),transparent),radial-gradient(60% 70% at 100% 100%,color-mix(in srgb,var(--indigo) var(--glow-b),transparent),transparent),radial-gradient(50% 45% at 62% 0%,color-mix(in srgb,var(--hue) 14%,transparent),transparent);
  --dur-instant:80ms;--dur-quick:140ms;--dur-base:220ms;--dur-slow:420ms;--dur-hero:900ms;--stagger:28ms;
  --ease-out:cubic-bezier(.16,1,.3,1);--ease-settle:linear(0,.38 7%,.68 15%,.86 25%,.95 38%,.99 55%,1);
}
${DARK_TOKENS}
${PALETTE_CSS}
[data-g=dictation]{--hue:var(--indigo);--hue-text:var(--indigo)}
[data-g=knowledge]{--hue:var(--damson);--hue-text:var(--damson)}
[data-g=settings]{--hue:var(--lichen);--hue-text:var(--lichen)}
#app,:root,.nav,.glabel,#navind{--hue-wash:color-mix(in srgb,var(--hue) 11%,var(--panel));--hue-edge:color-mix(in srgb,var(--hue) 34%,var(--panel))}
html.glass-reduced,html.glass-off{--side-fill:var(--side);--glass-fill:var(--panel);--sheet-fill:var(--panel);--blur:none;--scrim:none;--glass-panel:var(--panel);--glass-card:var(--card)}
html.glass-off{--field:none}
@media (prefers-reduced-transparency:reduce){:root{--side-fill:var(--side);--glass-fill:var(--panel);--sheet-fill:var(--panel);--blur:none;--scrim:none;--glass-panel:var(--panel);--glass-card:var(--card)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--field),var(--ground);color:var(--ink);font:14px/1.45 var(--sans);-webkit-font-smoothing:antialiased;user-select:none;cursor:default;overflow:hidden}
html.material body{background:var(--field),color-mix(in srgb,var(--ground) 52%,transparent)}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,.sw:focus-visible,a:focus-visible,[tabindex]:focus-visible,:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
#panel:focus{outline:none}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.skip{position:absolute;left:8px;top:-48px;z-index:100;background:var(--ink);color:var(--on-ink);padding:8px 12px;border-radius:10px;font-weight:600;text-decoration:none}.skip:focus{top:8px}

/* Shell: the sidebar and the top bar sit straight on the window's field; the page is one glass sheet floating on it. */
#app{position:relative;isolation:isolate;display:grid;grid-template-columns:236px minmax(0,1fr);grid-template-rows:minmax(0,1fr);height:100%;transition:grid-template-columns .22s var(--ease)}
#app.collapsed{grid-template-columns:64px minmax(0,1fr)}
#side{position:relative;isolation:isolate;display:flex;flex-direction:column;padding:16px 12px 12px;overflow:hidden;min-width:0}
#app.collapsed #side{padding:16px 8px 12px}
#app.collapsed .brand{justify-content:center;padding:0 0 14px}
#app.collapsed .brand #mark{width:36px;height:36px;border-radius:10px}
#app.collapsed .brand .bt,#app.collapsed .sidecard{display:none}
#app.collapsed .glabel{height:1px;padding:0;margin:9px 12px;background:var(--line-strong);pointer-events:none}
#app.collapsed .glabel>*,#app.collapsed .glabel::before{display:none}
#app.collapsed .nav{justify-content:center;padding:9px 0}
#app.collapsed .nav>span:not(.n){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#app.collapsed .nav .n{position:absolute;top:2px;right:4px;min-width:16px;padding:0 4px;font-size:10px}
#railtip{position:fixed;z-index:60;transform:translateY(-50%);background:var(--ink);color:var(--on-ink);padding:4px 9px;border-radius:8px;font:500 12px/1.4 var(--sans);white-space:nowrap;pointer-events:none;box-shadow:var(--card-shadow)}
#railtip[hidden]{display:none}
.gap-top{margin-top:14px}
.brand{display:flex;align-items:center;gap:12px;padding:0 6px 20px}
.brand #mark{width:56px;height:56px;display:block;flex:none;color:var(--ink)}
.brand #mark svg,.aboutmark svg{width:100%;height:100%;display:block}
.brand .bt{display:flex;flex-direction:column;gap:1px;min-width:0}
.brand b{font:600 26px/1.05 var(--serif);letter-spacing:-.01em}
.brand .plan{margin:0;border:0;background:none;padding:0;font-weight:500;color:var(--faint);font-variant-numeric:tabular-nums}
.plan{margin-left:auto;font:600 11px var(--sans);border:1px solid var(--line-strong);border-radius:999px;padding:1px 8px;color:var(--soft);background:var(--panel)}
.mk .on-dark{display:none}
.mk .dye{fill:var(--accent)}
[data-theme=dark] .mk .on-light{display:none}
[data-theme=dark] .mk .on-dark{display:inline}
.aboutmark{width:96px;height:96px;margin:0 0 14px;color:var(--ink);cursor:pointer;border-radius:20px}
.brand #mark{cursor:pointer;border-radius:14px}
nav{display:flex;flex-direction:column;gap:2px}
#navlist{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-bottom:18px;-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 22px),transparent)}
.glabel{display:flex;align-items:center;gap:8px;border:0;background:transparent;width:100%;padding:14px 10px 4px;font:600 11px var(--sans);letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
.glabel::before{content:"";width:6px;height:6px;border-radius:2px;background:var(--hue);flex:none}
.glabel svg{margin-left:auto;transition:transform var(--dur-quick)}
.glabel[aria-expanded=false] svg{transform:rotate(-90deg)}
.glabel:first-child{padding-top:2px}
.glabel:hover{color:var(--ink)}
.nav{position:relative;isolation:isolate;display:flex;align-items:center;gap:11px;border:0;background:transparent;width:100%;text-align:left;padding:8px 10px;border-radius:10px;color:var(--soft);font-weight:500;transition:transform var(--dur-instant) var(--ease-out)}
.nav::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--hover);opacity:0;transition:opacity var(--dur-quick)}
.nav:hover{color:var(--ink)}.nav:hover::before{opacity:1}
.nav svg{color:color-mix(in srgb,var(--hue) 78%,var(--soft))}
.nav[aria-current=page]{color:var(--ink);font-weight:600}
.nav[aria-current=page]::before{opacity:1;background:var(--hue-wash);box-shadow:inset 0 0 0 1px var(--hue-edge)}
.nav[aria-current=page] svg{color:var(--hue-text)}
.nav .n{margin-left:auto;font:600 11px var(--sans);min-width:18px;text-align:center;border-radius:999px;padding:1px 6px;background:var(--warn-wash);color:var(--warn)}
#navind{position:absolute;left:3px;top:0;width:4px;height:18px;border-radius:4px;background:var(--hue);opacity:0;pointer-events:none}
html.live #navind.go{transition:transform var(--dur-slow) var(--ease-settle),opacity var(--dur-quick)}
.spacer{flex:1}
.sidecard{background:var(--glass-card);border:0;border-radius:14px;padding:12px;margin:0 2px 10px;box-shadow:var(--card-shadow)}
.sidecard b{display:block;font-weight:600}
.sidecard p{margin:2px 0 10px;color:var(--soft);font-size:13px}
.sidecard.go{background:linear-gradient(145deg,var(--accent-deep),color-mix(in srgb,var(--accent-deep) 62%,var(--accent)));border-color:var(--accent-deep);color:var(--on-deep)}
.sidecard.go p{color:var(--on-deep-soft)}
.sidecard.go .btn{background:var(--btn-deep-bg);color:var(--btn-deep-fg);border-color:var(--btn-deep-bg)}
.foot .nav{color:var(--soft)}

#main{display:flex;flex-direction:column;min-width:0;padding:0 12px 12px 0}
#top{position:relative;-webkit-app-region:drag;padding-right:calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 6px)!important;height:50px;display:flex;align-items:center;gap:8px;padding:0 6px 0 4px;flex:none}
#top button,#top input,#top select,#top a,#top .state,#top .pop{-webkit-app-region:no-drag}
#top .search{margin-left:auto;width:230px;height:34px;padding:0 14px;border-radius:999px;border:0;background:var(--glass-card);box-shadow:inset 0 0 0 1px var(--glass-rim),var(--glass-shade);color:var(--ink);font-size:13px}
#top .search:focus-visible{outline-offset:1px}
.ibtn{border:0;background:transparent;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:var(--soft);position:relative;isolation:isolate;transition:transform var(--dur-instant) var(--ease-out)}
.ibtn::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--hover);opacity:0;transition:opacity var(--dur-quick)}
.ibtn:hover{color:var(--ink)}.ibtn:hover::before{opacity:1}.ibtn:active{transform:scale(.92)}
.ibtn .pip{position:absolute;top:7px;right:8px;width:8px;height:8px;border-radius:50%;background:var(--warn);border:2px solid var(--ground)}
.state{margin-left:auto;display:flex;align-items:center;gap:8px;padding:0 14px 0 11px;height:34px;border-radius:999px;background:var(--glass-card);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--glass-shade);color:var(--soft);font-weight:500}
.dot{position:relative;width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.dot[data-tone=good]{background:var(--leaf);box-shadow:0 0 0 3px color-mix(in srgb,var(--leaf) 22%,transparent)}
.dot[data-tone=warn]{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 22%,transparent)}
.dot[data-tone=off]{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 22%,transparent)}
.dot::after{content:"";position:absolute;inset:0;border-radius:50%;background:inherit;opacity:0}
#panel{position:relative;flex:1;min-height:0;background:var(--sheen),var(--glass-panel);border-radius:var(--r);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--sheet-shade);overflow:auto}
#page{position:relative;max-width:900px;margin:0 auto;padding:40px 40px 64px}
#page.wide{max-width:1100px}
#page>*{position:relative}

/* Type: a serif for what is said, a sans for what is operated; the hue marks each section. */
h1{font:400 42px/1.06 var(--serif);letter-spacing:-.025em;margin:0 0 6px}
h1 em{font-style:italic;color:var(--hue-text)}
.lede{font:italic 400 17px/1.5 var(--serif);color:var(--soft);margin:0 0 26px;max-width:58ch}
.dateline{font:600 12px var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--hue-text);margin:0 0 10px}
h2{display:flex;align-items:center;gap:10px;font:600 12px var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--soft);margin:38px 0 12px}
h2::before{content:"";width:18px;height:6px;border-radius:3px;background:linear-gradient(90deg,var(--hue),color-mix(in srgb,var(--hue) 35%,transparent));flex:none}
h2 small{font-weight:400;color:var(--faint);margin-left:8px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--accent-edge);background:var(--accent-wash);color:var(--accent-text);border-radius:999px;padding:1px 10px;font:600 .8em var(--sans);vertical-align:2px;margin:0 2px}
.chip.plain{background:var(--sunk);border-color:var(--line-strong);color:var(--ink)}
.quick{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;background:var(--glass-card);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--glass-shade);border-radius:999px;height:34px;padding:0 16px;font-weight:600;font-size:13px;transition:transform var(--dur-instant) var(--ease-out)}
.pill:hover{border-color:var(--hue)}.pill:active{transform:scale(.96)}
.pill[aria-pressed=true]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);box-shadow:0 8px 20px -9px color-mix(in srgb,var(--accent) 90%,transparent),inset 0 1px 0 rgba(255,255,255,.22)}
.pill[aria-pressed=true]::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill:disabled{opacity:.45;pointer-events:none}

.banner{position:relative;display:flex;align-items:center;gap:20px;background:linear-gradient(135deg,var(--accent-deep),color-mix(in srgb,var(--accent-deep) 58%,var(--accent)));color:var(--on-deep);border-radius:var(--r);padding:22px 26px;margin:24px 0 8px;box-shadow:0 18px 36px -24px color-mix(in srgb,var(--accent) 70%,transparent),inset 0 1px 0 rgba(255,255,255,.14)}
.banner::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(55% 140% at 100% 0%,color-mix(in srgb,var(--accent) 38%,transparent),transparent 70%)}
.banner.warn::after{display:none}
.banner>*{position:relative;z-index:1}
.banner h3{font:400 22px/1.25 var(--serif);margin:0 0 3px}
.banner h3 em{font-style:italic}
.banner p{margin:0;color:var(--on-deep-soft);max-width:52ch}
.banner .btn{margin-left:auto;background:var(--btn-deep-bg);color:var(--btn-deep-fg);border-color:var(--btn-deep-bg)}
.banner.warn{background:var(--warn-wash);color:var(--ink);box-shadow:inset 3px 0 0 var(--warn)}
.banner.warn p{color:var(--soft)}
.banner.warn .btn{background:var(--card);color:var(--ink);border-color:var(--line-strong)}

.split{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:30px;align-items:start;margin-top:22px}
.rail{min-width:0}
.day{font:600 12px var(--sans);letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:24px 0 8px}
.dayhead{display:block;width:100%;text-align:left;background:none;border:0;padding:0}
.day.first{margin-top:0}
.empty{position:relative;border:1px dashed var(--hue-edge);background:var(--hue-wash);border-radius:var(--r);padding:30px 26px;text-align:center;font:italic 400 17px/1.5 var(--serif);color:var(--soft)}

/* Cards: raised, hairline, one soft shadow. Rows inside are divided by rules and tint on hover. */
.card,.group,.stats{background:var(--glass-card);border-radius:var(--rc);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--glass-shade);overflow:hidden}
.group:has(.hmenu),.group.open{overflow:visible}
.stats{padding:4px 18px}
.stat{padding:12px 0;border-top:1px solid var(--rule)}
.stat:first-child{border-top:0}
.stat b{font:400 30px/1 var(--serif);margin-right:8px;color:var(--hue-text);font-variant-numeric:tabular-nums}
.stat span{color:var(--soft)}
.stats.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0;background:none;border:0;box-shadow:none;overflow:visible}
.tiles .stat{display:block;padding:14px 12px;border-radius:var(--rc);background:var(--glass-card);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--glass-shade)}
.tiles .stat b{display:block;margin:0 0 6px;font-size:32px}.tiles .stat span{font-size:12px}
.stat.kvr{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.stat b.sm{font:600 14px var(--sans);margin:0;color:var(--ink)}
.row{position:relative;isolation:isolate;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 18px;border-top:1px solid var(--rule)}
.row::before{content:"";position:absolute;inset:0;z-index:-1;background:var(--hue-wash);opacity:0;transition:opacity var(--dur-quick);pointer-events:none}
.row:hover::before{opacity:.7}
.row::after{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:var(--hue);transform:scaleY(0);transition:transform var(--dur-quick) var(--ease-out)}
.row:hover::after{transform:scaleY(1)}
.group>.row:first-child,.group>.rows>.row:first-child,.group>.rowwrap:first-child,.group>.rows>.rowwrap:first-child{border-top:0}
.row[data-disabled]{opacity:.5;pointer-events:none}
.rowwrap{border-top:1px solid var(--rule)}
.rowwrap>.row{border-top:0}
.text{min-width:0}
.label{font-weight:600}
.hint{color:var(--soft);font-size:13px;margin-top:1px}
.prompt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}.prompt.open{display:block;-webkit-line-clamp:unset}
.more{display:grid;grid-template-rows:0fr;transition:grid-template-rows .24s var(--ease)}
.more>div{overflow:hidden;min-height:0}
.group.open .more{grid-template-rows:1fr}
.group:not(.open) .more .row{visibility:hidden}
.moreBtn{display:flex;width:100%;align-items:center;gap:6px;padding:11px 18px;border:0;border-top:1px solid var(--line);background:transparent;color:var(--soft);font-weight:600;font-size:13px;text-align:left}
.moreBtn:hover{color:var(--hue-text)}
.moreBtn svg{transition:transform .2s var(--ease)}
.group.open .moreBtn svg{transform:rotate(180deg)}

/* Controls */
.sw{position:relative;isolation:isolate;width:44px;height:26px;flex:none;border-radius:13px;border:0;background:var(--line-strong);box-shadow:var(--field-shadow)}
.sw::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--accent);opacity:0;transition:opacity var(--dur-quick);z-index:-1}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform var(--dur-base) var(--ease-settle)}
.sw[aria-checked=true]::before{opacity:1}.sw[aria-checked=true]{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.sw[aria-checked=true]::after{transform:translateX(18px)}
[data-theme=dark] .sw[aria-checked=true]::after{background:#0F1B1E}
.sw:active::after{transform:scaleX(1.12)}.sw[aria-checked=true]:active::after{transform:translateX(16px) scaleX(1.12)}
.seg{display:flex;background:var(--field);box-shadow:var(--field-shadow),0 0 0 1px var(--line);border-radius:999px;padding:3px;gap:2px;flex:none}
.seg button{border:0;background:transparent;padding:5px 14px;border-radius:999px;color:var(--soft);font-weight:600;font-size:13px;transition:transform var(--dur-instant) var(--ease-out)}
.seg button:hover{color:var(--ink)}.seg button:active{transform:scale(.96)}
.seg button[aria-pressed=true]{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(23,40,45,.18),0 0 0 1px var(--line)}
input[type=text],input[type=search],input[type=password],textarea,select{height:36px;min-width:0;padding:0 12px;border:1px solid var(--line-strong);border-radius:12px;background:var(--field);box-shadow:var(--field-shadow);font-size:14px;user-select:text}
input::placeholder,textarea::placeholder{color:var(--faint)}
input[type=text]:hover,input[type=password]:hover,textarea:hover,select:hover{border-color:color-mix(in srgb,var(--hue) 45%,var(--line-strong))}
input[type=text]:focus-visible,input[type=password]:focus-visible,textarea:focus-visible,select:focus-visible{border-color:var(--hue);outline:2px solid color-mix(in srgb,var(--focus) 55%,transparent);outline-offset:0}
textarea{height:auto;min-height:36px;padding:8px 12px;line-height:20px;resize:vertical}
select{appearance:none;padding-right:30px;max-width:240px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%2366625a' stroke-width='1.6'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
[data-theme=dark] select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23aaa59a' stroke-width='1.6'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E")}
.btn{border:1px solid transparent;background:var(--glass-card);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--glass-shade);border-radius:12px;height:34px;padding:0 16px;font-weight:600;font-size:13px;flex:none;white-space:nowrap;transition:transform var(--dur-instant) var(--ease-out)}
.btn:hover{border-color:var(--hue)}.btn:active{transform:scale(.97)}
.btn.primary{background:var(--accent);border-color:var(--accent-deep);color:var(--accent-ink);box-shadow:0 8px 18px -10px color-mix(in srgb,var(--accent) 85%,transparent),inset 0 1px 0 rgba(255,255,255,.22)}
.btn.primary:hover{border-color:var(--ink)}
.btn.quiet{background:var(--field);box-shadow:none;border-color:transparent}
.btn.quiet:hover{border-color:var(--line-strong)}
.btn[aria-pressed=true]{background:var(--accent-wash);border-color:var(--accent-edge);color:var(--accent-text)}
.btn:disabled{opacity:.5;pointer-events:none}
.pair{display:flex;gap:8px;flex:none}
.x{border:0;background:transparent;color:var(--faint);width:28px;height:28px;border-radius:50%}
.x:hover{background:var(--bad-wash);color:var(--bad)}
kbd{font:600 12px var(--sans);border:1px solid var(--line-strong);border-bottom-width:2px;background:var(--card);border-radius:6px;padding:1px 7px;margin:0 2px}
.badge{display:inline-block;font:600 11px var(--sans);border-radius:999px;padding:0 8px;margin-right:4px;border:1px solid var(--line-strong);color:var(--soft);background:var(--card)}
.badge.learned{border-color:var(--accent-edge);background:var(--accent-wash);color:var(--accent-text)}
.warnb{background:var(--warn-wash);color:var(--warn)}
.glyph{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:700 13px var(--sans);color:#fff;margin-top:1px}
.glyph.ok{background:var(--leaf);color:var(--accent-ink)}.glyph.warn{background:var(--warn)}.glyph.bad{background:var(--bad)}
[data-theme=dark] .glyph.ok{color:#0F1B1E}
.fix{margin-top:3px;font-size:13px;font-weight:600}
.brainRow{padding:8px}.brainRow>.hint{padding:6px 10px 8px}
.pick{display:flex;gap:12px;align-items:flex-start;width:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:12px;padding:11px 10px}
.pick:hover:not(:disabled){background:var(--hue-wash)}
.pick.on{background:var(--accent-wash);border-color:var(--accent)}
.pick:disabled{cursor:default;opacity:.62}
.radio{flex:none;width:18px;height:18px;margin-top:2px;border-radius:50%;border:2px solid var(--line-strong);background:var(--card)}
.pick.on .radio{border-color:var(--accent);background:radial-gradient(var(--accent) 0 4px,var(--card) 5px)}
.tag2{margin-left:8px;font:600 11px var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--faint);border:1px solid var(--line-strong);border-radius:999px;padding:1px 8px}
.voices{display:grid;gap:6px}
.voice{display:flex;align-items:center;gap:10px;padding:2px 4px 2px 0}
.pickv{flex:1;text-align:left;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);font:500 13px var(--sans);color:var(--ink)}
.pickv:hover{border-color:var(--hue)}
.voice.on .pickv{border-color:var(--accent);background:var(--accent-wash);color:var(--accent-text)}

/* Sessions: a row with a state dot, and the New session sheet. */
.sess{align-items:flex-start;justify-content:flex-start}
.sdot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:6px;background:var(--faint)}
.sdot.working{background:var(--leaf);box-shadow:0 0 0 4px color-mix(in srgb,var(--leaf) 20%,transparent)}
.sdot.waiting{background:var(--warn);box-shadow:0 0 0 4px color-mix(in srgb,var(--warn) 20%,transparent)}
.sname{display:block;border:0;background:transparent;padding:0;font:600 15px var(--sans);text-align:left;color:var(--ink)}
button.sname:hover{color:var(--hue-text)}
.reveal{border:0;background:transparent;padding:0;font:inherit;color:var(--accent-text);text-decoration:underline}
.sess .reveal{display:inline-block;max-width:100%;vertical-align:bottom;margin-left:8px;padding:0 9px;border:1px solid var(--line);border-radius:999px;background:var(--field);font-size:12px;line-height:20px;color:var(--soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
.send{display:flex;gap:8px;margin-top:8px}.send input{flex:1}
.vocab{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--line)}.vocab input{flex:1}
.membar{display:flex;flex-wrap:wrap;align-items:center;column-gap:12px}.membar>*{flex:1 1 100%;min-width:0}
.membar>.seg{flex:0 1 auto;margin:0 0 12px 18px;flex-wrap:wrap}.membar>.memtools{flex:1 1 auto;justify-content:flex-end;align-items:center;padding:0 18px 12px 0}
.memtools{display:flex;gap:8px;flex-wrap:wrap;padding:0 18px 10px}.memstatus{padding:0 18px 12px}
.membar>.vocab:first-child{border-top:0}
.newses{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px 12px;margin:6px 18px 16px;padding:18px 20px 20px;border:1px solid var(--hue-edge);border-radius:var(--r);background:linear-gradient(180deg,var(--hue-wash),var(--card) 90px);box-shadow:var(--card-shadow)}
.nstitle{grid-column:1/-1;order:0;font:400 22px/1.2 var(--serif);letter-spacing:-.01em}
.nsfield{display:flex;flex-direction:column;gap:6px;min-width:0}
.nsfield>.hint{margin:0;font:600 11px var(--sans);letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
.nsfield:nth-of-type(1){order:1;grid-column:1/-1}
.nsearlier{order:2;grid-column:1/-1;display:flex;align-items:center;gap:10px}.nsearlier:empty{display:none}
.nsfield:nth-of-type(2){order:3;grid-column:span 2}
.nsfield:nth-of-type(3){order:4;grid-column:span 2}
.nsfield:nth-of-type(4){order:5;grid-column:span 2}
.nsfield:nth-of-type(5){order:6;grid-column:1/-1}
.newses .btn.primary{order:7;grid-column:1/-1;justify-self:end;height:36px;padding:0 22px}
.nsrow{display:flex;gap:8px;min-width:0}.nsrow input{flex:1 1 auto;min-width:0}.nsrow select{flex:0 1 11rem;min-width:0}
.newses input,.newses select,.newses textarea{width:100%}
.newses textarea{max-height:160px;resize:none}

.entry{display:grid;grid-template-columns:minmax(0,1.1fr) 24px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 18px;border-top:1px solid var(--line)}
.entry .arrow{color:var(--faint);text-align:center}

/* Dialogs: the settings sheet, the palette and the popovers are glass over a dimmed page. */
#veil{position:fixed;inset:0;background:var(--veil);-webkit-backdrop-filter:var(--scrim);backdrop-filter:var(--scrim);display:none;place-items:center;z-index:5}
#veil.on{display:grid}
#modal{width:min(980px,calc(100vw - 48px));height:min(760px,calc(100vh - 48px));background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--edge);border-radius:20px;box-shadow:var(--modal-shadow);display:grid;grid-template-columns:210px 1fr;overflow:hidden}
#mnav{background:color-mix(in srgb,var(--sunk) 60%,transparent);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;overflow:auto}
#mnav h4{font:600 11px var(--sans);letter-spacing:.11em;text-transform:uppercase;color:var(--faint);margin:10px 10px 6px}
#mnav .nav{padding:5px 10px}
#mnav h4{margin:6px 10px 3px}
#modal{grid-template-rows:minmax(0,1fr)}
#mnav h4:not(:first-child){margin-top:12px}
.nav.sub{color:var(--faint);font-size:12.5px}
.tipcard{border:1px solid var(--hue-edge);border-left:3px solid var(--hue);background:var(--hue-wash);border-radius:var(--r);padding:12px 16px;margin:0 0 18px}
.tipcard b{display:block}.tipcard p{margin:4px 0 10px;color:var(--soft)}
.tiprow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tiprow .off{background:none;border:0;color:var(--faint);font:inherit;font-size:12.5px;cursor:pointer;margin-left:auto;text-decoration:underline}
webview.embed{display:flex;width:100%;height:calc(100vh - 210px);min-height:420px;border:0;border-radius:var(--r);overflow:hidden;margin-top:12px}
#mnav .ver{margin-top:auto;padding:10px;color:var(--faint);font-size:12px}
#mbody{padding:26px 32px;overflow:auto;position:relative}
#mbody h1{font-size:28px;margin-bottom:16px}
#mclose{position:absolute;top:14px;right:14px}
.palveil{position:fixed;inset:0;background:var(--veil);display:flex;justify-content:center;align-items:flex-start;padding-top:12vh;z-index:50}
.palbox{width:min(640px,92vw);background:var(--sheet-fill);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--edge);border-radius:18px;box-shadow:var(--modal-shadow);overflow:hidden}
.palbox .palin{width:100%;height:auto;border:0;border-bottom:1px solid var(--line);border-radius:0;box-shadow:none;padding:16px 18px;font-size:16px;background:transparent}
.pallist{max-height:50vh;overflow:auto;padding:6px}
.palopt{display:flex;gap:10px;align-items:baseline;padding:9px 12px;border-radius:10px}
.palopt[aria-selected=true]{background:var(--hue-wash);box-shadow:inset 0 0 0 1px var(--hue-edge)}
.palkind{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);width:62px;flex:none}
.pallabel{font-weight:600}
.palhint{color:var(--faint);font-size:12px;margin-left:auto;text-align:right}
.palempty{padding:14px;color:var(--faint)}
.pop{position:absolute;right:6px;top:46px;z-index:30;width:280px;padding:14px;border:1px solid var(--edge);background:var(--sheet-fill);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-radius:16px;box-shadow:0 18px 40px -16px rgba(0,0,0,.4),0 0 0 1px var(--line)}
.pop b{display:block;margin-bottom:6px}.pop p{margin:0;color:var(--soft)}.pop .btn{margin-top:8px;display:block;width:100%}
.hmenu{position:absolute;right:0;top:34px;z-index:5;min-width:220px;padding:4px;border:1px solid var(--line-strong);border-radius:12px;background:var(--card);box-shadow:0 12px 28px -10px rgba(0,0,0,.3)}
.hitem{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:none;text-align:left;font:500 13px var(--sans);color:var(--ink);white-space:nowrap}
.hitem:hover{background:var(--hue-wash)}.hitem.off{color:var(--faint)}.hitem.bad{color:var(--bad)}
.hsep{height:1px;background:var(--line);margin:4px -4px}
/* History and Home's Today card: one row is the words, or what Tessaya did, with its actions on the right. */
.ent{position:relative;display:grid;grid-template-columns:68px 22px minmax(0,1fr) auto;gap:10px;padding:12px 12px 12px 18px;border-top:1px solid var(--rule);align-items:start}
.entries>.ent:first-child,.entries>.subday:first-child+.ent{border-top:0}
.ent time{color:var(--faint);font-variant-numeric:tabular-nums;font-size:13px;padding-top:1px;white-space:nowrap}
.kind{width:22px;height:22px;border-radius:7px;display:grid;place-items:center}
.k-dictation{background:var(--accent-wash);color:var(--accent-text)}
.k-command{background:color-mix(in srgb,var(--indigo) 14%,var(--card));color:var(--indigo)}
.k-assistant{background:color-mix(in srgb,var(--damson) 14%,var(--card));color:var(--damson)}
.k-hid{background:var(--field);color:var(--faint)}
.txt{min-width:0}
.said{color:var(--ink);font-size:14.5px;line-height:1.5;user-select:text;overflow-wrap:anywhere}
.said.clip{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.plain.faint{color:var(--soft)}
.meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;color:var(--faint);font-size:12px;margin-top:4px}
.meta .badge{margin:0}.meta .reveal{font-size:12px}
.badge.warnb{border-color:color-mix(in srgb,var(--warn) 40%,transparent);background:var(--warn-wash);color:var(--warn)}
.acts{display:flex;align-items:center;gap:2px}
.ib{width:30px;height:30px;border:0;border-radius:9px;display:grid;place-items:center;background:none;color:var(--soft)}
.ib:hover,.ib[aria-expanded=true]{background:var(--row-hover);color:var(--ink)}
.ib.off{opacity:.4}.ib.flagged{color:var(--warn)}.ib.flagged svg{fill:currentColor}
.hpre{white-space:pre-wrap;user-select:text;font-size:13px;line-height:1.5}
.raw{margin-top:8px;padding:10px 12px;border-radius:12px;background:var(--field);box-shadow:var(--field-shadow);font-size:13px;color:var(--soft)}
.raw .h{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin-bottom:2px}
.edit{display:block;width:100%;min-height:72px;margin-top:6px;font-size:14.5px;line-height:1.5}
.teach{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;font-size:13px;color:var(--soft)}
.confirm{margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--bad-wash);font-size:13px}
.summary{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:baseline;margin-top:18px;padding:12px 18px;border-radius:var(--rc);background:var(--glass-card);box-shadow:inset 0 1px 0 var(--glass-hi),inset 0 0 0 1px var(--glass-rim),var(--glass-shade)}
.summary b{font:400 24px/1 var(--serif);color:var(--accent-text);font-variant-numeric:tabular-nums;margin-right:6px}
.summary span{color:var(--soft);font-size:13px}.summary .how{color:var(--faint);font-size:12px;margin-left:auto}
.htoolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0 4px}
.htoolbar .hsearch{flex:1 1 220px;margin:0}.htoolbar .hsearch input{margin:0;height:38px}.htoolbar .seg{flex-wrap:wrap}
.subday{font-size:12px;color:var(--faint);padding:8px 18px 6px;border-top:1px solid var(--rule);background:color-mix(in srgb,var(--field) 50%,transparent)}
.entries>.subday:first-child{border-top:0}
@media (max-width:640px){.ent{grid-template-columns:22px minmax(0,1fr) auto;padding:12px 8px 12px 12px}.ent time{display:none}}

.meter{height:10px;border-radius:5px;background:var(--field);border:1px solid var(--line);overflow:hidden;margin:10px 0}
.meter>i{display:block;height:100%;width:0;background:var(--accent)}
.trybox{width:100%;min-height:96px;margin-top:6px}
.wizfoot{display:flex;justify-content:space-between;align-items:center;margin-top:22px}
.wizmid{display:flex;gap:8px}
.inline{padding:2px 18px 16px}
.wakes{display:flex;flex-direction:column;gap:2px}
.wk{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--line)}
.wk:first-child{border-top:0}
.chips{display:flex;align-items:center;gap:2px}
.capture{background:var(--accent-wash);border-radius:12px;margin:0 14px 14px;padding:12px 14px}
.kv{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-top:1px solid var(--line)}
.group>.kv:first-child{border-top:0}
.kv .hint{margin-top:2px}.kv .inline{margin-top:10px}
.hsearch{margin-top:22px}
.hsearch input{width:100%;height:42px;margin-bottom:6px;border-radius:12px}
.hacts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.hmenuwrap{position:relative;flex:none}
.hver{margin-top:10px}
.daycount{color:var(--faint);font-weight:500}
.recs{margin-top:28px;border-top:1px solid var(--line);padding-top:6px}
.rechead{display:flex;align-items:center;gap:12px;width:100%;padding:10px 4px;border:0;background:transparent;font:inherit;color:inherit;text-align:left}
.rechead .hint{flex:1}.rechead[aria-expanded=true] svg{transform:rotate(180deg)}
.insight{display:flex;justify-content:space-between;gap:12px;padding:6px 0;color:var(--soft)}
.chipx{display:inline-flex;align-items:center;gap:4px}
.memedit{width:100%;min-height:72px}
.memacts{display:flex;gap:6px;flex:none;align-items:center}.memedit+.memacts{margin-top:8px}
.vaultbar select{padding:0 30px 0 12px}.vaultkey{margin-top:8px;font-family:ui-monospace,Consolas,monospace;letter-spacing:.04em;word-break:break-all}.vaulthead{padding:12px 18px 4px;font-size:13px;color:var(--soft)}.vaultbar input[type=password]{flex:1;min-width:0}
.rowwrap.stack>.voices,.rowwrap.stack>.brain{margin:0 18px 14px}
.heat{display:grid;grid-template-rows:repeat(7,11px);grid-auto-flow:column;grid-auto-columns:11px;gap:3px;padding:8px 18px 12px}
.heat i{display:block;width:11px;height:11px;border-radius:3px;background:var(--sunk);box-shadow:inset 0 0 0 1px var(--line)}
.heat .h1{background:var(--accent-wash)}.heat .h2{background:var(--accent-edge)}.heat .h3{background:var(--accent)}.heat .h4{background:var(--accent-deep)}.heat .hx{visibility:hidden}
.editor{display:block;width:calc(100% - 36px);height:auto;margin:4px 18px 8px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.5;padding:10px 12px;resize:vertical}

/* Motion: transform and opacity only, once, while the window is live; Motion Reduced keeps a fade, Off keeps nothing. */
@keyframes breathe{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.03);opacity:1}}
@keyframes breathe-near{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.07);opacity:1}}
@keyframes breathe-deep{0%,100%{transform:scale(1)}45%{transform:scale(1.12)}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes rise-s{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes sheet{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes fadeout{from{opacity:1}to{opacity:0}}
@keyframes pop{from{opacity:.4;transform:scale(.94)}to{opacity:1;transform:none}}
@keyframes ripple{from{opacity:.55;transform:scale(1)}to{opacity:0;transform:scale(3)}}
@keyframes focusPop{from{transform:scale(.985)}to{transform:none}}
html.live .brand #mark{animation:breathe 7s ease-in-out infinite;will-change:transform,opacity}
html.live .brand #mark:hover,html.live .aboutmark:hover{animation:breathe-near 2.6s ease-in-out infinite}
html.live .brand #mark:focus-visible,html.live .aboutmark:focus-visible{animation:breathe-near 2.6s ease-in-out 2}
html.live #mark.deep,html.live .aboutmark.deep{animation:breathe-deep 1.6s cubic-bezier(.37,0,.2,1)}
html.live #page.enter>*:nth-child(-n+${STAGGER_BLOCKS}){animation:rise var(--dur-base) var(--ease-out) backwards}
html.live #page.enter>.group:nth-of-type(1)>*:nth-child(-n+${STAGGER_ROWS}){animation:rise-s var(--dur-base) var(--ease-out) backwards}
${delays("#page.enter>*", STAGGER_BLOCKS)}
${delays("#page.enter>.group:nth-of-type(1)>*", STAGGER_ROWS, "120ms")}
html.live #veil.on #modal,html.live .palbox,html.live .pop,html.live .newses{animation:sheet var(--dur-base) var(--ease-out) backwards}
html.live #veil.on{animation:fade var(--dur-quick) ease backwards}
html.live #veil.on.out{animation:fadeout .16s ease forwards}
html.live .state.morph{animation:pop var(--dur-slow) var(--ease-settle) backwards}
html.live .state.morph .dot::after{animation:ripple var(--dur-hero) var(--ease-out) backwards}
html.live button:focus-visible,html.live input:focus-visible,html.live select:focus-visible,html.live textarea:focus-visible{animation:focusPop var(--dur-quick) var(--ease-out)}
html.live.boot .brand .bt{animation:rise var(--dur-slow) var(--ease-out) 120ms backwards}
html.live.boot #navlist>*:nth-child(-n+12){animation:rise-s var(--dur-slow) var(--ease-out) backwards}
${delays("#navlist>*", 12, "200ms").replace(/html\.live /g, "html.live.boot ")}
html.live.boot #top .search,html.live.boot #top .state{animation:fade var(--dur-slow) ease 300ms backwards}
#enrolveil{position:fixed;inset:0;z-index:20;background:var(--veil);display:grid;place-items:center;padding:24px}
.enrol{width:min(600px,100%);max-height:calc(100vh - 48px);overflow:auto;background:var(--panel);border:1px solid var(--edge);border-radius:20px;box-shadow:var(--modal-shadow);padding:22px 24px}
.enrol h2{display:block;font:400 24px/1.2 var(--serif);letter-spacing:0;text-transform:none;color:var(--ink);margin:0 0 4px}.enrol h2::before{content:none}
.eprog{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--faint);margin:12px 0}
.ebar{flex:1;height:6px;border-radius:99px;background:var(--sunk);overflow:hidden}.ebar>i{display:block;height:100%;background:var(--accent)}
.elines{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.elines li{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:8px 10px;border-radius:12px;font-size:15px;line-height:1.5;color:var(--faint)}
.elines .em{font-size:13px;padding-top:2px;text-align:center}
.elines li.done{color:var(--soft)}.elines li.done .em,.elines li.now .em{color:var(--accent-text)}
.elines li.now,.elines li.again{background:var(--accent-wash);color:var(--ink);font:400 18px/1.5 var(--serif)}
.elines li.again{background:var(--warn-wash)}.elines li.again .em,.elines li.again .w.h{color:var(--warn)}
.elines .w.h{color:var(--accent-text)}.elines .w.next{border-bottom:2px solid var(--accent)}
.elines .why{display:block;font:500 13.5px/1.4 var(--sans);color:var(--warn);margin-top:4px}
.efoot{display:flex;align-items:center;gap:10px;margin-top:16px}
.emic{display:flex;align-items:center;gap:8px;flex:1;min-width:0;font-size:12.5px;color:var(--faint)}
.emic .meter{width:90px;height:8px;margin:0;flex:none}
.esum{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14.5px;margin:10px 0}.esum dt{color:var(--faint)}.esum dd{margin:0}
.eq{display:inline-flex;gap:3px;margin-right:8px;vertical-align:1px}.eq i{width:14px;height:6px;border-radius:3px;background:var(--line-strong)}.eq i.on{background:var(--accent)}
.etip{border-left:3px solid var(--accent);padding:8px 12px;background:var(--sunk);border-radius:10px;font-size:14px;color:var(--soft)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
html.motion-reduced *,html.motion-off *{animation:none!important;transition:none!important}
html.motion-reduced #page.enter{animation:fade var(--dur-quick) ease backwards!important}
html.motion-off #navind{transition:none!important}
@media (max-width:1020px){.split{grid-template-columns:1fr}}
/* Forced colours drop shadows and fills: the lit surfaces get a real edge back. */
@media (forced-colors:active){.card,.group,.stats,.tiles .stat,.sidecard,.state,#panel,#top .search,.pill,.btn{border:1px solid CanvasText}}
`;
