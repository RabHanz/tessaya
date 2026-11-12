/* The characters. Each one is a silhouette with its own material, features placed on its surface, appendages
 * that lag on the rig's secondary spring, and a fidget of its own. All original, all from the craft of weaving. */
(function (g) {
 "use strict";
 const TCS = g.TCS, {clamp, lerp, f1, blob, pink, smoothClosed, smoothOpen, mixHex, bell, ease, ramp} = TCS.util;
 const PI = Math.PI, TAU = PI * 2;
 const INK = "#1f1b1d", IVORY = "#F4F0E6";
 const common = {shine: "#ffffff", mouth: "#3a1a22", tongue: "#E66F7A", cheek: "#F08A90", star: "#F2B33D", heart: "#E2506A", zzz: "#7d8a99", steam: "#d9dde3"};
 const geo = (pts, R, o) => { const h = o.h * R.sy, hw = o.w / 2 * R.sx * (1 + Math.max(0, o.flare || 0)); return {d: smoothClosed(pts), h, hw, top: -h, cy: -h / 2}; };
 // a seeded scatter so textures sit still from frame to frame
 function scatter(n, seed) { const out = []; let s = seed; for (let i = 0; i < n; i++) { s = (s * 9301 + 49297) % 233280; const a = s / 233280; s = (s * 9301 + 49297) % 233280; const b = s / 233280; out.push([a * 2 - 1, b * 2 - 1]); } return out; }
 // an appendage: a smooth strand from a root, bending with the lag spring and the perk value
 function strand(x0, y0, len, ang, curl, sec, app, w, col, segs = 8) {
  const pts = [[x0, y0]]; let x = x0, y = y0, a = ang;
  for (let i = 1; i <= segs; i++) {
   const t = i / segs; a += curl / segs - sec.x * .012 * t - (app < 0 ? -app * .25 : -app * .05) * Math.sign(curl || 1) * t;
   x += Math.cos(a) * len / segs; y += Math.sin(a) * len / segs + (app < 0 ? -app * 2.2 * t : 0) + sec.y * .05 * t; pts.push([x, y]);
  }
  return {d: smoothOpen(pts), tip: pts[pts.length - 1]};
 }
 const C = TCS.CHARACTERS = {};

 // Pebble: a river stone, slate with a wet sheen and luminous eyes
 {
  const o = {w: 204, h: 150, nt: 2.6, nb: 3.3, taper: .1, flare: .03}, flecks = scatter(14, 7);
  C.pebble = {id: "pebble", handFill: (p) => mixHex(p.light, "#ffffff", .15), name: "Pebble", idea: "A river stone that sat in the dye bath: slate, glossy, luminous eyes. The R1's face on a body.",
   pal: Object.assign({}, common, {base: "#323b40", light: "#6a7a81", dark: "#12181b", rim: "#86c3c1", rimO: .75, edge: "#0b0f11", eye: "#F3EFE3", gloss: .6, mouth: "#0b0f11", zzz: "#9fb2bb", cheek: "#E57E86", glow: "#86c3c1"}),
   face: {R: 96, curv: .9, y: -6, ex: 36, eyY: -8, ew: 27, eh: 40, mY: 30, mw: 30, bg: 9},
   body(R, ctx) {
    const b = geo(blob(o, R.sx, R.sy), R, o), P = ctx.proj;
    let body = "";
    for (const [u, v] of flecks) { const x = u * o.w * .4, y = b.cy + v * b.h * .38; if (Math.abs(u) < .35 && Math.abs(v) < .45) continue; const q = P(x, y - b.cy); body += `<circle cx="${f1(q.x)}" cy="${f1(b.cy + q.y)}" r="${f1(1.6 * q.s)}" fill="#9fb2bb" opacity=".3"/>`; }
    b.body = body; return b;
   },
   fidget: {dur: 1500, fn: (t, a) => ({d: {tilt: 7 * a * Math.sin(t * TAU) * bell(t, 0, 1), yaw: .25 * Math.sin(t * TAU) * bell(t, 0, 1), sx: .02 * bell(t, .4, .6)}})},
  };
 }

 // Thread: one continuous strand wound round a soft capsule, its loose end curling up as an antenna
 {
  const o = {w: 156, h: 190, nt: 2.3, nb: 2.7, taper: .07};
  C.thread = {id: "thread", name: "Thread", idea: "One continuous thread, wound into a body. The loose end is how she gestures: it perks, curls into a question and droops.",
   pal: Object.assign({}, common, {base: "#3f9ca2", light: "#86cfcf", dark: "#155057", rim: "#c9f1ec", eye: "#0f2326", edge: "#0f3a40"}),
   face: {R: 86, curv: .95, y: 4, ex: 31, eyY: -10, ew: 24, eh: 37, mY: 26, mw: 27, bg: 9},
   body(R, ctx) {
    const b = geo(blob(o, R.sx, R.sy), R, o), P = ctx.proj, hw = o.w / 2 * R.sx;
    let body = "";
    // the wound thread: shallow arcs that bow with the view and slide with the turn
    for (let i = 0; i < 9; i++) {
     const y = b.top + b.h * (.1 + i * .1), sag = 7 + R.pitch * -10, q = P(0, y - b.cy);
     const x0 = -hw * 1.05 + q.x * .3, x1 = hw * 1.05 + q.x * .3;
     body += `<path d="M${f1(x0)} ${f1(y - 3)}Q${f1(q.x * .5)} ${f1(y + sag + (i % 2) * 2)} ${f1(x1)} ${f1(y + 3)}" stroke="${i % 2 ? "#ffffff" : "#0e4a50"}" stroke-width="${i % 2 ? 2.4 : 3.2}" fill="none" opacity="${i % 2 ? .22 : .2}"/>`;
    }
    b.body = body;
    const s = strand(8, b.top + 6, 78 * (1 + .15 * R.app), -PI / 2 + .25, 3.6 + R.app * .8, ctx.sec, R.app, 5, "#3f9ca2");
    b.front = `<path d="${s.d}" stroke="#155057" stroke-width="7.5" fill="none" stroke-linecap="round"/><path d="${s.d}" stroke="#4fb1b5" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="${f1(s.tip[0])}" cy="${f1(s.tip[1])}" r="3.6" fill="#86cfcf"/>`;
    return b;
   },
   fidget: {dur: 1300, fn: (t, a) => ({d: {app: 1.4 * bell(t, 0, .5) - .8 * bell(t, .5, 1), tilt: -4 * bell(t, 0, 1)}})},
  };
 }

 // Loom: a woven cushion in damson; the warp bars slide with the turn and the corner tassels swing
 {
  const o = {w: 196, h: 160, nt: 4.4, nb: 5.2};
  C.loom = {id: "loom", keep: (B) => [-1, 1].map((s) => [s * (B.hw * .9 + 12), B.top + 24, 15]), name: "Loom", idea: "The Tessaya mark woven into a cushion: nine warp bars, a weft row, tassels that swing a beat behind.",
   pal: Object.assign({}, common, {base: "#5f3174", light: "#9a6db0", dark: "#2a1033", rim: "#e4bdf2", eye: "#F7EEF9", edge: "#22092b", mouth: "#22092b", gloss: .4, zzz: "#b79bc4"}),
   face: {R: 110, curv: .75, y: -4, ex: 35, eyY: -10, ew: 25, eh: 38, mY: 28, mw: 30, bg: 9},
   body(R, ctx) {
    const b = geo(blob(o, R.sx, R.sy), R, o), P = ctx.proj, hw = o.w / 2 * R.sx;
    let body = "";
    for (let i = 0; i < 9; i++) {
     const u = (i - 4) / 4.4, q = P(u * hw, 0), w = 13 * q.s;
     body += `<rect x="${f1(q.x - w / 2)}" y="${f1(b.top)}" width="${f1(w)}" height="${f1(b.h)}" fill="${i % 2 ? "#ffffff" : "#1a0621"}" opacity="${i % 2 ? .07 : .13}"/>`;
    }
    const wy = -b.h * .14;
    for (let i = 0; i < 9; i++) { const u = (i - 4) / 4.4, q = P(u * hw, 0), w = 12 * q.s; body += `<rect x="${f1(q.x - w / 2)}" y="${f1(wy - 6 + (i % 2) * 6)}" width="${f1(w)}" height="7" rx="3" fill="#e4bdf2" opacity=".22"/>`; }
    b.body = body;
    let back = "";
    for (const side of [-1, 1]) {
     // tassels hang from the top corners and swing a beat behind her
     const x0 = side * (hw * .9), y0 = b.top + 10, sw = clamp(-ctx.sec.x * 1.4 + R.tilt * -.6, -40, 40);
     back += `<g transform="translate(${f1(x0)} ${f1(y0)}) rotate(${f1(sw)})"><path d="M0 0q${side * 10} 4 ${side * 12} 14" stroke="#2a1033" stroke-width="3.5" fill="none" stroke-linecap="round"/><g transform="translate(${side * 12} 14)"><rect x="-6" y="-2" width="12" height="6" rx="2.5" fill="#c98837"/><path d="M-6 4h12l2 18h-16z" fill="#E8A75A"/><path d="M-4 8v13M0 8v14M4 8v13" stroke="#c98837" stroke-width="1.6" stroke-linecap="round"/></g></g>`;
    }
    b.front = back;
    return b;
   },
   fidget: {dur: 1200, fn: (t, a) => ({d: {sx: .04 * a * Math.sin(t * TAU * 2) * bell(t, 0, 1), sy: -.03 * a * Math.sin(t * TAU * 2) * bell(t, 0, 1), tilt: 3 * Math.sin(t * TAU)}})},
  };
 }

 // Drop: a drop of dye whose colour follows her mood; the tip wobbles on its own
 {
  const W = 172, H = 196;
  const MOOD = {Joy: "#E6A23C", Love: "#E07085", Sad: "#4E7FBF", Sulky: "#6E6FA8", Angry: "#D2444B", Sleepy: "#6C4C8E", Surprise: "#E2B341", Curious: "#2F9C8F", Calm: "#2A8C96"};
  C.drop = {id: "drop", name: "Drop", idea: "A drop of dye. Her colour follows her mood: woad when calm, gold when happy, indigo when sad, madder when cross.",
   pal: Object.assign({}, common, {base: "#2A8C96", light: "#8fd6d6", dark: "#0e4b52", rim: "#ffffff", rimO: .6, eye: "#10202a", gloss: .85, edge: "#0e4b52"}),
   palette(R, expr) { const c = MOOD[TCS.EXPRESSIONS[expr].g] || MOOD.Calm; return Object.assign({}, this.pal, {base: c, light: mixHex(c, "#ffffff", .55), dark: mixHex(c, "#000000", .5), edge: mixHex(c, "#000000", .55)}); },
   face: {R: 92, curv: .9, y: 22, ex: 32, eyY: -8, ew: 25, eh: 38, mY: 26, mw: 28, bg: 9},
   body(R, ctx) {
    const pts = [], n = 64, sx = R.sx, sy = R.sy, tipX = ctx.sec.x * .9;
    for (let i = 0; i < n; i++) {
     const t = i / n * TAU, s = Math.sin(t / 2);
     let x = W / 2 * Math.sin(t) * Math.pow(s, 1.25) * 1.15, y = -H / 2 * Math.cos(t);
     const top = clamp(-y / (H / 2), 0, 1); x += tipX * Math.pow(top, 3);
     pts.push([x * sx, (y - H / 2) * sy]);
    }
    const h = H * sy, b = {d: smoothClosed(pts), h, hw: W / 2 * sx * .98, top: -h, cy: -h * .42};
    return b;
   },
   fidget: {dur: 1400, fn: (t, a) => ({d: {sx: .06 * a * Math.sin(t * TAU * 2.5) * (1 - t), sy: -.05 * a * Math.sin(t * TAU * 2.5) * (1 - t), lean: 3 * Math.sin(t * TAU * 1.2) * (1 - t)}})},
  };
 }

 // Selvedge: a soft cloth pillow; the woven edge is a pinked hem at the bottom and a stitched label, never a frame
 {
  const o = {w: 208, h: 152, nt: 3.1, nb: 3.8};
  C.selvedge = {id: "selvedge", name: "Selvedge", idea: "The finished edge of cloth, made into a pillow: a pinked hem and a running stitch. No frame round the face.",
   pal: Object.assign({}, common, {base: "#E8DCC4", light: "#fffaf0", dark: "#a8977a", rim: "#ffffff", rimO: .55, eye: "#22201f", edge: "#8b7a5e", gloss: .45, zzz: "#8b7a5e", steam: "#c8ccd3"}),
   face: {R: 100, curv: .85, y: -6, ex: 37, eyY: -8, ew: 26, eh: 39, mY: 28, mw: 30, bg: 9},
   body(R, ctx) {
    const raw = blob(o, R.sx, R.sy, 72), h = o.h * R.sy;
    const pts = pink(raw, 6.5, 2.6, (x, y) => y > -h * .14);
    const b = {d: smoothClosed(pts), h, hw: o.w / 2 * R.sx, top: -h, cy: -h / 2};
    const hw = b.hw;
    b.body = `<path d="M${f1(-hw * .9)} ${f1(-h * .17)}Q0 ${f1(-h * .06)} ${f1(hw * .9)} ${f1(-h * .17)}" stroke="#a8977a" stroke-width="2.6" stroke-dasharray="7 6" fill="none" stroke-linecap="round" opacity=".8"/>`
     + `<path d="M${f1(-hw * .9)} ${f1(-h * .2)}Q0 ${f1(-h * .09)} ${f1(hw * .9)} ${f1(-h * .2)}" stroke="#fffaf0" stroke-width="1.4" fill="none" opacity=".5"/>`;
    return b;
   },
   fidget: {dur: 1100, fn: (t, a) => ({d: {app: -1.6 * bell(t, 0, .4) + .8 * bell(t, .4, .8), sx: .03 * bell(t, 0, .3), sy: -.03 * bell(t, 0, .3), tilt: 3 * bell(t, .1, .7)}})},
  };
 }

 // Spool: a spool of madder thread between two wooden flanges; the loose end is her antenna
 {
  const cw = 128, ch = 136, fl = 16, fw = 164;
  C.spool = {id: "spool", keep: (B) => [[B.hw * .64, -B.h * .875, 24]], name: "Spool", idea: "A spool of thread. The flanges give her a real top and bottom; the loose end perks, curls into a question and droops a beat behind her.",
   pal: Object.assign({}, common, {base: "#D35F69", light: "#f4a0a5", dark: "#7e2a35", rim: "#ffd1d4", eye: "#2a1216", edge: "#6c2430", gloss: .4}),
   face: {R: 80, curv: .95, y: 2, ex: 29, eyY: -10, ew: 23, eh: 35, mY: 24, mw: 26, bg: 8},
   body(R, ctx) {
    const sx = R.sx, sy = R.sy, H = (ch + fl * 2) * sy, x = cw / 2 * sx, y0 = -fl * sy, y1 = -(fl + ch) * sy, rr = 10;
    const d = `M${f1(-x)} ${f1(y1 + rr)}Q${f1(-x)} ${f1(y1)} ${f1(-x + rr)} ${f1(y1)}H${f1(x - rr)}Q${f1(x)} ${f1(y1)} ${f1(x)} ${f1(y1 + rr)}V${f1(y0 - rr)}Q${f1(x)} ${f1(y0)} ${f1(x - rr)} ${f1(y0)}H${f1(-x + rr)}Q${f1(-x)} ${f1(y0)} ${f1(-x)} ${f1(y0 - rr)}Z`;
    const b = {d, h: H, hw: fw / 2 * sx, top: -H, cy: (y0 + y1) / 2};
    let body = ""; const sag = 5 - R.pitch * 9;
    for (let i = 0; i < 16; i++) { const y = y1 + 6 + i * (ch * sy - 12) / 15; body += `<path d="M${f1(-x)} ${f1(y)}Q0 ${f1(y + sag)} ${f1(x)} ${f1(y)}" stroke="${i % 2 ? "#ffffff" : "#6c2430"}" stroke-width="2" fill="none" opacity="${i % 2 ? .13 : .16}"/>`; }
    b.body = body;
    const fx = fw / 2 * sx, ry = 9 + R.pitch * -6, wood = "#C99A68", woodD = "#8b6239", woodL = "#ecc796";
    const flange = (yt, top) => `<path d="M${f1(-fx)} ${f1(yt)}V${f1(yt + fl * sy)}A${f1(fx)} ${f1(Math.max(3, ry))} 0 0 0 ${f1(fx)} ${f1(yt + fl * sy)}V${f1(yt)}Z" fill="${woodD}"/>`
     + `<ellipse cx="0" cy="${f1(yt)}" rx="${f1(fx)}" ry="${f1(Math.max(3, ry))}" fill="${top ? woodL : wood}"/>` + (top ? `<ellipse cx="0" cy="${f1(yt)}" rx="10" ry="${f1(Math.max(2, ry * .4))}" fill="${woodD}"/>` : "");
    const pts = [[x - 2, y1 + ch * sy * .25]]; let px = pts[0][0], py = pts[0][1], a = -PI / 2 + .55;
    for (let i = 1; i <= 9; i++) { const t = i / 9; a += (-3.4 - R.app * .5) / 9 * (R.app < -.3 ? -.6 : 1) - ctx.sec.x * .014 * t; px += Math.cos(a) * 8.4 * (1 + .1 * R.app); py += Math.sin(a) * 8.4 + (R.app < 0 ? -R.app * 3 * t : 0); pts.push([px, py]); }
    const sd = smoothOpen(pts);
    b.back = flange(y0, false);
    b.front = flange(y1 - fl * sy, true) + `<path d="${sd}" stroke="#7e2a35" stroke-width="6" fill="none" stroke-linecap="round"/><path d="${sd}" stroke="#D35F69" stroke-width="3.6" fill="none" stroke-linecap="round"/>`;
    return b;
   },
   fidget: {dur: 1400, fn: (t, a) => ({d: {yaw: .9 * Math.sin(t * TAU) * bell(t, 0, 1), app: 1.2 * bell(t, .2, .8), lift: -5 * a * bell(t, .3, .7)}})},
  };
 }

 // Shuttle: the weaver's boat-shaped shuttle in warm wood, trailing a thread that swings behind her
 {
  const W = 238, H = 108;
  C.shuttle = {id: "shuttle", keep: (B) => [[B.hw * .65 + 13, -B.h * .49, Math.max(16, B.h * .14)]], name: "Shuttle", idea: "The weaver's shuttle: long, quick, always going somewhere. A thread trails out behind and swings a beat late.",
   pal: Object.assign({}, common, {base: "#BE8A52", light: "#edc28c", dark: "#6c4421", rim: "#ffe2b8", eye: "#24160b", edge: "#5a381a", gloss: .5}),
   face: {R: 120, curv: .65, y: 0, ex: 32, eyY: -8, ew: 22, eh: 32, mY: 22, mw: 26, bg: 7},
   body(R, ctx) {
    const pts = [], n = 72, sx = R.sx, sy = R.sy;
    for (let i = 0; i < n; i++) { const t = i / n * TAU, c = Math.cos(t), s = Math.sin(t); const x = W / 2 * c, y = H / 2 * Math.sign(s) * Math.pow(Math.abs(s), 1.05) * (1 - .18 * c * c) * (s > 0 ? .92 : 1.05); pts.push([x * sx, (y - H / 2) * sy]); }
    const h = H * sy, b = {d: smoothClosed(pts), h, hw: W / 2 * sx * .92, top: -h, cy: -h / 2};
    let body = "";
    for (let i = 0; i < 4; i++) { const y = -h * (.25 + i * .17); body += `<path d="M${f1(-W * .42 * sx)} ${f1(y)}Q0 ${f1(y - 8 + i * 3)} ${f1(W * .42 * sx)} ${f1(y)}" stroke="#7a4d24" stroke-width="1.6" fill="none" opacity=".22"/>`; }
    body += `<rect x="${f1(W * .3 * sx)}" y="${f1(-h * .62)}" width="${f1(26 * sx)}" height="${f1(h * .26)}" rx="7" fill="#6c4421"/><rect x="${f1(W * .3 * sx + 4)}" y="${f1(-h * .58)}" width="${f1(18 * sx)}" height="${f1(h * .18)}" rx="5" fill="#5FB3B3"/>`;
    b.body = body;
    const x0 = -W / 2 * sx + 4, y0 = -h * .5, pts2 = [[x0, y0]]; let px = x0, py = y0;
    for (let i = 1; i <= 10; i++) { const t = i / 10; px -= 6.5; py += 4.2 + Math.sin(t * 5 + ctx.sec.x * .15) * 3 + ctx.sec.y * .05; px += ctx.sec.x * .25 * t; pts2.push([Math.max(-150, px), Math.min(-2, py)]); }
    b.back = `<path d="${smoothOpen(pts2)}" stroke="#5FB3B3" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
    return b;
   },
   fidget: {dur: 1300, fn: (t, a) => ({d: {lean: 6 * a * Math.sin(t * TAU * 2) * bell(t, 0, 1), yaw: .35 * Math.sin(t * TAU * 2) * bell(t, 0, 1), lift: -4 * bell(t, .1, .9)}})},
  };
 }

 // Felt: a ball of felted wool with two thread-loop ears that settle a moment apart
 {
  const o = {w: 182, h: 172, nt: 2.1, nb: 2.35}, fib = scatter(46, 11);
  C.felt = {id: "felt", name: "Felt", idea: "A ball of felted wool, fuzzy at the edge, with two thread-loop ears that flop and settle a moment apart. The warmest one.",
   pal: Object.assign({}, common, {base: "#D9857D", light: "#f8bcb2", dark: "#8f4446", rim: "#ffe0d2", eye: "#2b1517", edge: "#7b3537", gloss: .28, cheek: "#ff9aa0"}),
   face: {R: 90, curv: .95, y: 2, ex: 33, eyY: -8, ew: 26, eh: 39, mY: 28, mw: 28, bg: 9},
   body(R, ctx) {
    const raw = blob(o, R.sx, R.sy, 96), h = o.h * R.sy, cy = -h / 2;
    const pts = raw.map(([x, y], i) => { const a = i / raw.length * TAU, k = 1 + .016 * Math.sin(a * 23) + .01 * Math.sin(a * 41 + 1); return [x * k, cy + (y - cy) * k]; });
    const b = {d: smoothClosed(pts), h, hw: o.w / 2 * R.sx, top: -h, cy}, P = ctx.proj;
    let body = "";
    for (const [u, v] of fib) { const x = u * o.w * .44, y = v * h * .42; if (u * u + v * v > .95) continue; const q = P(x, y); const a = (u * 7 + v * 3) % PI; body += `<path d="M${f1(q.x)} ${f1(cy + q.y)}l${f1(Math.cos(a) * 4 * q.s)} ${f1(Math.sin(a) * 4)}" stroke="${(u + v) > 0 ? "#8f4446" : "#fff4ee"}" stroke-width="1.2" opacity=".28" stroke-linecap="round"/>`; }
    b.body = body;
    let back = "";
    for (const side of [-1, 1]) {
     const lag = ctx.sec.x * (side > 0 ? .9 : 1.2), perk = R.app, x0 = side * 40 * R.sx + R.yaw * -14, y0 = -h + 14;
     const ang = side * (18 - perk * 12) + lag * 1.2 + (perk < 0 ? side * -perk * 38 : 0);
     back += `<g transform="translate(${f1(x0)} ${f1(y0)}) rotate(${f1(ang)})"><ellipse cx="0" cy="-22" rx="13" ry="${f1(24 + perk * 3)}" fill="none" stroke="#8f4446" stroke-width="10"/><ellipse cx="0" cy="-22" rx="13" ry="${f1(24 + perk * 3)}" fill="none" stroke="#D9857D" stroke-width="6.5"/><path d="M-6 -40q6 -6 12 0" stroke="#ffe0d2" stroke-width="2" fill="none" opacity=".7"/></g>`;
    }
    b.back = back;
    return b;
   },
   fidget: {dur: 1100, fn: (t, a) => ({d: {app: -1.2 * bell(t, 0, .3) + 1 * bell(t, .3, .7), lift: -14 * a * bell(t, .15, .55), sy: -.08 * bell(t, 0, .15) + .05 * bell(t, .15, .5) - .06 * bell(t, .58, .75), sx: .06 * bell(t, 0, .15) - .03 * bell(t, .15, .5) + .05 * bell(t, .58, .75)}})},
  };
 }

 // Swatch: a square of indigo cloth with pinked edges and a corner that curls when something waits
 {
  const o = {w: 180, h: 178, nt: 7, nb: 7.5};
  C.swatch = {id: "swatch", handFill: (p) => mixHex(p.light, "#ffffff", .2), name: "Swatch", idea: "A cloth swatch, pinked all round. The top corner curls back; it flicks up when something waits for you. Dry and editorial.",
   pal: Object.assign({}, common, {base: "#2F5F8A", light: "#6d9bc6", dark: "#14304d", rim: "#b9d8f2", eye: IVORY, edge: "#102740", mouth: "#0d1f33", zzz: "#9db5cc", gloss: .3}),
   face: {R: 120, curv: .6, y: 6, ex: 35, eyY: -10, ew: 25, eh: 37, mY: 26, mw: 30, bg: 9, yawMax: .25},
   body(R, ctx) {
    const h = o.h * R.sy, hw = o.w / 2 * R.sx, lift = clamp(.5 + R.app * .35 + ctx.sec.x * .02, .2, 1), cut = 34 * lift;
    let raw = blob(o, R.sx, R.sy, 80).map(([x, y]) => { const ex = x - (hw - cut), ey = (-h + cut) - y; if (ex > 0 && ey > 0 && ex + ey > cut) { const k = (ex + ey - cut) / 2; return [x - k, y + k]; } return [x, y]; });
    const pts = pink(raw, 7, 2.6, () => true);
    const b = {d: smoothClosed(pts), h, hw, top: -h, cy: -h / 2};
    let body = "";
    for (let i = -6; i < 8; i++) body += `<path d="M${f1(i * 26 - 60)} ${f1(-h)}l${f1(h * .6)} ${f1(h)}" stroke="#ffffff" stroke-width="1.2" opacity=".07"/>`;
    b.body = body;
    const ax = hw - cut, ay = -h;
    b.front = `<path d="M${f1(ax)} ${f1(ay + 2)}L${f1(hw - 2)} ${f1(-h + cut)}L${f1(ax + 4)} ${f1(-h + cut + 2)}Z" fill="#8fb4d6"/><path d="M${f1(ax)} ${f1(ay + 2)}L${f1(ax + 4)} ${f1(-h + cut + 2)}" stroke="#14304d" stroke-width="1.6" opacity=".5"/>`;
    b.faceUnder = `<path d="M${f1(ax - 2)} ${f1(ay)}L${f1(hw)} ${f1(-h + cut + 2)}L${f1(hw)} ${f1(-h + cut + 14)}Z" fill="#000" opacity=".12"/>`;
    return b;
   },
   fidget: {dur: 1100, fn: (t, a) => ({d: {app: 1.6 * bell(t, 0, .5) - .4 * bell(t, .5, 1), tilt: -3 * bell(t, 0, 1)}})},
  };
 }

 // Thimble (new): polished silver, a field of dimples that slide as she turns, a rolled rim
 {
  const o = {w: 154, h: 170, nt: 2.05, nb: 9, taper: .12, flare: .05};
  const dimples = []; for (let r = 0; r < 4; r++) for (let c = -5; c <= 5; c++) dimples.push([c * .19 + (r % 2) * .095, r]);
  C.thimble = {id: "thimble", name: "Thimble", idea: "A silver thimble: the dimples slide across her dome as she turns, the light runs over the metal. Precise, unflappable, a little proper.",
   pal: Object.assign({}, common, {base: "#b7bdc4", light: "#ffffff", dark: "#5f6871", rim: "#ffffff", rimO: .7, eye: "#1b2025", edge: "#4c545c", gloss: .95, mouth: "#2a1218", zzz: "#7d8a99"}),
   defs: (uid) => `<linearGradient id="mt${uid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".22" stop-color="#fff" stop-opacity=".55"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/><stop offset=".72" stop-color="#3a4249" stop-opacity=".25"/><stop offset=".86" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
   face: {R: 78, curv: .95, y: 22, ex: 28, eyY: -10, ew: 22, eh: 33, mY: 21, mw: 24, bg: 8},
   body(R, ctx) {
    const b = geo(blob(o, R.sx, R.sy), R, o), P = ctx.proj, hw = o.w / 2 * R.sx;
    let body = `<rect x="${f1(-hw * 1.1 - R.yaw * 30)}" y="${f1(b.top)}" width="${f1(hw * 2.2)}" height="${f1(b.h)}" fill="url(#mt${ctx.uid})"/>`;
    for (const [u, r] of dimples) {
     const y = b.top + b.h * (.13 + r * .085), wAt = hw * Math.sqrt(clamp(1 - Math.pow((b.cy - y) / (b.h * .62), 2), .1, 1)), q = P(u * wAt * 1.05, y - b.cy);
     if (q.s < .3) continue;
     const rr = 4.4 * (1 - r * .04);
     body += `<ellipse cx="${f1(q.x)}" cy="${f1(b.cy + q.y)}" rx="${f1(rr * q.s)}" ry="${f1(rr * .85)}" fill="#59626b" opacity=".45"/><path d="M${f1(q.x - rr * q.s * .7)} ${f1(b.cy + q.y + 1.5)}q${f1(rr * q.s * .7)} ${f1(rr * .7)} ${f1(rr * q.s * 1.4)} 0" stroke="#fff" stroke-width="1.1" fill="none" opacity=".8"/>`;
    }
    body += `<path d="M${f1(-hw * 1.1)} ${f1(-16 * R.sy)}Q0 ${f1(-10 * R.sy)} ${f1(hw * 1.1)} ${f1(-16 * R.sy)}V0H${f1(-hw * 1.1)}Z" fill="#8e969e" opacity=".55"/><path d="M${f1(-hw * 1.1)} ${f1(-16 * R.sy)}Q0 ${f1(-10 * R.sy)} ${f1(hw * 1.1)} ${f1(-16 * R.sy)}" stroke="#fff" stroke-width="2" fill="none" opacity=".75"/>`;
    b.body = body;
    return b;
   },
   fidget: {dur: 1400, fn: (t, a) => ({d: {yaw: -.6 * Math.sin(t * TAU) * bell(t, 0, 1), pitch: -.12 * bell(t, .2, .8), glow: .25 * bell(t, .3, .7)}})},
  };
 }

 // Purl (new): a ball of mustard yarn with two knitting needles stuck in at a jaunty angle
 {
  const o = {w: 178, h: 170, nt: 2.05, nb: 2.3};
  const wraps = [[-.6, .55], [-.25, .8], [.15, .65], [.5, .7], [.85, .45], [1.25, .6], [1.6, .75], [2.0, .5]];
  C.purl = {id: "purl", name: "Purl", idea: "A ball of yarn mid-project, two needles stuck in like hair. The strands roll as she turns; the needles click when she is pleased.",
   pal: Object.assign({}, common, {base: "#E2A447", light: "#ffd894", dark: "#9b5f17", rim: "#fff0c9", eye: "#2d1a08", edge: "#86500f", gloss: .3}),
   face: {R: 88, curv: .95, y: 6, ex: 32, eyY: -8, ew: 25, eh: 37, mY: 27, mw: 27, bg: 9},
   body(R, ctx) {
    const b = geo(blob(o, R.sx, R.sy), R, o), hw = o.w / 2 * R.sx, rx = hw * 1.02, ry = b.h * .52;
    let body = "";
    for (const [a0, k] of wraps) {
     const a = a0 + R.yaw * .7;
     body += `<ellipse cx="0" cy="${f1(b.cy)}" rx="${f1(rx * Math.abs(Math.cos(a)) * .95 + 6)}" ry="${f1(ry * .98)}" transform="rotate(${f1(a * 38 + 30)} 0 ${f1(b.cy)})" stroke="${k > .6 ? "#9b5f17" : "#fff3d6"}" stroke-width="2.4" fill="none" opacity="${k > .6 ? .26 : .3}"/>`;
    }
    b.body = body;
    let back = "";
    for (const side of [-1, 1]) {
     const x0 = side * 22, y0 = b.top + 34, ang = side * (28 - R.app * 10) + ctx.sec.x * .9 - 90;
     const L = 84, ex = x0 + Math.cos(ang * PI / 180) * L, ey = y0 + Math.sin(ang * PI / 180) * L;
     back += `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(ex)}" y2="${f1(ey)}" stroke="#4a3c52" stroke-width="6" stroke-linecap="round"/><line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(ex)}" y2="${f1(ey)}" stroke="#8f7d9b" stroke-width="2" stroke-linecap="round" opacity=".7"/><circle cx="${f1(ex)}" cy="${f1(ey)}" r="7" fill="${side < 0 ? "#5FB3B3" : "#E0707A"}"/><circle cx="${f1(ex - 2)}" cy="${f1(ey - 2)}" r="2.2" fill="#fff" opacity=".7"/>`;
    }
    b.back = back;
    return b;
   },
   fidget: {dur: 1200, fn: (t, a) => ({d: {app: 1.2 * Math.sin(t * TAU * 2) * bell(t, 0, 1), tilt: 6 * Math.sin(t * TAU) * bell(t, 0, 1), yaw: .3 * bell(t, .2, .8)}})},
  };
 }

 // Tweed (new, Alfred's): a seasoned gentleman. Silver hair combed neat, distinguished brows, a trim moustache,
 // a waistcoat with a watch chain and a bow tie. Composed posture; a slight bow and one raised eyebrow are his.
 {
  const o = {w: 168, h: 200, nt: 2.5, nb: 3.8, taper: .07};
  const hb = scatter(60, 23);
  // The waistcoat chain as a rope: verlet points with length constraints and gravity, pinned at the button and,
 // when something holds it, at the far end. Free, it sags, swings and settles by itself. One rope per rig.
 // Ropes: verlet points (22 segments) with a fixed length, gravity, damping and 12 constraint passes per step, pinned
 // at one or both ends. They collide with a floor (the ground, or a ledge such as the waistcoat front) so they drape
 // instead of falling through. One set per rig.
 const ROPES = new Map();
 function makeRope(a, len, n = 23) { const seg = len / (n - 1); return {seg, pts: Array.from({length: n}, (_, i) => ({x: a[0], y: a[1] + i * seg, px: a[0], py: a[1] + i * seg}))}; }
 function stepRope(r, a, end, dt, floor = 1e9) {
  // a fixed 1/120 s step, decoupled from the frame rate; leftover time carries to the next frame
  const P = r.pts, g = 1100, h = 1 / 120, vmax = 6; let e = 0;
  r.acc = Math.min((r.acc || 0) + dt, .1);
  while (r.acc >= h) {
   r.acc -= h;
   for (let i = 1; i < P.length; i++) { const p = P[i]; let vx = (p.x - p.px) * .972, vy = (p.y - p.py) * .972; const v = Math.hypot(vx, vy); if (v > vmax) { vx *= vmax / v; vy *= vmax / v; } p.px = p.x; p.py = p.y; p.x += vx; p.y += vy + g * h * h; }
   for (let it = 0; it < 12; it++) {
    P[0].x = a[0]; P[0].y = a[1];
    if (end) { const Lp = P[P.length - 1]; Lp.x = end[0]; Lp.y = end[1]; }
    for (let i = 0; i < P.length - 1; i++) {
     const p = P[i], q = P[i + 1], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1e-6, k = (d - r.seg) / d;
     const wp = i === 0 ? 0 : .5, wq = (end && i + 1 === P.length - 1) ? 0 : .5, w = wp + wq || 1;
     p.x += dx * k * wp / w; p.y += dy * k * wp / w; q.x -= dx * k * wq / w; q.y -= dy * k * wq / w;
    }
    for (const p of P) if (p.y > floor) p.y = floor;
   }
  }
  for (const p of P) e += Math.abs(p.x - p.px) + Math.abs(p.y - p.py);
  return e;
 }

 C.tweed = {id: "tweed", gentleman: true, name: "Tweed", idea: "A seasoned gentleman in linen and tweed: silver hair combed neat, distinguished brows, a trim moustache, a waistcoat, a watch chain and a bow tie. Composed, charming, a little dry.",
   pal: Object.assign({}, common, {base: "#E6DAC6", light: "#fff8ec", dark: "#a8977c", rim: "#ffffff", rimO: .5, eye: "#231d1a", edge: "#7e6e55", gloss: .4, brow: "#c9ccd1", browEdge: "#8d939b", zzz: "#8d939b"}),
   face: {R: 84, curv: .95, y: -31, ex: 30, eyY: -8, ew: 23, eh: 34, mY: 22, mw: 22, bg: 9, bw: 1.35},
   bias: {bo: .55, lu: .03, pitch: -.04, by: 1},
   defs: (uid) => `<linearGradient id="hr${uid}" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#f6f7f9"/><stop offset=".5" stop-color="#dde1e6"/><stop offset="1" stop-color="#b9c0c8"/></linearGradient>`,
   shoulder: .74,
   idle: [["raisedBrow", 1.2], ["bow", .5], ["composed", .8], ["steepleHold", .7], ["adjustCuff", .4], ["adjustTie", .4], ["pocketWatch", .5]],
   // a dignified gesture set: he never hops, twirls, pumps a fist or squeals into his cheeks
   remap: {wave: "raiseHand", fistPump: "nodFirm", hop: "rise", spin: "bow", cheeks: "adjustTie", giggleOnce: "chuckle", squish: "adjustCuff", stomp: "nodFirm", shrug: "shrugSmall", fingerWag: "shakeSmall", eyeRoll: "raisedBrow", stretch: "rise"},
   exprHands: {excited: {L: ["steeple", "steeple"], R: ["steeple", "steeple"]}, thinking: {L: ["steeple", "steeple"], R: ["steeple", "steeple"]}, proud: {R: ["heart", "back"]},
    shy: {R: ["heart", "back"]}, embarrassed: {R: ["tie", "grip", -9]}, giggle: {R: ["heart", "back"]}, frustrated: {R: ["temple", "back"]}, angry: {L: ["behind", "back"], R: ["behind", "back"]},
    lonely: {R: ["heart", "back"]}, worried: {L: ["steeple", "steeple"], R: ["steeple", "steeple"]}, sulky: {L: ["behind", "back"], R: ["behind", "back"]}, determined: {R: ["cuffR", "back"], L: ["cuffL", "pinch"]}},
   spots: {monoKey: (B, F, side, q) => {
     // the hand is placed so that its pinch holds the monocle's lower-right rim: rest (p 0) → eye (p 1) on an outward arc
     const t = ROPES.get(F.uid), m = t && t.mono, E = F.lastEyes || [], s = .53 * (E.length === 2 ? Math.abs(E[0].cx - E[1].cx) : 70) / 19;
     if (!m || !m.restPt || !m.eye) return [B.hw * .3, -B.h * .2, -10, 1];
     const p = q[7] || 0, off = q[8] || 0, rot = -10 - 16 * p, a = rot * Math.PI / 180, px = -1.7 * s, py = -14.5 * s, k = m.r * .55;
     const pin = [px * Math.cos(a) - py * Math.sin(a), px * Math.sin(a) + py * Math.cos(a)], from = [m.restPt[0] + k - pin[0], m.restPt[1] + k - pin[1]], to = [m.eye[0] + k - pin[0], m.eye[1] + k - pin[1]];
     return [from[0] + (to[0] - from[0]) * p + Math.sin(p * Math.PI) * 38 + off * 12, from[1] + (to[1] - from[1]) * p + off * 10, rot, 1];
    }, watchKey: (B, F, side, q) => { const p = q[7] || 0, a = [B.hw * .62, -B.h * .35 + 6], z = [B.hw * .38, -B.h * .27]; return [a[0] + (z[0] - a[0]) * p, a[1] + (z[1] - a[1]) * p - Math.sin(p * Math.PI) * 10, -12 + 8 * p, 1]; },
    chin: (B, F, side) => [side * (F.mw * .5 + 30), F.cy + F.mY + F.mw * .32 + 10, side * -15, 1], tie: (B, F, side) => [side * 13, -B.h * .385 + 14, side * -20, .95], pocket: (B, F, side) => [B.hw * .62, -B.h * .35 + 4, -12, .95], watchView: (B, F, side) => [B.hw * .38, -B.h * .27, -4, 1]},
   body(R, ctx) {
    const b = geo(blob(o, R.sx, R.sy), R, o), hw = o.w / 2 * R.sx, h = b.h, P = ctx.proj;
    // the waistcoat: the lower part of him, a V opening with the shirt, two gold buttons and a watch chain
    const wy = -h * .385, vx = 24 * R.sx, vy = -h * .18, sh = R.yaw * hw * .3;
    let body = `<g data-l="attire"><path data-l="attire-coat" d="M${f1(-hw * 1.2)} ${f1(wy + 6)}Q${f1(-hw * .5)} ${f1(wy - 2)} ${f1(sh - vx)} ${f1(wy - 4)}L${f1(sh)} ${f1(vy)}L${f1(sh + vx)} ${f1(wy - 4)}Q${f1(hw * .5)} ${f1(wy - 2)} ${f1(hw * 1.2)} ${f1(wy + 6)}V2H${f1(-hw * 1.2)}Z" fill="#3a3350"/>`;
    for (const [u, v] of hb) { const x = u * hw * .95, y = wy + 8 + (v * .5 + .5) * (h * .4); body += `<path d="M${f1(x)} ${f1(y)}l3 3l3 -3" stroke="#fff" stroke-width=".9" fill="none" opacity=".09"/>`; }
    body += `<path d="M${f1(sh - vx + 3)} ${f1(wy - 3)}L${f1(sh)} ${f1(vy - 4)}L${f1(sh + vx - 3)} ${f1(wy - 3)}Z" fill="#fbf8f1"/><path d="M${f1(sh)} ${f1(vy - 4)}V${f1(-6)}" stroke="#2a243b" stroke-width="1.4" opacity=".6"/>`
     + [0, 1].map((i) => `<circle cx="${f1(sh + 1)}" cy="${f1(vy + 12 + i * 18)}" r="3.4" fill="#E8A75A" stroke="#a86f2a" stroke-width="1"/>`).join("")
     + `<rect x="${f1(sh + hw * .51)}" y="${f1(-h * .35 - 4)}" width="15" height="3.4" rx="1.5" fill="#2a243b"/>`
     + `<path d="M${f1(-hw * 1.2)} ${f1(wy + 6)}Q${f1(-hw * .5)} ${f1(wy - 2)} ${f1(sh - vx)} ${f1(wy - 4)}L${f1(sh)} ${f1(vy)}L${f1(sh + vx)} ${f1(wy - 4)}Q${f1(hw * .5)} ${f1(wy - 2)} ${f1(hw * 1.2)} ${f1(wy + 6)}" stroke="#fff" stroke-width="1.2" fill="none" opacity=".25"/>`;
    // the bow tie at the collar
    const bx = sh, by = wy - 1, k = .74;
    body += `<g data-l="attire-tie" transform="translate(${f1(bx)} ${f1(by)}) scale(${f1(k)})"><path d="M0 0L-15 -8Q-18 0 -15 8Z" fill="#8E1F2F"/><path d="M0 0L15 -8Q18 0 15 8Z" fill="#8E1F2F"/><rect x="-4" y="-4.5" width="8" height="9" rx="2.5" fill="#6e1522"/><path d="M-13 -5l9 4M13 -5l-9 4" stroke="#fff" stroke-width="1" opacity=".3"/></g></g>`;
    // silver hair: round 1's swept wave on the top-front of the head, with a side parting. It is drawn on the body
    // layer, which is clipped to the head's outline, so it can never stick out past the head. Raised just enough to
    // clear the brows, with a little extra mass at the back and the temples (also inside the outline).
    const hy = -h, part = -hw * .28 + R.yaw * 16;
    // the swept wave: high over the forehead on the parting side, then rolling out and down on the right into a soft,
    // rounded roll above the temple (round 1's silhouette, kept inside the head)
    const wave = `M${f1(-hw * 1.05)} ${f1(hy + h * .25)}Q${f1(-hw * 1.02)} ${f1(hy - 2)} ${f1(part)} ${f1(hy - 3)}Q${f1(hw * .75)} ${f1(hy - 4)} ${f1(hw * 1.06)} ${f1(hy + h * .3)}`
     + `Q${f1(hw * 1.0)} ${f1(hy + h * .36)} ${f1(hw * .86)} ${f1(hy + h * .31)}Q${f1(hw * .74)} ${f1(hy + h * .26)} ${f1(hw * .7)} ${f1(hy + h * .19)}`
     + `Q${f1(hw * .5)} ${f1(hy + h * .085)} ${f1(part + 6)} ${f1(hy + h * .1)}Q${f1(part - 2)} ${f1(hy + h * .08)} ${f1(part - 6)} ${f1(hy + h * .095)}Q${f1(-hw * .45)} ${f1(hy + h * .09)} ${f1(-hw * .86)} ${f1(hy + h * .2)}Z`;
    // the roll: a darker underside and a light crest give the front-right sweep its lift
    const roll = `<path d="M${f1(hw * .55)} ${f1(hy + h * .1)}Q${f1(hw * .92)} ${f1(hy + h * .14)} ${f1(hw * .95)} ${f1(hy + h * .3)}" stroke="#8d949d" stroke-width="3.5" fill="none" stroke-linecap="round" opacity=".55"/>`
     + `<path d="M${f1(part + 10)} ${f1(hy + h * .04)}Q${f1(hw * .6)} ${f1(hy + h * .01)} ${f1(hw * .88)} ${f1(hy + h * .16)}" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>`;
    let strands = "";
    for (let i = 0; i < 4; i++) strands += `<path d="M${f1(part + 4 + i * 11)} ${f1(hy + 3 + i * 1.5)}Q${f1(part + 22 + i * 13)} ${f1(hy + 4 + i * 2.5)} ${f1(hw * (.55 + i * .1))} ${f1(hy + h * (.09 + i * .025))}" stroke="${i % 2 ? "#a5acb4" : "#ffffff"}" stroke-width="1.1" fill="none" opacity=".5" stroke-linecap="round"/>`;
    strands += `<path d="M${f1(part - 3)} ${f1(hy + 3)}Q${f1(part - hw * .3)} ${f1(hy + h * .05)} ${f1(-hw * .72)} ${f1(hy + h * .15)}" stroke="#a5acb4" stroke-width="1" fill="none" opacity=".5" stroke-linecap="round"/>`;
    // shading under the hairline blends the hair into the forehead
    b.body = body + `<path d="M${f1(-hw * .86)} ${f1(hy + h * .225)}Q${f1(-hw * .45)} ${f1(hy + h * .11)} ${f1(part)} ${f1(hy + h * .12)}Q${f1(hw * .55)} ${f1(hy + h * .1)} ${f1(hw * .86)} ${f1(hy + h * .215)}" stroke="#8a7a62" stroke-width="6" fill="none" opacity=".14" stroke-linecap="round"/>`
     + `<path d="${wave}" fill="url(#hr${ctx.uid})" stroke="#9aa1aa" stroke-width="1.2" stroke-linejoin="round"/>${roll}${strands}<path d="M${f1(part)} ${f1(hy - 2)}L${f1(part + 1)} ${f1(hy + h * .1)}" stroke="#7d848d" stroke-width="1.3" stroke-linecap="round" opacity=".7"/>`;
    return b;
   },
   // the moustache sits between the nose line and the mouth, lifts when he talks and turns with his head
   over(R, ctx, F) {
    const q = ctx.proj(R.mx * F.mw * .4, F.mY - 9), x = F.cx + q.x, y = F.cy + q.y - R.mo * 5 - Math.max(0, R.mc) * 1.5, w = F.mw * .95 * q.s, c = 1 + .25 * R.mc;
    return `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${f1(R.mt * 20)})"><path d="M0 -2C${f1(-w * .25)} -7 ${f1(-w * .75)} -6 ${f1(-w)} ${f1(-1 * c)}C${f1(-w * 1.12)} ${f1(2 - 3 * c)} ${f1(-w * 1.22)} -5 ${f1(-w * 1.05)} -6C${f1(-w * 1.18)} 2 ${f1(-w * .7)} 5 ${f1(-w * .3)} 3C${f1(-w * .12)} 2.5 0 2 0 1.5C0 2 ${f1(w * .12)} 2.5 ${f1(w * .3)} 3C${f1(w * .7)} 5 ${f1(w * 1.18)} 2 ${f1(w * 1.05)} -6C${f1(w * 1.22)} -5 ${f1(w * 1.12)} ${f1(2 - 3 * c)} ${f1(w)} ${f1(-1 * c)}C${f1(w * .75)} -6 ${f1(w * .25)} -7 0 -2Z" fill="#e9ebee" stroke="#8d939b" stroke-width="1.3" stroke-linejoin="round"/><path d="M${f1(-w * .7)} -2q${f1(w * .3)} 2 ${f1(w * .55)} 1M${f1(w * .7)} -2q${f1(-w * .3)} 2 ${f1(-w * .55)} 1" stroke="#a9b0b8" stroke-width=".9" fill="none"/></g>`;
   },
   fidget: {dur: 1500, fn: (t, a) => ({d: {pitch: -.08 * bell(t, 0, 1), sy: .015 * bell(t, 0, 1), bas: 1 * bell(t, .2, .9), bo: .4 * bell(t, .2, .9), mx: .15 * bell(t, .2, .9)}})},
   pocketState(uid, s) { const t = ROPES.get(uid); if (t) t.mono.state = s === "pocket" ? "rest" : s; },
   // Alfred's two real objects. The watch chain (an albert) runs from a waistcoat buttonhole into the watch pocket and
   // only ever connects to the watch. The monocle has its own thin cord from his lapel; at rest it hangs against the
   // waistcoat at chest height. Both are ropes. The monocle's lens is 1.1 × his eye's width, one size in every frame.
   attach(c) {
    const B = c.B, hw = B.hw, h = B.h, sh = c.R.yaw * hw * .3, dt = Math.min(c.dt || 0, 1 / 30);
    const lapel = [sh + 22, -h * .4], button = [sh + 3, -h * .3], pocket = [sh + hw * .58, -h * .35], chest = -h * .2;
    let T = ROPES.get(c.uid);
    if (!T) { T = {mono: Object.assign(makeRope(lapel, h * .34), {state: "rest"}), watch: Object.assign(makeRope(button, h * .4), {state: "pocket", open: 0})}; ROPES.set(c.uid, T);
     for (let i = 0; i < 40; i++) { stepRope(T.watch, button, pocket, .1, -2); stepRope(T.mono, lapel, [sh + 20, -h * .19 - (c.eyes && c.eyes[1] ? c.eyes[1].W * .55 : 12)], .1); } }
    const M = T.mono, W = T.watch, eyeR = c.eyes && c.eyes[1], hand = c.hands.R;
    const r = eyeR ? eyeR.W * .55 : 12, now = c.now; M.r = r;
    const act = c.acts.find((a) => /^(monocleOut|monocleDrop|pocketWatch)$/.test(a.name));
    // where the monocle rests: hooked over the waistcoat front at chest height, below the lapel
    const rest = [sh + 20, -h * .19];
    M.restPt = rest; M.eye = eyeR ? [eyeR.cx, eyeR.cy] : null;
    const pinchAt = hand ? (() => { const a2 = (hand.r || 0) * PI / 180, s2 = hand.s || 1, px = -1.7 * s2, py = -14.5 * s2; return [hand.x + px * Math.cos(a2) - py * Math.sin(a2), hand.y + px * Math.sin(a2) + py * Math.cos(a2)]; })() : null;
    const held = pinchAt ? [pinchAt[0] - r * .55, pinchAt[1] - r * .55] : rest, eye = eyeR ? [eyeR.cx, eyeR.cy] : rest;
    const mix = (p, q, u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
    // the monocle's position is authored against the clip's clock: picked up, carried by the pinch, seated, dropped
    let want, f;
    if (act && act.name === "monocleOut") {
     const t = act.t, u1 = ease(ramp(t, .08, .2)), u2 = ease(ramp(t, .62, .7));
     want = t < .62 ? mix(rest, held, u1) : mix(held, eye, u2); f = .6 + .3 * u1 + .1 * u2;
     M.state = t >= .68 ? "seated" : "held";
    } else if (act && act.name === "monocleDrop" && M.state !== "rest") {
     // it falls from the eye on an outward arc as the cord takes it, then settles with a small damped swing
     const t = act.t, u = ease(ramp(t, 0, .55)), c1 = [eye[0] + 22, (eye[1] + rest[1]) / 2], sw = t > .55 ? (t - .55) * 2.4 : 0;
     want = [(1 - u) * (1 - u) * eye[0] + 2 * u * (1 - u) * c1[0] + u * u * rest[0] + 6 * Math.exp(-4 * sw) * Math.sin(sw * TAU * 1.8), (1 - u) * (1 - u) * eye[1] + 2 * u * (1 - u) * c1[1] + u * u * rest[1]];
     f = 1 - .4 * u; M.state = t > .97 ? "rest" : "drop";
    } else {
     if (M.state === "held" || M.state === "drop") M.state = "rest";
     want = M.state === "seated" ? eye : rest; f = M.state === "seated" ? 1 : .6;
    }
    // authored, it follows exactly; only a clip cut short eases it back so nothing pops
    if (!M.m) M.m = {x: want[0], y: want[1], f};
    const k = act ? 1 : Math.min(1, dt * 12);
    M.m.x += (want[0] - M.m.x) * k; M.m.y += (want[1] - M.m.y) * k; M.m.f += (f - M.m.f) * k;
    let floor = 1e9, mEnd = null;
    // let go, it falls and swings freely on its cord (a pendulum from the lapel) until it settles, then is tucked back
    // the cord is verlet between two authored ends: the lapel and the rim point facing it
    { const dx = lapel[0] - M.m.x, dy = lapel[1] - M.m.y, d = Math.hypot(dx, dy) || 1; mEnd = [M.m.x + dx / d * r * M.m.f, M.m.y + dy / d * r]; }
    { const reach = Math.hypot(mEnd[0] - lapel[0], mEnd[1] - lapel[1]), want = Math.max(h * .2, reach * 1.05) / (M.pts.length - 1); M.seg = want > M.seg ? want : M.seg + (want - M.seg) * Math.min(1, dt * 3); }
    let e = c.reduced ? 0 : stepRope(M, lapel, mEnd, dt, floor);
    // the watch is authored against the clip: it rises out of the slit in the palm, opens, closes and goes back in
    const wa = act && act.name === "pocketWatch" ? act.t : -1;
    W.open = wa < 0 ? 0 : ease(ramp(wa, .4, .52)) * (1 - ease(ramp(wa, .72, .8)));
    // it always exists: at rest its crown peeks out of the pocket; the hand takes it there and puts it back there
    const peek = [pocket[0], pocket[1] - 4], wu = wa < 0 || !hand ? 0 : ease(ramp(wa, .08, .14)) * (1 - ease(ramp(wa, .86, .92)));
    W.k = .8; W.state = wu > .5 ? "held" : "pocket";
    const wT = hand && wu > 0 ? [hand.x, hand.y - 6 * (hand.s || 1)] : peek;
    W.m = {x: peek[0] + (wT[0] - peek[0]) * wu, y: peek[1] + (wT[1] - peek[1]) * wu};
    e += c.reduced ? 0 : stepRope(W, button, [W.m.x, W.m.y], dt, -2);
    const line = (R, col, w) => { const d = smoothOpen(R.pts.map((p) => [p.x, p.y])); return `<path d="${d}" stroke="${col}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`; };
    let s = line(W, "#a86f2a", 2.2) + `<path d="${smoothOpen(W.pts.map((p) => [p.x, p.y]))}" stroke="#E8A75A" stroke-width="1.3" fill="none" stroke-dasharray="2 1.5"/>`;
    s += `<circle cx="${f1(button[0])}" cy="${f1(button[1])}" r="2.2" fill="#E8A75A"/><path d="M${f1(pocket[0] - 8)} ${f1(pocket[1] + 2)}h16" stroke="#15122a" stroke-width="2.4" stroke-linecap="round"/><path d="M${f1(pocket[0] - 8)} ${f1(pocket[1] + 4)}h16" stroke="#fff" stroke-opacity=".18" stroke-width="1" stroke-linecap="round"/>`;
    s += line(M, "#4a4460", 2.4) + line(M, "#e4dff0", 1.1) + `<circle cx="${f1(lapel[0])}" cy="${f1(lapel[1])}" r="1.8" fill="#E8A75A"/>`;
    // the monocle: a thin gold rim round a faint lens, the same size whether hanging, held or worn
    const tip = M.pts[M.pts.length - 1], prev = M.pts[M.pts.length - 2];
    const mx = M.m.x, my = M.m.y, rx = r * M.m.f;
    s += `<g data-l="monocle" data-r="${f1(r)}" data-mx="${f1(mx)}" data-my="${f1(my)}" data-st="${M.state}"><ellipse cx="${f1(mx)}" cy="${f1(my)}" rx="${f1(rx)}" ry="${f1(r)}" fill="#fff" fill-opacity=".12" stroke="#5d5872" stroke-width="2.8"/><ellipse cx="${f1(mx)}" cy="${f1(my)}" rx="${f1(rx)}" ry="${f1(r)}" fill="none" stroke="#e9e6f2" stroke-width="1.3"/><path d="M${f1(mx - rx * .5)} ${f1(my - r * .45)}q${f1(rx * .25)} ${f1(-r * .25)} ${f1(rx * .55)} ${f1(-r * .3)}" stroke="#fff" stroke-width="1.4" fill="none" opacity=".75" stroke-linecap="round"/></g>`;
    // the watch, when out
    let top = ""; // the watch in his palm is drawn over the hand, face up
    // it comes out of the pocket and goes back in growing and shrinking at the slit, never popping
    const wd = Math.hypot(W.m.x - pocket[0], W.m.y - pocket[1]);
    if (W.k > .02) { const w = W.m, o = W.open, k = W.k; let wsvg = `<g transform="translate(${f1(w.x)} ${f1(w.y + 8)}) scale(${f1(k * 100) / 100})"><circle r="10" fill="#E8A75A" stroke="#a86f2a" stroke-width="1.8"/><circle r="7.4" fill="#fbf7ee" opacity="${f1(o)}"/><path d="M0 0v-5M0 0l3.4 1.8" stroke="#2a243b" stroke-width="1.3" stroke-linecap="round" opacity="${f1(o)}"/><g transform="translate(0 -10) scale(1 ${f1(1 - 1.9 * o)}) translate(0 10)"><circle r="10" fill="#E8A75A" stroke="#a86f2a" stroke-width="1.8"/><circle r="5.5" fill="none" stroke="#c98837" stroke-width="1.1"/></g><rect x="-2.3" y="-13.5" width="4.6" height="3.6" rx="1.4" fill="#a86f2a"/></g>`.replace("<g transform", `<g data-l="watch" data-mx="${f1(w.x)}" data-my="${f1(w.y)}" transform`); // going back, it slips in under the pocket's edge; in his hand it sits on top of the fingers
     // near the pocket only the part above the slit shows, so it rises out of the pocket and sinks back in
     if (W.m.y > pocket[1] - 14) s += `<clipPath id="wc${c.uid}"><rect x="${f1(pocket[0] - 40)}" y="-400" width="80" height="${f1(400 + pocket[1] + 2)}"/></clipPath><g clip-path="url(#wc${c.uid})">${wsvg}</g><path d="M${f1(pocket[0] - 8)} ${f1(pocket[1] + 2)}h16" stroke="#15122a" stroke-width="2.4" stroke-linecap="round"/>`; else top += wsvg; }
    return {svg: s, top, moving: e > .05 || !!act || Math.hypot(want[0] - M.m.x, want[1] - M.m.y) > .3};
   },
  };
 }

 // Mark (the original Loom, back): the Tessaya mark itself, nine woven bars and no face. The arrangement is the
 // expression: the bars bloom when she is pleased, huddle when sad, spread when surprised, lie down when sleepy,
 // circle like a shuttle while she thinks and pulse with her voice. Each bar is a small extruded, lit solid.
 {
  const MARK = "M96.18 36.22L143.41 83.45L128.71 98.16L81.47 50.93ZM172.55 112.59L219.78 159.82L205.07 174.53L157.84 127.29ZM82.04 112.59L143.41 173.96L128.71 188.67L67.33 127.29ZM130.12 20.66L144.83 35.37L127.29 52.91L112.59 38.20ZM83.45 67.33L98.16 82.04L35.37 144.83L20.66 130.12ZM175.38 65.92L190.08 80.62L127.29 143.41L112.59 128.71ZM83.45 157.84L98.16 172.55L80.62 190.08L65.92 175.38ZM220.63 111.17L235.34 125.88L217.80 143.41L203.09 128.71ZM173.96 157.84L188.67 172.55L125.88 235.34L111.17 220.63Z";
  const BARS = MARK.split("Z").filter(Boolean).map((s) => {
   const n = s.match(/-?[\d.]+/g).map(Number), P = [0, 2, 4, 6].map((i) => [n[i], n[i + 1]]), d = (a, q) => Math.hypot(q[0] - a[0], q[1] - a[1]);
   const long = d(P[0], P[1]) > d(P[1], P[2]) ? [P[0], P[1]] : [P[1], P[2]], cx = P.reduce((a, q) => a + q[0], 0) / 4, cy = P.reduce((a, q) => a + q[1], 0) / 4, sc = .72;
   return {x: (cx - 128) * sc, y: (cy - 128) * sc, a: Math.atan2(long[1][1] - long[0][1], long[1][0] - long[0][0]) * 180 / PI, l: Math.max(d(P[0], P[1]), d(P[1], P[2])) * sc, w: Math.min(d(P[0], P[1]), d(P[1], P[2])) * sc};
  });
  const cur = BARS.map((m) => ({...m}));
  const H = 172;
  C.mark = {id: "mark", name: "Mark", idea: "The original Loom: the Tessaya mark itself, nine woven bars and no face. The bars bloom, huddle, spread, lie down to sleep, circle while she thinks and pulse with her voice.",
   pal: Object.assign({}, common, {base: "#1F7A82", light: "#7cc9c6", dark: "#0b3f45", rim: "#c9f1ec", eye: "#0b3f45", edge: "#0b3f45", zzz: "#7d8a99"}),
   palette(R) { const c = R.flush > .25 ? "#B5404B" : R.gloom > .2 ? "#3E5C93" : (R.glow > .3 || R.star > .4) ? "#C8862E" : "#1F7A82"; return Object.assign({}, this.pal, {base: c, light: mixHex(c, "#ffffff", .5), dark: mixHex(c, "#000000", .55), edge: mixHex(c, "#000000", .6)}); },
   noFace: true, noHands: true,
   face: {R: 90, curv: .9, y: 0, ex: 30, eyY: -10, ew: 24, eh: 36, mY: 26, mw: 26, bg: 9},
   body(R, ctx) {
    const h = H * R.sy, cy = -h / 2, pal = ctx.pal, t = ctx.t, ex = ctx.expr || "neutral";
    const happy = clamp(Math.max(R.mc - .4, 0) * 1.6 + R.arc * .5 + R.star * .6 + R.chev * .4, 0, 1), sad = clamp(-R.mc * 1.2 + R.gloom, 0, 1);
    const surprise = clamp(R.mo * R.mr * 1.6, 0, 1), sleep = clamp(Math.max(R.sarc, (R.lu - .35) / .4), 0, 1), think = (ex === "thinking" || ex === "searching") ? 1 : 0;
    const spread = (1 + .16 * happy + .28 * surprise - .12 * sad) * R.sx, speak = clamp(R.mo, 0, 1.2) * (1 - surprise);
    let out = "";
    BARS.forEach((m, i) => {
     let x = m.x * spread, y = m.y * spread + 10 * sad, a = m.a, l = m.l;
     if (sleep > 0) { x = lerp(x, (i % 2 ? 7 : -7), sleep); y = lerp(y, (i - 4) * 9 + 18, sleep); a = lerp(a, 0, sleep); l = lerp(l, 30 + (i % 3) * 12, sleep); }
     if (think) { const th = i / 9 * TAU + t * 1.2; x = Math.cos(th) * 50; y = Math.sin(th) * 50; a = th * 180 / PI; l = 24; }
     l *= 1 + speak * .45 * Math.max(0, Math.sin(t * 9 - i * .8));
     x += R.gx * 5 + R.yaw * 14 * (m.y / 60); y += R.gy * 4;
     const c = cur[i]; c.x = x; c.y = y; c.a = a; c.l = l;
     // a small extruded bar: the side face first, then the lit top with a highlight along its upper edge
     const w = m.w, rot = `translate(${f1(x)} ${f1(cy + y * R.sy)}) rotate(${f1(a)})`;
     out += `<g transform="${rot}"><rect x="${f1(-l / 2 + 1.5)}" y="${f1(-w / 2 + 3)}" width="${f1(l)}" height="${f1(w)}" rx="3.5" fill="${pal.dark}"/><rect x="${f1(-l / 2)}" y="${f1(-w / 2)}" width="${f1(l)}" height="${f1(w)}" rx="3.5" fill="url(#mk${ctx.uid})" stroke="${pal.edge}" stroke-width="1" stroke-opacity=".5"/><rect x="${f1(-l / 2 + 3)}" y="${f1(-w / 2 + 1.5)}" width="${f1(Math.max(0, l - 6))}" height="2.2" rx="1.1" fill="#fff" opacity=".45"/></g>`;
    });
    return {d: "M0 0Z", h, hw: 92 * R.sx, top: -h, cy, front: out};
   },
   defs: (uid, p) => `<linearGradient id="mk${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.light}"/><stop offset="1" stop-color="${p.base}"/></linearGradient>`,
   fidget: {dur: 1300, fn: (t, a) => ({d: {sx: .05 * a * Math.sin(t * TAU * 2) * bell(t, 0, 1), tilt: 6 * Math.sin(t * TAU) * bell(t, 0, 1)}})},
  };
 }

 // Limbs, designed per body. shoulderY: shoulder height as a fraction of body height from the ground, on the
 // silhouette edge. armLen: arm length as a fraction of height. reach: zones the hand can reach; a gesture aimed
 // elsewhere uses the substitute pose (a small hand at the upper chest, with a lean). limb "float": floating hands.
 const LIMBS = {
  pebble:   {shape: "wide, low stone; symmetric", limb: "float", hand: 1, note: "Too wide and low for arms to reach its face: floating hands, like Taby."},
  thread:   {shape: "tall egg; asymmetric (thread end on the left)", limb: "arms", shoulderY: .42, armLen: .4, thick: 1, hand: .95, reach: ["chest", "face", "head"], note: "Tall egg with room at the sides: full arms from the widest part, long enough to reach its chin."},
  loom:     {shape: "wide box cushion; symmetric", limb: "stub", shoulderY: .45, armLen: .26, thick: 1.15, hand: .9, reach: ["chest"], note: "A wide box: short stub arms at the sides; face gestures become a small raised hand and a lean. Two-handed objects are held with floating hands, since stubs cannot reach round them."},
  drop:     {shape: "teardrop, narrow top; symmetric", limb: "arms", shoulderY: .3, armLen: .38, thick: .95, hand: .9, reach: ["chest", "face"], note: "Arms come from the wide lower body, where a drop has shoulders; it can reach its chin but not above its head."},
  selvedge: {shape: "low loaf; symmetric", limb: "float", hand: 1, note: "A low loaf: arms out of its sides would read as tubes, so it uses floating hands."},
  spool:    {shape: "tall cylinder between flanges; asymmetric (loose end on the right)", limb: "arms", shoulderY: .36, armLen: .4, thick: 1, hand: .92, reach: ["chest", "face", "head"], note: "A tall cylinder: arms from the thread just under the top flange; reaches its face easily."},
  shuttle:  {shape: "very wide, flat boat; asymmetric (trailing thread)", limb: "float", hand: 1, note: "Long and flat: floating hands, so nothing has to stretch across its length."},
  felt:     {shape: "round ball with ears; symmetric", limb: "stub", shoulderY: .44, armLen: .27, thick: 1.2, hand: .88, reach: ["chest"], note: "A round ball: short stub arms; for face gestures it leans and lifts a small hand instead of stretching. Two-handed objects are held with floating hands, since stubs cannot reach round them."},
  swatch:   {shape: "flat square of cloth; asymmetric (curled corner)", limb: "float", hand: 1, note: "A flat cloth square has no shoulders: floating hands."},
  thimble:  {shape: "tall dome; symmetric", limb: "arms", shoulderY: .4, armLen: .4, thick: 1, hand: .92, reach: ["chest", "face", "head"], note: "A tall dome: full arms from the middle of its side, long enough for its chin and brow."},
  purl:     {shape: "round ball with needles; symmetric", limb: "stub", shoulderY: .44, armLen: .27, thick: 1.2, hand: .88, reach: ["chest"], note: "A round ball of yarn: stub arms; face gestures become a lean and a small hand. Two-handed objects are held with floating hands, since stubs cannot reach round them."},
  tweed:    {shape: "tall egg in a waistcoat; asymmetric (watch pocket on the right)", limb: "arms", shoulderY: .37, armLen: .4, thick: 1, elbowOut: .1, hand: .9, reach: ["chest", "face", "head"], note: "A tall gentleman: full arms from the shoulders of his waistcoat, composed reach to his chin, brow and pocket."},
  mark:     {shape: "the logo mark, no body outline", limb: "none", hand: 1.15, note: "The mark has no hands; anything it holds floats beside it."},
 };
 for (const id in LIMBS) if (C[id]) C[id].limbs = LIMBS[id];

 // persona → character, personality, voice style (the owner can change every one)
 TCS.PERSONAS = {
  tessaya: {name: "Tessaya", role: "The lead. Calm, direct, brief.", character: "selvedge", traits: {energy: .5, warmth: .6, play: .4, expr: .55, formal: .5, sass: .3}, guilt: 1},
  freya: {name: "Freya", role: "Warm, quick, practical.", character: "felt", traits: {energy: .78, warmth: .9, play: .7, expr: .85, formal: .2, sass: .35}, guilt: 2},
  alfred: {name: "Alfred", role: "Refined, warm, dry wit, unflappable.", character: "tweed", traits: {energy: .3, warmth: .75, play: .2, expr: .4, formal: .92, sass: .55}, guilt: 1},
  sebastian: {name: "Sebastian", role: "Sceptical and thorough.", character: "spool", traits: {energy: .45, warmth: .4, play: .35, expr: .55, formal: .55, sass: .8}, guilt: 1},
  custom: {name: "Your own", role: "Anyone you make: pick a body, set the dials.", character: "purl", traits: {energy: .6, warmth: .7, play: .6, expr: .7, formal: .3, sass: .5}, guilt: 1},
 };
})(window);
