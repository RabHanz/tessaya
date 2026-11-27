/* The character sandbox for the site: the physics world from the desktop sandbox (gravity, bounce, friction,
 * stacking, carry, throw, poke, pet, squish, taffy, pinch), with its social side: neighbours greet in character when
 * they come to rest, bumps and hard landings get a word back, the bin spits them out, and now and then one of them has
 * a funny moment of its own. At most eight at once. The world only steps while something moves.
 * TSWorld(stage, {ledges(W, H) → [{x1, x2, y}], bin(W, H) → {x1, x2, y}, size(W, H), onTalk(b) → handled?, onFull(), onCount(n)})
 *   → {add, pop, drop, reset, humour, tool, bodies} */
(function (g) {
 "use strict";
 const FOOT = (112 + 168) / 320, VB = 320, STEP = 1 / 120, REST = 12, STICK = 160, MAXN = 8;
 const PERS = () => Object.fromEntries(Object.values(TCS.PERSONAS).map((p) => [p.character, p.traits]));
 // what each body says: [name, arriving, greeting, bumped, thrown hard, the bin]
 const VOICE = {
  selvedge: ["Tessaya", "Hello. I'm Tessaya.", "Hi.", "Careful.", "Fine. Nobody saw.", "Not today."],
  felt: ["Freya", "Freya! Throw me?", "Hiya!", "Again!", "Wheee. Again?", "Nope!"],
  tweed: ["Alfred", "Alfred, at your service.", "Good evening.", "I beg your pardon.", "Most undignified.", "I think not."],
  spool: ["Sebastian", "Sebastian. Go on, then.", "Hm. You.", "Watch it.", "Was that necessary?", "Absolutely not."],
  pebble: ["Onyx", "Onyx.", "…", "…", "Thud.", "No."],
  thread: ["Thread", "Oh! Hello!", "Oh! Hi!", "Eep.", "I'm all wound up.", "Hey!"],
  loom: ["Loom", "Mm. Comfy here.", "Mm, hello.", "Oof.", "Soft landing.", "Rude."],
  drop: ["Drop", "Hi-iii.", "Hiii.", "Splish.", "Splat.", "Drip."],
  shuttle: ["Shuttle", "Shuttle. Fast.", "Yo.", "Coming through!", "Ten out of ten.", "Too slow!"],
  swatch: ["Swatch", "Oh, hi.", "Oh, hi.", "Sorry!", "Flop.", "Oh no."],
  thimble: ["Thimble", "Good day.", "Good day.", "Mind yourself.", "As planned.", "Certainly not."],
  purl: ["Purl", "Hello hello!", "Hello hello!", "Boing!", "Again, again!", "Bye bin!"],
  mark: ["Mark", "Hi.", "Hi.", "Out of line.", "Back in line.", "Nah."],
 };
 g.TS_BODIES = Object.keys(VOICE);
 g.TS_NAME = (id) => (VOICE[id] || [id])[0];
 g.TSWorld = function (stage, o = {}) {
  const bodies = [], traits = PERS(), met = new Set(), pending = new Set();
  let W = 0, H = 0, S = 140, scaleG = 1, edges = [], bin = null, running = false, last = 0, owed = 0, moved = false, tool = "hand", alive = true, seen = false;
  const topOf = (b) => b.y - b.h;
  const resting = (b) => b.state === "free" && b.on !== null && Math.abs(b.vx) < REST;
  const away = (b) => b.state === "trash" || b.state === "peek" || b.state === "hang";
  const say = (b, k, p = 1) => { const v = VOICE[b.id]; if (v && v[k] && Math.random() < p) bubble(b, v[k]); };
  function layout() {
   const r = stage.getBoundingClientRect(); W = r.width; H = r.height;
   S = Math.round(o.size ? o.size(W, H) : Math.min(170, Math.max(92, Math.min(W / 5, H / 3))));
   scaleG = S / 190;
   edges = [{kind: "floor", x1: 0, x2: W, y: H - (o.floor ?? 0)}].concat((o.ledges ? o.ledges(W, H) : []).map((e) => ({kind: "ledge", ...e})));
   bin = o.bin ? o.bin(W, H, S) : null;
   for (const b of bodies) { b.el.style.width = b.el.style.height = S + "px"; measure(b); b.on = null; if (!away(b)) b.state = "free"; b.x = Math.min(Math.max(b.x, b.hw), W - b.hw); b.y = Math.min(b.y, edges[0].y); }
   wake();
  }
  function measure(b) { const r = b.rig.bounds(); if (r) { b.hw = r.hw * S / VB * 1.05; b.h = r.h * S / VB; } }
  function add(id, x, y, v = {}) {
   if (bodies.length >= MAXN) { o.onFull && o.onFull(); return null; }
   const el = document.createElement("div"); el.className = "ch"; el.dataset.id = id;
   el.style.cssText = `position:absolute;left:0;top:0;width:${S}px;height:${S}px;will-change:transform;z-index:10`;
   const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.style.cssText = "width:100%;height:100%;overflow:visible;display:block;pointer-events:none";
   el.appendChild(svg); stage.appendChild(el);
   const rig = TCS.create(svg, {character: id, personality: traits[id] || {}, expression: "neutral", intensity: .9, quiet: true});
   const P = rig.physics();
   const b = {id, el, rig, P, F: TCS.flightOf(P), x: x ?? W * (.2 + Math.random() * .6), y: y ?? H * .1, vx: v.vx || 0, vy: v.vy || 0, on: null, state: "free", hw: S * .3, h: S * .45, drawn: "", saidT: 0};
   measure(b); bodies.push(b); place(b); wake(); o.onCount && o.onCount(bodies.length);
   if (v.intro !== false) later(b, 900, () => say(b, 1));
   return b;
  }
  function place(b) { const tr = `translate3d(${(b.x - S / 2).toFixed(1)}px,${(b.y - S * FOOT).toFixed(1)}px,0)`; if (tr !== b.drawn) { b.drawn = tr; b.el.style.transform = tr; } }
  function wake() { if (!running && alive) { running = true; last = performance.now(); owed = 0; requestAnimationFrame(tick); } }
  function tick(now) {
   if (!alive) { running = false; return; }
   const dt = Math.min(.1, (now - last) / 1000); last = now; owed += dt;
   while (owed >= STEP) { owed -= STEP; stepWorld(); }
   for (const b of bodies) { place(b); if (b.state === "free" && !b.on) { const k = 1 / Math.sqrt(scaleG); b.rig.motion(b.vx * k, b.vy * k); b.flying = true; } else if (b.flying && b.state !== "held") { b.flying = false; b.rig.motion(0, 0); } }
   social(now);
   if (bodies.some((b) => b.state === "held" || (b.state === "free" && !resting(b)))) { moved = true; requestAnimationFrame(tick); } else { running = false; if (moved) { moved = false; settle(); } }
  }
  function stepWorld() {
   for (const b of bodies) {
    if (b.state !== "free") continue;
    const F = b.F, gr = F.gravity * scaleG;
    if (b.on) {
     if (b.on.body) { const u = b.on.body; b.y = topOf(u); b.x += u.x - (b.onX ?? u.x); b.onX = u.x; }
     const slow = Math.max(0, 1 - F.friction * STEP);
     b.vx = Math.abs(b.vx * slow) < REST ? 0 : b.vx * slow; b.x += b.vx * STEP;
     const e = b.on.body ? {x1: b.on.body.x - b.on.body.hw, x2: b.on.body.x + b.on.body.hw} : b.on;
     if (b.x < e.x1 || b.x > e.x2) {
      if (b.on.kind === "floor") { b.x = Math.min(Math.max(b.x, e.x1 + b.hw), e.x2 - b.hw); hit(b, "wall", Math.abs(b.vx)); b.vx = -b.vx * F.bounce; }
      else { b.on = null; b.onX = undefined; }
     }
     walls(b); continue;
    }
    const air = Math.max(0, 1 - F.drag * STEP);
    b.vx *= air; b.vy = b.vy * air + gr * STEP;
    const py = b.y; b.x += b.vx * STEP; b.y += b.vy * STEP;
    walls(b);
    if (b.y - b.h < 0 && b.vy < 0) { b.y = b.h; b.vy = -b.vy * F.bounce; hit(b, "wall", Math.abs(b.vy)); }
    if (b.vy > 0) {
     if (bin && b.x > bin.x1 && b.x < bin.x2 && py <= bin.y + 2 && b.y >= bin.y) { intoBin(b); continue; }
     const e = edges.filter((e) => b.x >= e.x1 && b.x <= e.x2 && py <= e.y + 1 && b.y >= e.y).sort((a, c) => a.y - c.y)[0];
     if (e) land(b, e, e.y); else if (b.y > edges[0].y) land(b, edges[0], edges[0].y);
    }
   }
   collide();
  }
  function walls(b) {
   if (b.x < b.hw && b.vx <= 0) { if (b.vx) hit(b, "wall", Math.abs(b.vx)); b.x = b.hw; b.vx = -b.vx * b.F.bounce; }
   if (b.x > W - b.hw && b.vx >= 0) { if (b.vx) hit(b, "wall", Math.abs(b.vx)); b.x = W - b.hw; b.vx = -b.vx * b.F.bounce; }
  }
  function land(b, on, y) { const sp = b.vy; b.y = y; hit(b, "land", sp); const up = sp * b.F.bounce; if (up < STICK) { b.vy = 0; b.on = on; b.onX = on.body ? on.body.x : undefined; } else b.vy = -up; }
  function collide() {
   for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], c = bodies[j];
    if (away(a) || away(c)) continue;
    const ox = Math.min(a.x + a.hw, c.x + c.hw) - Math.max(a.x - a.hw, c.x - c.hw), oy = Math.min(a.y, c.y) - Math.max(topOf(a), topOf(c));
    if (ox <= 0 || oy <= 0) continue;
    const [up, dn] = a.y < c.y ? [a, c] : [c, a];
    if (oy < ox * .8 && up.state !== "held") {
     const rel = up.vy - (dn.on ? 0 : dn.vy);
     if (rel > 0) { land(up, {kind: "body", body: dn}, topOf(dn)); if (rel > 300) { dn.rig.react("under", rel); gaze(dn, up); if (rel > 1500 && dn.P.soft > .45) humour(dn, "flat"); else say(dn, 3, .5); } } else up.y = topOf(dn);
     continue;
    }
    const [l, r] = a.x < c.x ? [a, c] : [c, a], ma = l.state === "held" ? 1e3 : l.P.mass, mc = r.state === "held" ? 1e3 : r.P.mass, push = ox / (ma + mc);
    l.x -= push * mc; r.x += push * ma;
    const rel = l.vx - r.vx;
    if (rel > 0) { const e = Math.min(l.F.bounce, r.F.bounce) + .25, p = (1 + e) * rel / (1 / ma + 1 / mc); l.vx -= p / ma; r.vx += p / mc; if (rel > 220) { l.rig.react("bump", rel); r.rig.react("bump", rel); gaze(l, r); gaze(r, l); if (rel > 700) say(Math.random() < .5 ? l : r, 3, .7); } }
   }
  }
  function hit(b, kind, sp0) {
   const sp = sp0 / Math.sqrt(scaleG);
   if (kind === "land") { if (sp > 300) b.rig.react("land", sp); if (sp > 1500) later(b, 700, () => say(b, 4, .6)); b.rig.motion(0, 0); } else if (sp > 300) b.rig.react("wall", sp);
  }
  function intoBin(b) {
   b.state = "trash"; b.vx = b.vy = 0; b.x = (bin.x1 + bin.x2) / 2; b.y = bin.y + b.h * .75; b.el.style.zIndex = 3; b.rig.motion(0, 0); place(b);
   b.rig.setExpression("annoyed", {brief: true});
   later(b, 700, () => { b.state = "free"; b.y = bin.y; b.vy = -1250 * Math.sqrt(scaleG); b.vx = -260 * scaleG; b.el.style.zIndex = 10; b.rig.react("pickup"); say(b, 5); b.wag = true; });
  }
  function gaze(b, x) { b.rig.look((x.x - b.x) / (S * 1.6), ((topOf(x) + x.h / 2) - (topOf(b) + b.h / 2)) / (S * 2)); b.lookT = performance.now() + 1600; }
  function social(now) {
   const flying = bodies.filter((b) => (b.state === "free" && !b.on) || b.state === "held");
   for (const b of bodies) {
    if (b.state !== "free" || !b.on) continue;
    const f = flying.filter((x) => x !== b && Math.abs(x.x - b.x) < S * 3).sort((p, q) => Math.abs(p.x - b.x) - Math.abs(q.x - b.x))[0];
    if (f) gaze(b, f); else if (b.lookT && now > b.lookT) { b.lookT = 0; b.rig.look(null); }
    if (b.wag && resting(b)) { b.wag = false; b.rig.play("fingerWag"); }
   }
  }
  // everyone at rest: two neighbours who have not met since they last parted greet each other, in character
  function settle() {
   const rest = bodies.filter(resting);
   for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) {
    const a = rest[i], c = rest[j], key = [a, c].map((x) => bodies.indexOf(x) + x.id).sort().join("|");
    if (Math.abs(a.x - c.x) > S * 2.5 || Math.abs(a.y - c.y) > S * .5) { met.delete(key); continue; }
    if (Math.abs(a.x - c.x) > S * 1.6 || Math.abs(a.y - c.y) > S * .3 || met.has(key)) continue;
    met.add(key);
    gaze(a, c); gaze(c, a); a.rig.react("hello"); say(a, 2);
    later(c, 800, () => { c.rig.react("hello"); say(c, 2); });
    later(a, 2600, () => { a.rig.look(null); c.rig.look(null); });
    return;
   }
  }
  function later(b, ms, f) { const id = setTimeout(() => { pending.delete(id); if (bodies.includes(b)) { f(); wake(); } }, ms); pending.add(id); }
  function bubble(b, text) {
   const now = performance.now(); if (now - b.saidT < 900) return; b.saidT = now;
   const d = document.createElement("div"); d.className = "bubble"; d.textContent = text;
   d.style.left = Math.min(Math.max(b.x, 70), W - 70) + "px"; d.style.top = Math.max(8, topOf(b) - 14) + "px";
   stage.appendChild(d); setTimeout(() => d.remove(), 1700);
  }
  // her own funny moments: the rig acts, the world moves her (the sneeze's hop, hanging off a ledge, peeking in from a side)
  function humour(b, name) {
   if (!b || b.state !== "free") return;
   if (name === "hang") {
    const L = edges.filter((e) => e.kind === "ledge").sort((p, q) => Math.abs((p.x1 + p.x2) / 2 - b.x) - Math.abs((q.x1 + q.x2) / 2 - b.x))[0]; if (!L) return;
    const side = b.x > (L.x1 + L.x2) / 2 ? 1 : -1, ex = side > 0 ? L.x2 : L.x1;
    for (const x of bodies) if (x.on && x.on.body === b) x.on = null;
    b.on = null; b.state = "hang"; b.x = ex + side * b.hw * .35; b.y = L.y + b.h * 1.02; b.vx = b.vy = 0; place(b);
    b.rig.humour("hang");
    later(b, 2700, () => { b.state = "free"; if (Math.random() < .5) { b.y = L.y; b.x = ex - side * b.hw; b.on = L; b.rig.play("hop"); bubble(b, "Phew."); } });
    return;
   }
   if (name === "peek") {
    const side = b.x > W / 2 ? 1 : -1, floor = edges[0];
    for (const x of bodies) if (x.on && x.on.body === b) x.on = null;
    b.state = "peek"; b.rig.humour("peek"); b.on = floor; b.y = floor.y; b.x = side > 0 ? W + b.hw * .45 : -b.hw * .45; b.rig.look(-side * .9, 0); place(b);
    later(b, 2400, () => { b.state = "free"; b.x = side > 0 ? W - b.hw : b.hw; b.rig.look(null); b.rig.play("hop"); });
    return;
   }
   if (name === "slip" && !b.on) return;
   const r = b.rig.humour(name);
   if (r && r.kick) later(b, r.kick.at, () => { b.on = null; b.vy = r.kick.vy * Math.sqrt(scaleG); b.vx = (Math.random() - .5) * 160; });
  }
  let autoT = 0;
  function autoFunny() {
   clearTimeout(autoT);
   autoT = setTimeout(() => {
    if (seen && !document.hidden && !grab) {
     const free = bodies.filter(resting), b = free[Math.floor(Math.random() * free.length)];
     if (b) { const ok = (b.P.funny || []).filter((n) => n !== "monocle" || b.id === "tweed"); humour(b, ok[Math.floor(Math.random() * Math.min(2, ok.length))]); }
    }
    autoFunny();
   }, 9000 + Math.random() * 8000);
  }
  // your hand
  const ptrs = new Map();
  let grab = null, strokes = [];
  const at = (e) => { const r = stage.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now()}; };
  const hitBody = (p) => [...bodies].reverse().find((b) => !away(b) && p.x > b.x - b.hw * 1.1 && p.x < b.x + b.hw * 1.1 && p.y > topOf(b) - 8 && p.y < b.y + 6);
  const local = (b, p) => ({x: (p.x - b.x) / S * VB, y: (p.y - (b.y - S * FOOT)) / S * VB - 168});
  const velocity = (s) => { const a = s[0], c = s.at(-1), dt = (c.t - a.t) / 1000; if (dt <= 0) return {vx: 0, vy: 0}; const cap = 4000 * Math.sqrt(scaleG), vx = (c.x - a.x) / dt, vy = (c.y - a.y) / dt, sp = Math.hypot(vx, vy), k = sp > cap ? cap / sp : 1; return {vx: vx * k, vy: vy * k}; };
  stage.addEventListener("pointerdown", (e) => {
   const p = at(e); ptrs.set(e.pointerId, p);
   if (ptrs.size === 2 && grab && grab.b) { const [a, c] = [...ptrs.values()]; grab.pinch = {d0: Math.hypot(a.x - c.x, a.y - c.y) || 1}; if (grab.b.state === "held") grab.b.state = "free"; grab.mode = "pinch"; return; }
   const b = hitBody(p); if (!b) return;
   stage.setPointerCapture(e.pointerId); e.preventDefault();
   if (grab && grab.lastTap && grab.lastTap.b === b && p.t - grab.lastTap.t < 320) { grab = null; if (!(o.onTalk && o.onTalk(b))) say(b, 2); return; }
   grab = {b, mode: tool === "hand" ? "carry" : tool, p0: p, samples: [p], dx: b.x - p.x, dy: b.y - p.y, moved: false, t0: p.t};
   if (tool === "squish") b.rig.press(0);
   if (tool === "taffy") { const l = local(b, p); b.rig.grab(l.x, l.y); }
  });
  stage.addEventListener("pointermove", (e) => {
   const p = at(e); if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
   if (!grab || !grab.b) { if (e.pointerType === "mouse") pet(p); return; }
   const b = grab.b;
   if (grab.mode === "pinch" && ptrs.size === 2) { const [a, c] = [...ptrs.values()], d = Math.hypot(a.x - c.x, a.y - c.y), ratio = d / grab.pinch.d0, horiz = Math.abs(a.x - c.x) > Math.abs(a.y - c.y); b.rig.press(Math.max(-1, Math.min(1, (horiz ? -1 : 1) * (ratio - 1) * 1.6))); return; }
   grab.samples.push(p); if (grab.samples.length > 8) grab.samples.shift();
   if (Math.hypot(p.x - grab.p0.x, p.y - grab.p0.y) > 6) grab.moved = true;
   if (grab.mode === "squish") { b.rig.press(Math.max(-1, Math.min(1, -(p.y - grab.p0.y) / (S * .45)))); return; }
   if (grab.mode === "taffy") { b.rig.pull((p.x - grab.p0.x) / S * VB, (p.y - grab.p0.y) / S * VB); return; }
   if (grab.mode === "carry" && grab.moved) {
    if (b.state !== "held") { b.state = "held"; b.on = null; b.rig.react("pickup"); for (const x of bodies) if (x.on && x.on.body === b) x.on = null; wake(); }
    b.x = p.x + grab.dx; b.y = Math.min(edges[0].y, p.y + grab.dy);
    const v = velocity(grab.samples); b.vx = v.vx; b.vy = v.vy; b.rig.motion(v.vx, v.vy);
   }
  });
  const up = (e) => {
   ptrs.delete(e.pointerId);
   if (!grab || !grab.b) return;
   const b = grab.b, p = at(e);
   if (grab.mode === "pinch") { if (!ptrs.size) { b.rig.release(); grab = null; } return; }
   if (grab.mode === "squish" || grab.mode === "taffy") { b.rig.release(); b.rig.react("poke"); grab = null; wake(); return; }
   if (!grab.moved && p.t - grab.t0 < 350) { const l = local(b, p); b.rig.poke(l.x, l.y); b.rig.react("poke"); grab = {lastTap: {b, t: p.t}}; return; }
   if (b.state === "held") { b.state = "free"; const v = velocity(grab.samples); b.vx = v.vx; b.vy = v.vy; wake(); }
   grab = null;
  };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  stage.addEventListener("pointerleave", () => { strokes = []; });
  function pet(p) {
   const b = hitBody(p); if (!b || b.state !== "free") { strokes = []; return; }
   strokes = strokes.filter((q) => p.t - q.t <= 1500 && q.b === b); strokes.push({x: p.x, t: p.t, b});
   let travel = 0, turns = 0;
   for (let i = 1; i < strokes.length; i++) { const d = strokes[i].x - strokes[i - 1].x, before = i > 1 ? strokes[i - 1].x - strokes[i - 2].x : 0; travel += Math.abs(d); if (d && before && Math.sign(d) !== Math.sign(before)) turns++; }
   if (travel >= b.hw * 5 && turns >= 2 && !(b.petT && p.t - b.petT < 2500)) { b.petT = p.t; strokes = []; b.rig.react("pet"); b.rig.spawn("hearts"); }
  }
  const ro = new ResizeObserver(() => layout()); ro.observe(stage);
  const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; }); io.observe(stage);
  layout(); autoFunny();
  return {
   bodies, add, wake, layout, humour, MAX: MAXN,
   get S() { return S; }, get edges() { return edges; },
   set tool(t) { tool = t; }, get tool() { return tool; },
   pop() { const b = bodies.pop(); if (!b) return; b.rig.destroy(); b.el.remove(); for (const x of bodies) if (x.on && x.on.body === b) x.on = null; o.onCount && o.onCount(bodies.length); wake(); },
   drop(ids) { ids.forEach((id, i) => setTimeout(() => add(id, W * (.15 + .7 * (i + .5) / ids.length), -S * .2, {vx: (Math.random() - .5) * 300, intro: false}), i * 180)); },
   reset() { pending.forEach(clearTimeout); pending.clear(); met.clear(); while (bodies.length) { const b = bodies.pop(); b.rig.destroy(); b.el.remove(); } stage.querySelectorAll(".bubble").forEach((d) => d.remove()); o.onCount && o.onCount(0); },
   destroy() { alive = false; clearTimeout(autoT); ro.disconnect(); io.disconnect(); this.reset(); },
  };
 };
})(window);
