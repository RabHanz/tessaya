/* Tessaya's characters: one rig for every body, persona and personality. Plain script, no build; exposes `TCS`.
 * Design: research/EMOTION-SYSTEM.md §5.3 and research/TABY-BREAKDOWN.md §9.
 *
 * A character is a shaded body (the silhouette is the character) with features that ride its surface in
 * perspective. An expression is a set of numbers; gestures are short additive clips; personality scales timing,
 * amplitude and habits. One requestAnimationFrame loop per rig, running only while something moves.
 */
(function (g) {
 "use strict";
 const TCS = g.TCS = g.TCS || {};
 const PI = Math.PI, TAU = PI * 2;
 const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
 const lerp = (a, b, t) => a + (b - a) * t;
 const f1 = (x) => Math.round(x * 10) / 10;
 const bell = (t, a, b) => t <= a || t >= b ? 0 : Math.sin(PI * (t - a) / (b - a));
 const ramp = (t, a, b) => t <= a ? 0 : t >= b ? 1 : (t - a) / (b - a);
 const ease = (x) => x * x * (3 - 2 * x);
 const hold = (t, a, b, c, d) => ease(ramp(t, a, b)) * (1 - ease(ramp(t, c, d)));
 function smoothClosed(p) {
  const n = p.length; let d = `M${f1(p[0][0])} ${f1(p[0][1])}`;
  for (let i = 0; i < n; i++) {
   const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
   d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d + "Z";
 }
 function smoothOpen(p) {
  let d = `M${f1(p[0][0])} ${f1(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
   const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
   d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
 }
 const poly = (p) => "M" + p.map((q) => f1(q[0]) + " " + f1(q[1])).join("L") + "Z";
 /** Superellipse body with its bottom on y=0; separate top and bottom exponents, a top taper and a bottom flare. */
 function blob(o, sx, sy, n = 64) {
  const pts = [];
  for (let i = 0; i < n; i++) {
   const t = i / n * TAU, c = Math.cos(t), s = Math.sin(t), top = s < 0, e = top ? o.nt : o.nb;
   let x = o.w / 2 * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), y = o.h / 2 * Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
   x *= top ? 1 - (o.taper || 0) * (-y / (o.h / 2)) : 1 + (o.flare || 0) * (y / (o.h / 2));
   pts.push([x * sx, (y - o.h / 2) * sy]);
  }
  return pts;
 }
 /** Resample a closed polygon evenly and zigzag it (pinking shears) where `where(x,y)` is true. */
 function pink(p, step, depth, where) {
  const L = [], n = p.length; let tot = 0;
  for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); L.push(l); tot += l; }
  const m = Math.max(8, Math.round(tot / step)), out = []; let seg = 0, acc = 0;
  for (let k = 0; k < m; k++) {
   const want = k / m * tot; while (acc + L[seg] < want) { acc += L[seg]; seg = (seg + 1) % n; }
   const a = p[seg], b = p[(seg + 1) % n], t = (want - acc) / (L[seg] || 1), x = lerp(a[0], b[0], t), y = lerp(a[1], b[1], t);
   const nx = (b[1] - a[1]) / (L[seg] || 1), ny = -(b[0] - a[0]) / (L[seg] || 1), z = (k % 2 ? 1 : -1) * depth * (where(x, y) ? 1 : 0);
   out.push([x + nx * z, y + ny * z]);
  }
  return out;
 }
 /** Points on a sphere-ish surface turned by yaw and pitch: position, horizontal and vertical foreshortening. */
 function projector(R, curv, yaw, pitch) {
  return (x, y) => {
   const a = Math.asin(clamp(x / R * curv, -.97, .97)), b = Math.asin(clamp(y / R * curv, -.97, .97));
   const a2 = clamp(a + yaw * .62, -1.35, 1.35), b2 = clamp(b + pitch * .42, -1.3, 1.3);
   return {x: Math.sin(a2) / curv * R, y: Math.sin(b2) / curv * R, s: Math.max(.22, Math.cos(a2) / Math.cos(a)), t: Math.max(.35, Math.cos(b2) / Math.cos(b))};
  };
 }
 function hex(c) { const n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
 function mixHex(a, b, t) { const A = hex(a), B = hex(b); return "#" + A.map((v, i) => Math.round(lerp(v, B[i], t)).toString(16).padStart(2, "0")).join(""); }
 TCS.util = {clamp, lerp, f1, bell, ramp, ease, hold, smoothClosed, smoothOpen, poly, blob, pink, projector, mixHex};

 // ── The rig's numbers ──────────────────────────────────────────────────────────────────────────────────────────
 const N = {
  // body (springs): squash, lift (− is up), lean about the ground, tilt about the centre, head turn, nod, zoom, appendage perk
  sx: 1, sy: 1, lift: 0, lean: 0, tilt: 0, yaw: 0, pitch: 0, zoom: 1, app: 0,
  // body tint: anger flush, a cold gloom, a warm glow behind
  flush: 0, gloom: 0, glow: 0,
  // eyes: size, spacing, height, gaze; upper lid close and slant (+ inner down = cross, − outer down = sad); lower lid push
  ew: 1, eh: 1, gap: 1, ey: 0, gx: 0, gy: 0, lu: 0, la: 0, ll: .12,
  // eye styles, crossfaded: happy arcs, sleeping arcs, squeezed > <, stars, hearts, spirals, loading dots, wink, one eye bigger
  arc: 0, sarc: 0, chev: 0, star: 0, heart: 0, spiral: 0, dots: 0, wink: 0, big: 0, wet: 0, tear: 0,
  // brows: opacity, height (− up), slant (+ cross, − worried), curve, right brow raised
  bo: 0, by: 0, ba: 0, bc: .2, bas: 0,
  // mouth: width, smile (− frown), open, round, sideways, tilt, wobble, teeth, tongue, one cheek puffed
  mw: .82, mc: .42, mo: 0, mr: 0, mx: 0, mt: 0, mwob: 0, teeth: 0, tongue: 0, puff: 0,
  // cheeks and blush
  cheek: .3, blush: 0,
 };
 const KEYS = Object.keys(N);
 const SPRING = new Set(["sx", "sy", "lift", "lean", "tilt", "yaw", "pitch", "zoom", "app"]);
 // A change of expression is a timed move of about a second, moving on every frame, slow in and slow out (the motion
 // bar: the reference's changes run 0.85 to 1.5 s and never snap). Every value travels on a smootherstep from wherever it
 // is, in overlapping waves: posture, brows and tints first, the eyes 120 ms later, the mouth 220 ms later, each over
 // 800 ms (a calm personality takes a little longer); the "shift" clip adds the anticipation and the stretch of the move.
 const TWEEN_MS = 800;
 const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);
 const LAG = Object.fromEntries(Object.keys(N).map((k) => [k, /^(ew|eh|gap|ey|gx|gy|lu|la|ll|arc|sarc|chev|star|heart|spiral|dots|wink|big|wet|tear)$/.test(k) ? 120 : /^(mw|mc|mo|mr|mx|mt|mwob|teeth|tongue|puff|cheek|blush)$/.test(k) ? 220 : 0]));
 // how a mood sits: up and open (joy) or down and closed (sadness); a change moves her body by the difference
 const VALENCE = {Joy: 1, Love: .9, Surprise: .8, Curious: .4, Angry: .3, Calm: 0, Sulky: -.6, Sad: -1, Sleepy: -.8};
 const STYLE = new Set(["arc", "sarc", "chev", "star", "heart", "spiral", "dots", "wink"]);
 TCS.NEUTRAL = N;

 // ── Expressions: a look (numbers), optional default hands, a continuous loop and an ambient effect ─────────────
 // Hands: {L,R}: [spot, pose]. Loops run throttled and only while the expression is shown.
 const E = TCS.EXPRESSIONS = {
  neutral:    {g: "Calm", label: "Neutral", look: {}, note: "Pleasant and attentive: open eyes, a soft smile"},
  attentive:  {g: "Calm", label: "Attentive", look: {eh: 1.08, ew: 1.04, bo: .5, by: -4, bc: .3, mc: .5, mw: .7, zoom: 1.03, lift: -3, ll: .05}},
  calm:       {g: "Calm", label: "Calm", look: {lu: .22, ll: .2, mc: .5, mw: .78, cheek: .4}},
  unimpressed:{g: "Calm", label: "Unimpressed", look: {lu: .45, ll: .05, mc: 0, mw: .7, cheek: 0, gx: .1}, note: "The old flat line, kept as its own face"},
  bored:      {g: "Calm", label: "Bored", look: {lu: .42, mc: -.05, mw: .45, mx: .32, puff: .7, gy: -.3, gx: .45, lift: 3, sy: .98, cheek: .1}},
  happy:      {g: "Joy", label: "Happy", look: {ew: 1.06, eh: .9, ll: .74, mc: .85, mw: .74, mo: .1, tongue: .25, cheek: 1, blush: .15, sx: 1.015, sy: .985, lift: -3, tilt: -2, app: .6, bo: .45, by: -1, bc: .55, ba: -.05, glow: .15}, note: "Soft smiling eyes, a smaller warm smile, lifted cheeks, relaxed brows"},
  delighted:  {g: "Joy", label: "Delighted", look: {star: 1, mo: .7, mc: 1, mw: 1, tongue: .8, cheek: 1, lift: -8, zoom: 1.04, app: 1, glow: .7, bo: .6, by: -8}, fx: "sparkle"},
  laughing:   {g: "Joy", label: "Laughing", look: {arc: 1, mo: .85, mc: 1, mw: 1.05, tongue: 1, cheek: 1, lift: -4, sx: 1.04, sy: .96, app: .8, bo: .5, by: -5}, loop: "laugh"},
  giggle:     {g: "Joy", label: "Giggle", look: {arc: 1, mo: .15, mc: .9, mw: .6, cheek: 1, blush: .5, tilt: -5}, hands: {L: ["mouth", "back"]}, loop: "giggle"},
  excited:    {g: "Joy", label: "Excited", look: {chev: 1, mo: .6, mc: 1, mw: 1, tongue: .6, cheek: .8, lift: -6, app: 1, glow: .4}, hands: {L: ["chest", "fist"], R: ["chest", "fist"]}, loop: "bounce"},
  proud:      {g: "Joy", label: "Proud", look: {arc: .9, mc: .85, mw: .85, mx: .1, cheek: .7, pitch: -.32, lift: -5, sy: 1.03, app: .7, bo: .6, by: -3, glow: .3}, hands: {L: ["hips", "fist"], R: ["hips", "fist"]}},
  smug:       {g: "Joy", label: "Smug", look: {lu: .4, ll: .3, la: -.1, mc: .55, mw: .62, mx: .3, mt: -.15, bo: .9, bas: 1, by: -2, pitch: -.15, tilt: -4, cheek: .4}},
  relieved:   {g: "Joy", label: "Relieved", look: {sarc: .9, mo: .25, mr: .7, mc: .5, cheek: .5, lift: 4, sy: .97, bo: .6, ba: -.2}, fx: "puff"},
  playful:    {g: "Love", label: "Playful", look: {wink: 1, mc: .8, mw: .8, mx: .15, mo: .25, tongue: 1, cheek: .7, tilt: -7, app: .7, bo: .7, bas: .8}},
  wink:       {g: "Love", label: "Wink", look: {wink: 1, ll: .4, mc: .9, mw: .8, mx: .1, cheek: .7, tilt: -5, lift: -2, bo: .5, bas: .6}},
  shy:        {g: "Love", label: "Shy", look: {ll: .55, gx: -.5, gy: .55, blush: 1, mc: .45, mw: .45, tilt: 7, lift: 3, sy: .98, yaw: -.25, app: -.3}, hands: {L: ["clasp", "fist"], R: ["clasp", "fist"]}},
  love:       {g: "Love", label: "Love (rare)", look: {heart: 1, mc: 1, mw: .9, mo: .2, cheek: 1, blush: .6, glow: .6, lift: -5, app: .8}, fx: "hearts"},
  embarrassed:{g: "Love", label: "Embarrassed", look: {chev: .9, mc: .3, mw: .7, mwob: .6, blush: 1, tilt: 6, lift: 2, sy: .97, bo: .8, ba: -.4}, hands: {R: ["head", "back"]}, fx: "sweat"},
  curious:    {g: "Curious", label: "Curious", look: {big: .16, eh: 1.08, gx: .35, gy: -.2, tilt: -9, mc: .3, mw: .55, mr: .3, mo: .08, bo: .9, bas: 1, by: -4, lean: -3, app: .5}},
  thinking:   {g: "Curious", label: "Thinking (new)", look: {gx: -.55, gy: -.6, mw: .45, mc: .05, mr: .4, mx: .3, bo: .85, bas: .9, tilt: 5, yaw: -.18}, hands: {R: ["chin", "point"]}, loop: "think", note: "A glance up and aside, a finger at the chin, a slow tilt and a mouth pushed to one side"},
  searching:  {g: "Curious", label: "Searching / loading", look: {dots: 1, gy: -.15, mw: .45, mc: .1, bo: .4}, loop: "orbit", note: "The old orbiting-dots thinking, now for loading and searching"},
  focused:    {g: "Curious", label: "Focused", look: {lu: .26, ll: .2, la: .12, gy: .12, mw: .55, mc: .12, bo: .75, by: 4, ba: .25, pitch: .08}},
  determined: {g: "Curious", label: "Determined", look: {lu: .2, ll: .14, la: .3, mw: .8, mc: .2, mx: .1, bo: 1, by: 5, ba: .45, lean: -2, sy: 1.02, app: .4}, hands: {R: ["fistlow", "fist"]}},
  skeptical:  {g: "Curious", label: "Sceptical", look: {lu: .3, ll: .1, big: -.12, mc: -.05, mw: .55, mx: -.25, mt: .12, bo: 1, bas: 1.2, ba: .15, tilt: 5, yaw: .12}},
  confused:   {g: "Curious", label: "Confused", look: {big: .22, gx: .1, mc: -.1, mw: .55, mwob: 1, mx: .1, tilt: 8, bo: 1, bas: 1, ba: -.3, app: -.2}, fx: "question"},
  dizzy:      {g: "Curious", label: "Dizzy", look: {spiral: 1, mwob: 1, mc: 0, mw: .6, tilt: -6}, loop: "dizzy"},
  surprised:  {g: "Surprise", label: "Surprised", look: {ew: 1.1, eh: 1.18, ll: 0, mo: .8, mr: 1, mw: .45, lift: -7, zoom: 1.04, sy: 1.04, bo: 1, by: -12, app: 1}, fx: "exclaim"},
  amazed:     {g: "Surprise", label: "Amazed", look: {star: 1, mo: .9, mr: .8, mw: .55, lift: -6, zoom: 1.05, bo: 1, by: -12, glow: .5}, fx: "sparkle"},
  nervous:    {g: "Surprise", label: "Nervous", look: {ew: .92, eh: .95, gx: .4, mc: -.1, mw: .75, mwob: 1, teeth: .6, mo: .2, bo: .9, ba: -.5, lift: 2, sx: .98}, fx: "sweat", loop: "jitter"},
  concerned:  {g: "Sad", label: "Concerned", look: {la: -.25, eh: .96, gy: .12, mc: -.12, mw: .6, bo: 1, by: -3, ba: -.6, lift: 3, pitch: .1, sy: .985, app: -.4}, hands: {R: ["heart", "back"]}},
  worried:    {g: "Sad", label: "Worried", look: {la: -.35, ew: .96, eh: 1.04, gx: .25, mc: -.25, mw: .55, mwob: .6, bo: 1, by: -5, ba: -.8, lift: 2, app: -.5}, hands: {L: ["underChin", "fist"], R: ["underChin", "fist"]}, fx: "sweat"},
  sad:        {g: "Sad", label: "Sad", look: {la: -.62, lu: .12, gy: .45, mc: -.6, mw: .55, wet: .8, bo: 1, by: -2, ba: -.95, lift: 6, pitch: .28, sy: .96, sx: 1.02, app: -1, gloom: .5, cheek: .1}},
  hurt:       {g: "Sad", label: "Hurt", look: {la: -.5, eh: 1.1, ew: 1.05, ll: .02, wet: 1, tear: .9, mc: -.5, mw: .45, mwob: 1, mo: .1, bo: 1, by: -6, ba: -1, lift: 3, zoom: .97, app: -.8}, hands: {R: ["heart", "fist"]}, loop: "tremble"},
  crying:     {g: "Sad", label: "Crying", look: {sarc: 1, wet: 1, mo: .55, mc: -.7, mw: .7, mwob: .8, bo: 1, by: -4, ba: -1, lift: 5, sy: .96, app: -1, gloom: .3}, loop: "sob", fx: "tears"},
  lonely:     {g: "Sad", label: "Missed you", look: {la: -.4, gy: -.25, wet: .5, mc: .12, mw: .45, mwob: .3, bo: 1, by: -4, ba: -.7, pitch: -.12, lift: 2, app: -.6, cheek: .4}, hands: {L: ["hug", "back"], R: ["hug", "back"]}, note: "You were gone a while…"},
  sulky:      {g: "Sulky", label: "Sulky", look: {lu: .45, la: -.15, gx: .7, gy: .15, mw: .35, mc: -.35, mr: .4, mx: -.15, puff: 1, bo: 1, ba: .2, by: 2, yaw: .45, tilt: -4, pitch: .1, app: -.5, gloom: .25, blush: .3}, hands: {L: ["cross", "fist"], R: ["cross", "fist"]}, loop: "sulk"},
  putout:     {g: "Sulky", label: "Put out (a bit jealous)", look: {lu: .35, gx: -.85, mw: .4, mc: -.25, mx: .25, mt: .15, puff: .6, bo: 1, ba: .3, bas: -.5, yaw: -.2, tilt: 4, app: -.3}, fx: "puff"},
  pout:       {g: "Sulky", label: "Pout", look: {eh: 1.06, wet: .5, mw: .3, mc: -.3, mr: .7, mo: .05, puff: .4, bo: 1, ba: -.5, by: -2, pitch: .15, lift: 3, app: -.5}},
  annoyed:    {g: "Angry", label: "Annoyed", look: {lu: .38, la: .25, mc: -.18, mw: .62, mx: .2, bo: 1, ba: .5, by: 3, tilt: 3}, fx: "vein"},
  frustrated: {g: "Angry", label: "Frustrated", look: {lu: .32, la: .3, gy: .2, mc: -.22, mw: .6, mwob: .9, puff: .5, bo: 1, ba: .35, by: 3, bc: .1, flush: .18, pitch: .1, lift: 2, sy: .985}, hands: {R: ["temple", "back"]}, loop: "frustrate", fx: "scribble", note: "Fed up with the thing, not with you: a squiggle mouth, a hand to the temple, a sigh"},
  angry:      {g: "Angry", label: "Angry", look: {lu: .28, la: .75, ew: .95, mc: -.7, mw: .7, mo: .5, teeth: 1, bo: 1, ba: 1, by: 6, flush: .8, sx: 1.05, sy: .96, lean: -4, app: .8}, hands: {L: ["fistlow", "fist"], R: ["fistlow", "fist"]}, loop: "fume", fx: "steam"},
  grumpy:     {g: "Angry", label: "Grumpy", look: {lu: .4, la: .4, mc: -.45, mw: .6, mwob: .3, bo: 1, ba: .6, by: 5, pitch: .1, lift: 3, sy: .98, gloom: .2, flush: .15}},
  sleepy:     {g: "Sleepy", label: "Sleepy", look: {lu: .56, la: 0, ll: 0, eh: 1.04, gap: 1.03, gy: .1, mc: .18, mw: .42, mr: .9, mo: .16, bo: .55, by: 4, ba: -.05, bc: .1, pitch: .22, lift: 4, sy: .98, app: -.4, cheek: .35}, loop: "drowsy", note: "Heavy flat lids, slow breathing, nodding off, yawns. Brows stay level, so it never reads as sad"},
  asleep:     {g: "Sleepy", label: "Asleep", look: {sarc: 1, mc: .1, mw: .35, mr: 1, mo: .12, pitch: .3, lift: 6, sy: .96, sx: 1.03, app: -.7, cheek: .5}, loop: "breathe", fx: "zzz"},
 };
 TCS.GROUPS = ["Calm", "Joy", "Love", "Curious", "Surprise", "Sad", "Sulky", "Angry", "Sleepy"];

 // ── Personality ────────────────────────────────────────────────────────────────────────────────────────────────
 const TRAITS = TCS.TRAITS = {energy: "Energy", warmth: "Warmth", play: "Playfulness", expr: "Expressiveness", formal: "Formality", sass: "Sass"};
 function tune(T) {
  return {
   k: lerp(70, 240, T.energy),                                       // spring stiffness
   z: clamp(.92 * T.formal + .5 * (1 - T.formal) - .14 * T.play, .34, 1), // damping ratio: playful bounces, formal settles
   tau: lerp(.2, .085, T.energy),                                    // face approach time (s)
   amp: lerp(.55, 1.22, T.expr) * (1 - .22 * T.formal),              // expression amplitude
   gamp: lerp(.6, 1.3, T.expr) * (1 - .3 * T.formal),                // gesture amplitude
   gdur: lerp(1.25, .8, T.energy),                                   // gesture duration scale
   idle: lerp(22, 8, .6 * T.energy + .4 * T.play),                  // seconds between idle acts
   blink: lerp(5.5, 3, T.energy),
  };
 }
 /** Personality leans on the resting face too: warmth smiles and blushes, sass smirks, formality settles. */
 function bias(T) {
  return {mc: .2 * (T.warmth - .5), cheek: .3 * (T.warmth - .5), mx: .2 * T.sass, mt: -.08 * T.sass, bo: .4 * Math.max(T.sass, T.formal * .6), bas: .7 * T.sass, ll: .08 * T.warmth, app: .5 * (T.energy - .5), lu: .1 * (1 - T.energy) + .06 * T.formal, tilt: -3 * T.play * (1 - T.formal)};
 }

 // ── Clips: short additive gestures. fn(t 0..1, a amplitude) → {d: deltas, hands: {L,R: [spot, pose, dx, dy, r, s]}} ──
 const sw = (t, n) => Math.sin(t * TAU * n);
 const C = TCS.CLIPS = {
  blink:     {dur: 170, fn: (t) => ({d: {lu: 1.1 * bell(t, 0, 1)}})},
  doubleBlink:{dur: 480, fn: (t) => ({d: {lu: 1.1 * (bell(t, 0, .35) + bell(t, .55, .9))}})},
  slowBlink: {dur: 900, fn: (t) => ({d: {lu: 1.05 * hold(t, 0, .35, .7, 1)}})},
  // yes
  nodSmall:  {g: "nod", label: "Small nod", dur: 460, fn: (t, a) => ({d: {pitch: .32 * a * bell(t, 0, 1), lift: 2 * a * bell(t, 0, 1)}})},
  nodDouble: {g: "nod", label: "Double nod", dur: 720, fn: (t, a) => ({d: {pitch: .36 * a * Math.abs(sw(t, 1)) * (1 - .35 * t), lift: 3 * a * Math.abs(sw(t, 1)), mc: .2 * bell(t, 0, 1)}})},
  nodSoft:   {g: "nod", label: "Warm nod", dur: 900, fn: (t, a) => ({d: {pitch: .28 * a * bell(t, .05, .8), arc: .9 * hold(t, .1, .25, .65, .85), mc: .3 * bell(t, 0, 1), cheek: .4 * bell(t, 0, 1)}})},
  nodSlow:   {g: "nod", label: "Knowing nod", dur: 1000, fn: (t, a) => ({d: {pitch: .24 * a * bell(t, .1, .9), lu: .3 * bell(t, .1, .9), bas: .8 * bell(t, 0, 1), bo: .6 * bell(t, 0, 1), mx: .2 * bell(t, 0, 1), mc: .15 * bell(t, 0, 1)}})},
  nodFirm:   {g: "nod", label: "Emphatic nod", dur: 640, fn: (t, a) => ({d: {sy: -.05 * bell(t, 0, .2) + .03 * bell(t, .25, .5), pitch: .48 * a * bell(t, .18, .62), lift: 4 * a * bell(t, .18, .62), bo: .5 * bell(t, 0, 1), by: 3 * bell(t, .1, .7)}, hands: t > .1 && t < .85 ? {R: ["beat", "fist", 0, 10 * bell(t, .2, .6)]} : null})},
  // no
  shakeSmall:{g: "shake", label: "Small shake", dur: 560, fn: (t, a) => ({d: {yaw: .42 * a * sw(t, 1.5) * (1 - t)}})},
  shakeSlow: {g: "shake", label: "Sorry shake", dur: 1000, fn: (t, a) => ({d: {yaw: .32 * a * sw(t, 1) * bell(t, 0, 1), sarc: .8 * hold(t, .1, .25, .7, .9), ba: -.5 * bell(t, 0, 1), bo: .6 * bell(t, 0, 1), mc: -.25 * bell(t, 0, 1)}})},
  shakeFirm: {g: "shake", label: "Firm no", dur: 760, fn: (t, a) => ({d: {yaw: .6 * a * sw(t, 2) * (1 - .6 * t), ba: .45 * bell(t, 0, 1), bo: .8 * bell(t, 0, 1), mc: -.3 * bell(t, 0, 1), lu: .2 * bell(t, 0, 1)}})},
  fingerWag: {g: "shake", label: "Finger wag", dur: 1100, fn: (t, a) => ({d: {yaw: .2 * a * sw(t, 2), bas: .9 * bell(t, 0, 1), bo: .8 * bell(t, 0, 1), mx: .2 * bell(t, 0, 1)}, hands: t < .92 ? {R: ["wag", "point", 0, 0, 20 * sw(t, 3) * a]} : null})},
  // talking body language
  tilt:      {g: "question", label: "Question tilt", dur: 1000, fn: (t, a) => ({d: {tilt: -11 * a * hold(t, 0, .25, .75, 1), bas: 1 * hold(t, 0, .2, .8, 1), bo: .9 * hold(t, 0, .2, .8, 1), gy: -.15 * bell(t, 0, 1), eh: .06 * bell(t, 0, 1)}})},
  tiltOther: {g: "question", label: "Question tilt, other way", dur: 1000, fn: (t, a) => ({d: {tilt: 10 * a * hold(t, 0, .25, .75, 1), bas: -.6 * hold(t, 0, .2, .8, 1), bo: .9 * hold(t, 0, .2, .8, 1), by: -4 * bell(t, 0, 1), mr: .3 * bell(t, 0, 1)}})},
  shrug:     {g: "shrug", label: "Shrug", dur: 1100, fn: (t, a) => { const h = hold(t, 0, .2, .75, 1); return {d: {sy: .05 * h * a, lift: -5 * h * a, tilt: 6 * h * a, mx: .25 * h, mc: -.1 * h, bo: h, by: -7 * h, bas: .4 * h, eh: .05 * h}, hands: t < .95 ? {L: ["shrug", "open", 0, -4 * h], R: ["shrug", "open", 0, -4 * h]} : null}; }},
  leanIn:    {g: "explain", label: "Lean in", dur: 1300, fn: (t, a) => { const h = hold(t, 0, .2, .8, 1); return {d: {zoom: .07 * h * a, lift: 3 * h, pitch: -.08 * h, eh: .06 * h, bo: .6 * h, by: -3 * h}, hands: t < .9 ? {R: ["chest", "back", 0, 0, -10 * h]} : null}; }},
  present:   {g: "explain", label: "Open palm", dur: 900, fn: (t, a) => ({d: {tilt: -3 * bell(t, 0, 1) * a}, hands: t < .9 ? {R: ["present", "open", 0, 0, -18 + 10 * bell(t, .2, .6)]} : null})},
  count:     {g: "explain", label: "Count to three", dur: 1500, fn: (t, a) => ({d: {bo: .8 * bell(t, 0, 1), by: -5 * bell(t, 0, 1), pitch: -.08 * bell(t, 0, 1)}, hands: t < .94 ? {R: ["raise", t < .36 ? "point" : t < .64 ? "count2" : "count3", 0, -7 * bell(t, .08, .2) - 7 * bell(t, .34, .46) - 7 * bell(t, .62, .74), 0, 0, 1, 0, 0, t < .36 ? 1 : t < .64 ? 2 : 3]} : null})}, // a beat and a number as each finger goes up
  // short arms' facepalm: dismay, hands against the lower cheeks, head tilted, eyes closed
  dismay:    {g: "feel", label: "Dismay", dur: 1500, fn: (t, a) => { const h = hold(t, .05, .22, .78, .95); return {d: {tilt: -7 * h, pitch: .12 * h, lu: 1.05 * h, mc: -.35 * h, sy: -.04 * h, lift: 3 * h}, hands: t > .03 && t < .95 ? {L: ["cheekSide", "back"], R: ["cheekSide", "back"]} : null}; }},
  pointAt:   {g: "explain", label: "Point at something", dur: 1200, fn: (t, a) => { const h = hold(t, .05, .25, .8, .95), hit = bell(t, .2, .42); return {d: {gx: .6 * h, yaw: .14 * h, bo: .6 * h, pitch: .1 * h + .06 * hit, tilt: 6 * h, lift: -3 * hit}, hands: t > .03 && t < .95 ? {R: ["aim", "point", 4 * hit - 10 * (1 - ease(ramp(t, .03, .3))), 22 * (1 - ease(ramp(t, .03, .3))), -6 * hit + 40 * (1 - ease(ramp(t, .03, .3)))]} : null}; }}, // it rises out of the hanging hand on a curve
  lookAway:  {g: "recall", label: "Look away to recall", dur: 1300, fn: (t, a) => { const h = hold(t, 0, .18, .78, 1); return {d: {gx: -.75 * h, gy: -.65 * h, yaw: -.32 * h * a, tilt: 4 * h, mx: .25 * h, mr: .3 * h, bo: .8 * h, bas: .7 * h}, hands: t > .15 && t < .85 ? {R: ["chin", "point", 0, 3 * Math.abs(sw(t, 2.5))]} : null}; }},
  beat:      {g: "beat", label: "Emphasis beat", dur: 360, fn: (t, a) => ({d: {pitch: .22 * a * bell(t, 0, 1), sy: -.03 * bell(t, 0, .5), bo: .6 * bell(t, 0, 1), by: 3 * bell(t, 0, 1)}, hands: {R: ["beat", "fist", 0, 12 * a * bell(t, .1, .8)]}})},
  beatPalm:  {g: "beat", label: "Palm beat", dur: 420, fn: (t, a) => ({d: {pitch: .16 * a * bell(t, 0, 1), lift: 2 * bell(t, 0, 1)}, hands: {L: ["beat", "open", 0, 10 * a * bell(t, .1, .8), 12]}})},
  browRaise: {g: "surprise", label: "Brows up", dur: 700, fn: (t, a) => { const h = bell(t, 0, 1); return {d: {bo: h, by: -12 * h * a, eh: .14 * h * a, ew: .05 * h, lift: -5 * h * a, zoom: -.02 * h, mo: .2 * h, mr: .6 * h}}; }},
  // hands and feelings
  wave:      {g: "social", label: "Wave", dur: 1300, fn: (t, a) => ({d: {tilt: -4 * bell(t, 0, 1), mc: .2 * bell(t, 0, 1)}, hands: t < .94 ? {R: ["up", "open", 0, 0, 22 * sw(t, 2.5) * a]} : null})},
  thumbsUp:  {g: "social", label: "Thumbs up", dur: 1100, fn: (t, a) => ({d: {wink: hold(t, .15, .3, .7, .85), mc: .4 * bell(t, 0, 1), mx: .15 * bell(t, 0, 1)}, hands: t > .05 && t < .92 ? {R: ["chestFront", "thumb", 0, -3 * bell(t, .1, .35)]} : null})},
  facepalm:  {g: "feel", label: "Facepalm", dur: 1500, fn: (t, a) => { const h = hold(t, .05, .25, .75, 1); return {d: {pitch: .38 * h, tilt: -5 * h, sy: -.03 * h, lift: 4 * h, mc: -.3 * h, sarc: .8 * h}, hands: t > .05 && t < .95 ? {R: ["face", "back"]} : null}; }},
  cheeks:    {g: "feel", label: "Hands to cheeks", dur: 1500, fn: (t) => { const h = hold(t, 0, .2, .8, 1); return {d: {blush: h, arc: h, mc: .5 * h, mw: -.3 * h, tilt: 5 * sw(t, 1) * h}, hands: t < .95 ? {L: ["cheek", "back"], R: ["cheek", "back"]} : null}; }},
  fistPump:  {g: "feel", label: "Fist pump", dur: 900, fn: (t, a) => ({d: {lift: -10 * a * Math.abs(sw(t, 1)), chev: hold(t, .05, .15, .8, .95), mo: .5 * bell(t, 0, 1), mc: .5 * bell(t, 0, 1)}, hands: {L: ["up", "fist", 0, -6 * Math.abs(sw(t, 1))], R: ["up", "fist", 0, -6 * Math.abs(sw(t, 1))]}})},
  sigh:      {g: "feel", label: "Sigh", dur: 1700, fn: (t, a) => { const c = hold(t, .05, .2, .55, .7); return {d: {sarc: c, mo: .3 * c, mr: .7 * c, lift: 8 * ease(ramp(t, .5, .95)) * a, sy: -.04 * ease(ramp(t, .5, .95)), pitch: .2 * ease(ramp(t, .5, .95)), bo: .7 * c, ba: -.4 * c}}; }},
  hop:       {g: "body", label: "Hop", dur: 760, fn: (t, a) => ({d: {sy: -.1 * bell(t, 0, .22) + .07 * bell(t, .22, .55) - .08 * bell(t, .66, .86), sx: .08 * bell(t, 0, .22) - .05 * bell(t, .22, .55) + .07 * bell(t, .66, .86), lift: -28 * a * bell(t, .2, .68)}})},
  spin:      {g: "body", label: "Twirl", dur: 1000, fn: (t, a) => ({d: {yaw: Math.sin(t * TAU) * 1.1, lift: -12 * a * bell(t, 0, 1), arc: hold(t, .05, .2, .8, .95), mo: .3 * bell(t, 0, 1)}})},
  yawn:      {g: "sleep", label: "Yawn", dur: 2100, fn: (t) => { const h = hold(t, .08, .35, .62, .85); return {d: {mo: 1.15 * h, mr: .75 * h, mw: .2 * h, sarc: h, sy: .07 * h, sx: -.03 * h, lift: -4 * h, pitch: -.2 * h, bo: .5 * h, ba: -.2 * h, wet: .6 * ramp(t, .6, .9)}, hands: t > .15 && t < .8 ? {L: ["mouth", "back", 0, 0, -10]} : null}; }},
  stretch:   {g: "sleep", label: "Stretch", dur: 1700, fn: (t) => { const h = hold(t, .05, .3, .7, .9); return {d: {sy: .12 * h, sx: -.07 * h, chev: h, mo: .3 * h, lift: -6 * h, tilt: 4 * sw(t, 1) * h}, hands: t < .9 ? {L: ["head", "fist", 0, -18 * h], R: ["head", "fist", 0, -18 * h]} : null}; }},
  nodOff:    {g: "sleep", label: "Nod off", dur: 3000, fn: (t) => { const s = ease(ramp(t, 0, .72)), j = bell(t, .72, .86); return {d: {pitch: .5 * s * (1 - ramp(t, .72, .78)) - .15 * j, lift: 8 * s * (1 - ramp(t, .72, .78)) - 6 * j, lu: .35 * s * (1 - ramp(t, .72, .76)) - .6 * j, eh: .15 * j, bo: .5 * j, by: -6 * j, mo: .1 * s}}; }},
  startle:   {g: "body", label: "Startle", dur: 800, fn: (t, a) => ({d: {lift: -14 * a * bell(t, 0, .5), eh: .25 * bell(t, 0, .8), lu: -.3 * bell(t, 0, .8), bo: bell(t, 0, 1), by: -12 * bell(t, 0, 1), mo: .5 * bell(t, 0, .8), mr: 1 * bell(t, 0, .8), app: 1.2 * bell(t, 0, .8)}})},
  eyeRoll:   {g: "sass", label: "Eye roll", dur: 1000, fn: (t) => ({d: {gy: -.9 * bell(t, 0, 1), gx: lerp(-.7, .7, ease(t)) * bell(t, 0, 1), lu: .3 * bell(t, 0, 1), mx: .3 * bell(t, 0, 1), mc: -.1 * bell(t, 0, 1), tilt: 4 * bell(t, .3, 1)}})},
  hmph:      {g: "sass", label: "Hmph", dur: 1300, fn: (t) => { const h = hold(t, 0, .2, .75, 1); return {d: {yaw: .65 * h, pitch: -.22 * h, sarc: .8 * h, puff: h, mw: -.4 * h, mc: -.3 * h, bo: h, ba: .3 * h}, hands: t < .95 ? {L: ["cross", "fist"], R: ["cross", "fist"]} : null}; }},
  bow:       {g: "social", label: "Slight bow", dur: 1700, fn: (t, a) => { const h = hold(t, .1, .35, .65, .9); return {d: {pitch: .38 * h, lean: -5 * h, sarc: hold(t, .25, .35, .6, .7), mc: .2 * h, lift: 2 * h}, hands: t > .03 && t < .97 ? {R: ["chest", "back", 0, -4, -10], L: ["behind", "back"]} : null}; }},
  raisedBrow:{g: "sass", label: "One raised eyebrow", dur: 1500, fn: (t) => { const h = hold(t, .05, .2, .75, .95); return {d: {bas: 1.5 * h, bo: h, by: -2 * h, lu: .12 * h, mx: .2 * h, mc: .12 * h, tilt: 3 * h, gx: .15 * h}}; }},
  composed:  {g: "social", label: "Hands behind the back", dur: 2600, fn: (t) => { const h = hold(t, .05, .2, .8, .95); return {d: {pitch: -.08 * h, sy: .02 * h, lift: -2 * h, mc: .1 * h}, hands: t > .03 && t < .97 ? {L: ["behind", "back"], R: ["behind", "back"]} : null}; }},
  raiseHand: {needs: "gentleman", g: "gentleman", label: "Measured hand raise", dur: 1300, fn: (t) => { const h = hold(t, .1, .3, .7, .9); return {d: {mc: .2 * h, pitch: -.05 * h}, hands: t > .03 && t < .97 ? {R: ["raise", "open", -6, 6, -6 + 32 * sw(t, 2) * h]} : null}; }}, // a measured wave: the wrist rocks, the arm stays still
  rise:      {needs: "gentleman", g: "gentleman", label: "Rise on the toes", dur: 900, fn: (t) => ({d: {lift: -6 * bell(t, .1, .9), sy: .03 * bell(t, .1, .9), pitch: -.06 * bell(t, 0, 1), mc: .15 * bell(t, 0, 1)}})},
  adjustTie: {needs: "gentleman", g: "gentleman", label: "Adjust the bow tie", dur: 1500, fn: (t) => { const h = hold(t, .05, .25, .75, .95); return {d: {pitch: -.1 * h, gy: .35 * h, mc: .1 * h}, hands: t > .03 && t < .97 ? {R: ["tie", "pinch", 0, 0, 6 * Math.sin(t * TAU * 2) * h], L: ["tie", "pinch", 0, 0, -6 * Math.sin(t * TAU * 2) * h]} : null}; }},
  adjustCuff:{needs: "gentleman", g: "gentleman", label: "Adjust a cuff", dur: 1600, fn: (t) => { const h = hold(t, .05, .25, .75, .95); return {d: {gy: .45 * h, gx: .35 * h, pitch: .08 * h}, hands: t > .03 && t < .97 ? {R: ["cuffR", "fist", 0, 0, 0], L: ["cuffL", "pinch", 2 * Math.sin(t * TAU * 2), 0, 0]} : null}; }},
  chuckle:   {needs: "gentleman", g: "gentleman", label: "Quiet chuckle", dur: 1300, fn: (t) => { const h = hold(t, .05, .2, .8, .95); return {d: {arc: h, mc: .5 * h, lift: -1.5 * Math.abs(sw(t, 2.5)) * h, pitch: -.05 * h}, hands: t > .03 && t < .97 ? {R: ["heart", "back"]} : null}; }},
  // Alfred's pocket: the hand fetches the monocle (or the watch) from the waistcoat pocket; the chain is a rope sim
  monocleOut:{g: "gentleman", needs: "attach", label: "Monocle on", dur: 3400, fn: (t) => {
   const brow = ease(ramp(t, .45, .6)) * (1 - ease(ramp(t, .66, .8)));
   return {d: {bas: .8 * brow, by: -3 * brow, gy: .35 * ease(ramp(t, 0, .08)) * (1 - ease(ramp(t, .18, .3))), pitch: .06 * ease(ramp(t, 0, .08)) * (1 - ease(ramp(t, .18, .3))), mx: .12 * brow},
    // authored: the hand grows in at the monocle, carries it up an outward arc, seats it, eases off and shrinks away
    hands: t < .86 ? {R: ["monoKey", "pinch", 0, 0, 0, 1, ease(ramp(t, 0, .1)) * (1 - ease(ramp(t, .7, .76))), ease(ramp(t, .14, .64)), ease(ramp(t, .68, .76))]} : null}; }},
  // taken off by hand: the hand comes to the rim, grips it, lowers it on the outward arc and leaves it on its hook
  monocleDrop:{g: "gentleman", needs: "attach", label: "Monocle off", dur: 3000, fn: (t) => { const b = bell(t, .05, .35); return {d: {bas: .6 * b, by: -4 * b, mx: .1 * b},
   hands: t < .92 ? {R: ["monoKey", "pinch", 0, 0, 0, 1, ease(ramp(t, 0, .1)) * (1 - ease(ramp(t, .84, .92))), 1 - ease(ramp(t, .36, .76)), 1 - ease(ramp(t, .08, .26))]} : null}; }},
  // Alfred's own versions of a finger wag and a fist pump: a raised "not so fast" finger, and a quiet thumbs-up with a nod
  fingerRaise:{needs: "gentleman", g: "gentleman", label: "Not so fast (raised finger)", dur: 1300, fn: (t) => { const h = hold(t, .05, .2, .8, .95); return {d: {bas: .6 * h, bo: .5 * h, mx: .15 * h, pitch: -.04 * h}, hands: t > .03 && t < .97 ? {R: ["raise", "point", -4, 4, -4 + 10 * sw(t, 1.5) * h]} : null}; }},
  approve:   {needs: "gentleman", g: "gentleman", label: "Quiet approval", dur: 1200, fn: (t) => { const h = hold(t, .05, .2, .8, .95); return {d: {pitch: .2 * bell(t, .15, .55), mc: .35 * h, mx: .1 * h}, hands: t > .03 && t < .95 ? {R: ["chestFront", "thumb", 0, -2 * bell(t, .1, .35)]} : null}; }},
  pocketWatch:{g: "gentleman", needs: "attach", label: "Check the pocket watch", dur: 3900, fn: (t) => {
   const look = ease(ramp(t, .4, .5)) * (1 - ease(ramp(t, .74, .84)));
   return {d: {gy: .55 * look, gx: .2 * look, pitch: .05 * look, lu: .1 * look, bas: .5 * look, bo: .5 * look}, hands: t < .98 ? {R: ["watchKey", "cradle", 0, 0, 0, 1, ease(ramp(t, 0, .08)) * (1 - ease(ramp(t, .9, .97))), ease(ramp(t, .1, .36)) * (1 - ease(ramp(t, .76, .9)))]} : null}; }},
  steepleHold:{needs: "gentleman", g: "gentleman", label: "Steepled fingers", dur: 2200, fn: (t) => { const h = hold(t, .05, .2, .8, .95); return {d: {lu: .12 * h, gy: -.1 * h, mc: .08 * h, pitch: -.04 * h}, hands: t > .03 && t < .97 ? {L: ["steeple", "steeple"], R: ["steeple", "steeple"]} : null}; }},
  shrugSmall:{needs: "gentleman", g: "gentleman", label: "A small, dry shrug", dur: 1000, fn: (t) => { const h = hold(t, 0, .25, .7, 1); return {d: {sy: .02 * h, bas: 1 * h, bo: h, mx: .2 * h}, hands: t < .95 ? {R: ["present", "open", -6, 6, 40]} : null}; }},
  glance:    {g: "idle", label: "Glance", dur: 1100, fn: (t) => ({d: {gx: .6 * hold(t, 0, .06, .7, .8), yaw: .12 * hold(t, .05, .3, .7, .9)}})},
  glanceBack:{g: "idle", label: "Glance back", dur: 1100, fn: (t) => ({d: {gx: -.6 * hold(t, 0, .06, .7, .8), yaw: -.12 * hold(t, .05, .3, .7, .9)}})},
  lookAround:{g: "idle", label: "Look around", dur: 1900, fn: (t) => ({d: {gx: .55 * hold(t, .02, .08, .38, .44) - .55 * hold(t, .46, .52, .82, .88), yaw: .22 * hold(t, .05, .25, .35, .45) - .22 * hold(t, .5, .65, .8, .92), tilt: 3 * bell(t, .05, .45) - 3 * bell(t, .5, .92)}})},
  smile:     {g: "idle", label: "Smile at you", dur: 1400, fn: (t) => ({d: {ll: .4 * bell(t, 0, 1), mc: .4 * bell(t, 0, 1), cheek: .4 * bell(t, 0, 1), tilt: -3 * bell(t, 0, 1), lift: -2 * bell(t, 0, 1)}})},
  // (humps, sin², so every part leaves and arrives at rest: nothing starts at full speed)
  // the body's part of a change of expression (play with amp = the change in valence, − for sadder): a small
  // anticipation the other way, the move along an arc (lift and lean together), one overshoot, and the settle;
  // sideways scale answers vertical so her volume holds
  shift:     {g: "body", label: "Shift", dur: 1000, fn: (t, a) => { const s = Math.sign(a) || 1, m = Math.min(1.2, Math.abs(a)), h = (u, a0, b0) => bell(u, a0, b0) ** 2, L = (u) => (2 * h(u, 0, .5) - 3.6 * h(u, .22, 1)) * s * m, v = (L(t + .01) - L(t - .01)) / .02, sy = clamp(-v * .003, -.05, .05); return {d: {lift: L(t), sy, sx: -.5 * sy, lean: (-.8 * h(t, 0, .5) + 2.2 * h(t, .25, 1)) * s * m}}; }},
  squish:    {g: "body", label: "Squish", dur: 420, fn: (t) => ({d: {sy: -.1 * bell(t, 0, .5) + .04 * bell(t, .5, 1), sx: .08 * bell(t, 0, .5) - .03 * bell(t, .5, 1)}})},
  stomp:     {g: "feel", label: "Stomp", dur: 800, fn: (t, a) => ({d: {lift: -16 * a * bell(t, 0, .45), sy: -.12 * bell(t, .45, .7), sx: .1 * bell(t, .45, .7), flush: .5 * bell(t, .3, 1)}})},
  giggleOnce:{g: "feel", label: "Giggle", dur: 1000, fn: (t) => ({d: {arc: hold(t, 0, .1, .85, 1), lift: -3 * Math.abs(sw(t, 3)), tilt: -4 * bell(t, 0, 1), mc: .5 * bell(t, 0, 1)}, hands: t < .92 ? {L: ["mouth", "back"]} : null})},
  peer:      {g: "prop", label: "Peer", dur: 1600, fn: (t) => ({d: {lu: -.1 * bell(t, 0, 1), eh: .1 * bell(t, 0, 1), wink: .9 * hold(t, .1, .2, .8, .9), tongue: 0, mx: .3 * bell(t, 0, 1), pitch: .1 * bell(t, 0, 1)}})},
 };
 const NODS = ["nodSmall", "nodDouble", "nodSoft", "nodSlow", "nodFirm"], SHAKES = ["shakeSmall", "shakeSlow", "shakeFirm", "fingerWag"];
 /** Pick a gesture variant for this personality, never the same one twice running. */
 TCS.variant = function (kind, T, last, rnd = Math.random) {
  const w = {
   nod: {nodSmall: .4 + T.formal, nodDouble: .2 + T.energy * 1.2, nodSoft: .2 + T.warmth * 1.1, nodSlow: .1 + T.sass * 1.4, nodFirm: .2 + T.expr * .8},
   shake: {shakeSmall: .5 + T.formal, shakeSlow: .2 + T.warmth * .8, shakeFirm: .2 + T.expr * .8, fingerWag: .05 + T.sass * 1.2 + T.play * .4},
   question: {tilt: 1, tiltOther: .8},
   beat: {beat: .6 + T.energy, beatPalm: .5 + T.warmth},
   explain: {leanIn: .8 + T.warmth, present: .6 + T.expr, count: .3 + T.formal},
   surprise: {browRaise: 1},
   shrug: {shrug: 1},
   recall: {lookAway: 1},
  }[kind];
  if (!w) return kind;
  const ks = Object.keys(w).filter((k) => k !== last || Object.keys(w).length === 1); let s = 0; ks.forEach((k) => s += w[k]);
  let r = rnd() * s; for (const k of ks) { r -= w[k]; if (r <= 0) return k; } return ks[0];
 };

 // ── Loops: continuous life for some expressions, throttled. fn(time s, a) → deltas ─────────────────────────────────
 const LOOPS = {
  think:   {fps: 30, fn: (s, a) => { const p = (s % 5.2) / 5.2; const tap = Math.max(0, Math.sin((p - .22) * TAU * 4)) * (p > .22 && p < .44 ? 1 : 0);
   return {d: {gx: .55 * hold(p, .48, .53, .78, .84) * 2, tilt: -9 * hold(p, .46, .6, .8, .95) * a, bas: -1.6 * hold(p, .48, .55, .8, .9), mx: -.55 * hold(p, .5, .6, .8, .9), yaw: .3 * hold(p, .48, .6, .8, .92)},
    hands: {R: ["chin", "point", 0, -3 * tap]}, fx: p > .58 && p < .6 ? "ellipsis" : null}; }},
  orbit:   {fps: 30, fn: (s) => ({d: {}, spin: s})},
  drowsy:  {fps: 15, fn: (s, a) => ({d: {lift: 2.2 * Math.sin(s * TAU / 4.2), sy: .012 * Math.sin(s * TAU / 4.2 + 1), mo: .08 * Math.max(0, Math.sin(s * TAU / 4.2 + 1)), lu: .06 * Math.sin(s * TAU / 9)}}), acts: [["nodOff", 3], ["yawn", 2], ["slowBlink", 2], ["stretch", .6]], every: [5, 9]},
  breathe: {fps: 12, fn: (s) => { const b = Math.sin(s * TAU / 4.6); return {d: {sy: .022 * b, sx: -.01 * b, lift: -1.5 * b, mo: .1 + .1 * b, mr: 1}, fx: (s % 3.2) < .1 ? "zzz" : null}; }},
  laugh:   {fps: 30, fn: (s, a) => ({d: {lift: -4 * a * Math.abs(Math.sin(s * TAU * 2.2)), sy: .02 * Math.sin(s * TAU * 4.4), mo: .15 * Math.sin(s * TAU * 4.4)}}), stop: 2.6},
  giggle:  {fps: 30, fn: (s) => ({d: {lift: -2 * Math.abs(Math.sin(s * TAU * 2.8)), tilt: 1.5 * Math.sin(s * TAU * 2.8)}}), stop: 2.2},
  bounce:  {fps: 30, fn: (s, a) => ({d: {lift: -7 * a * Math.abs(Math.sin(s * TAU * 1.3))}, hands: {L: ["chest", "fist", 0, -2 * Math.abs(Math.sin(s * TAU * 1.3))], R: ["chest", "fist", 0, -2 * Math.abs(Math.sin(s * TAU * 1.3 + .4))]}}), stop: 3},
  jitter:  {fps: 24, fn: (s) => ({d: {gx: .35 * Math.sign(Math.sin(s * TAU * .9)), mwob: .3 * Math.sin(s * TAU * 3)}}), stop: 4},
  tremble: {fps: 24, fn: (s) => ({d: {mwob: .4 * Math.sin(s * TAU * 5), lift: .6 * Math.sin(s * TAU * 7)}}), stop: 2.5},
  sob:     {fps: 24, fn: (s, a) => { const b = Math.max(0, Math.sin(s * TAU * 1.6)); return {d: {lift: -3 * a * b, sy: .025 * b, mo: .25 * b, mwob: .5 * Math.sin(s * TAU * 6)}, fx: (s % .9) < .05 ? "tear" : null}; }},
  sulk:    {fps: 0, acts: [["glanceBack", 2], ["hmph", 1.2], ["sigh", .8]], every: [4, 8]},
  frustrate: {fps: 0, acts: [["sigh", 1.4], ["facepalm", .6], ["shakeSlow", .6]], every: [3.5, 6], fxEvery: "scribble"},
  shake:   {fps: 30, fn: (s) => ({d: {lean: 1.2 * Math.sin(s * TAU * 9) * (s < 1.2 ? 1 : 0)}}), acts: [["stomp", 1], ["facepalm", 1]], every: [3, 6], stop: 1.2},
  fume:    {fps: 0, acts: [["stomp", 1], ["hmph", .6]], every: [3, 5], fxEvery: "steam"},
  dizzy:   {fps: 24, fn: (s) => ({d: {tilt: 6 * Math.sin(s * TAU * .8), lean: 3 * Math.cos(s * TAU * .8)}, spin: s})},
 };
 TCS.LOOPS = LOOPS;

 // ── Hands ──────────────────────────────────────────────────────────────────────────────────────────────────────
 /** Where a hand goes, from the body's own geometry, so a hand is never outside the frame or behind the body. */
 function spot(name, side, B, F, ch, q) {
  if (ch && ch.spots && ch.spots[name]) return ch.spots[name](B, F, side, q);
  const hw = B.hw, cy = B.cy, h = B.h, ex = F.ex, eyY = F.cy + F.eyY, mY = F.cy + F.mY, E = F.lastEyes || [];
  const eL = E[0], eR = E[1], midX = eL && eR ? (eL.cx + eR.cx) / 2 : 0, eTop = eL && eR ? Math.min(eL.cy - eL.H / 2, eR.cy - eR.H / 2) : eyY - F.eh / 2;
  const eMid = eL && eR ? (eL.cy + eR.cy) / 2 : eyY, eSide = side > 0 ? eR : eL;
  // the floating hand's scale (it is sized from the drawn eye spacing), so spots can keep a whole hand clear of the face
  const hz = .53 * (eL && eR ? Math.abs(eL.cx - eR.cx) : 2 * Math.abs(ex)) / 19;
  switch (name) {
   case "side": return [side * (hw * .96), cy + h * .2, side * 12, 1];
   // props are held beside the face, not across it: outside the eyes and below the mouth where the body allows
   case "hold": return [side * Math.max(hw * .86, F.ex + F.ew * .6 + 36), Math.min(-8, Math.max(cy + h * .3, mY + 18)), 0, 1];
   case "chest": return [side * hw * .4, cy + h * .24, side * -8, 1];
   // a finger to the chin, below the mouth corner, palm side-on, never over the eyes
   // the fingertip rests on the chin just below the mouth, finger upright, back of the hand to the viewer
   // the fingertip rests on the chin; if the chin is near her base, the hand comes from the side instead of below
   case "chin": { const chinY = mY + F.mw * .32 + 8, y = chinY + 38 * 1.15; return y < -12 ? [side * 5, chinY + 32, 0, 1] : [side * (F.mw * .5 + 34), chinY + 20, side * -15, 1]; }
   case "chestFront": return [side * hw * .3, -h * .4, side * -4, 1];
   case "mouth": return [0, mY + 6, side * -6, 1];
   // a cup held by its handle with the rim at her mouth: the cup is drawn in front, so it covers the mouth
   // a snack held beside the mouth: the top of the box stays below the eyes, however short the face
   case "snack": { const eb = eL && eR ? Math.max(eL.cy + eL.H / 2, eR.cy + eR.H / 2) : eyY + F.eh / 2; return [side * (F.mw * .55 + 20), Math.max(mY + 24, eb + 64), side * -6, 1]; }
   case "sip": return [side * 19, mY + 14, side * -14, 1]; // the cup's rim reaches the lips
   case "cheek": return [side * (Math.abs((eSide && eSide.cx) || ex) + (eSide ? eSide.W * .5 : F.ew * .5) + 10 * hz + 3), eMid + F.eh * .75, side * 22, 1];
   // a phone at the side of the head, outside the eye
   case "ear": return [side * (Math.abs((eSide && eSide.cx) || ex) + F.ew * 1.25 + 8), eMid + F.eh * .9, side * -10, 1];
   case "temple": return [side * (Math.abs((eSide && eSide.cx) || ex) + (eSide ? eSide.W * .5 : F.ew * .6) + 30), eTop - 6, side * 50, 1];
   case "eye": return [eSide ? eSide.cx : side * ex, eMid + 4, 0, 1];
   case "face": return [side * ex * 1.05, eMid - F.eh * .45, side * -84, 1.05]; // the palm across the forehead, fingers pointing in
   // the fingertip rests on the bridge between the eyes, the hand below it, the arm from the side
   // fingers pinch the monocle's rim at its lower outer edge; nothing crosses the eye
   case "monocleRim": { const e = eR || {cx: ex, cy: eyY, H: F.eh}; return [e.cx + e.H * .62 + 9, e.cy + e.H * .6 + 13, -40, .95]; }
   case "bridge": return [midX, (eL ? Math.min(eL.cy, eR.cy) - eL.H * .25 : eyY) + 24, side * -6, 1];
   case "head": return [side * hw * .55, B.top + 4, side * 20, 1];
   case "up": return [side * (hw * .98), cy - h * .32, side * 18, 1];
   case "raise": return [side * (hw * .8), cy - h * .18, side * 6, 1];
   case "present": return [side * Math.max(hw * .8, F.ex + F.ew * .6 + 26), cy + h * .08, side * 10, 1.06];
   case "beat": return [side * hw * .8, cy + h * .05, side * 4, 1];
   case "wag": return [side * (hw * .78), eyY - 2, 0, 1];
   case "shrug": return [side * (hw + 8), cy - h * .02, side * 70, 1];
   case "cross": return [-side * hw * .3, cy + h * .3, -side * 70, 1];
   case "clasp": return [side * 8, cy + h * .34, side * 10, 1];
   case "fistlow": return [side * hw * .9, cy + h * .26, side * 10, 1];
   // distinct body language: hands on hips, a palm on the heart, a self-hug, fists under the chin, steepled fingers
   case "hips": return [side * B.hw * .97, cy + h * .24, side * -35, 1];
   case "heart": return [side * hw * .34, cy + h * .32, side * -20, 1];
   case "hug": return [-side * hw * .46, cy + h * .26, -side * 35, 1];
   case "underChin": { const y = mY + F.mw * .45 + 15 * hz + 4; return y < -16 * hz ? [side * 9 * hz, y, side * -12, 1] : [side * Math.max(F.mw * .5 + 14 * hz, (eSide ? Math.abs(eSide.cx) + eSide.W * .5 : Math.abs(ex) + F.ew * .5) + 12 * hz), mY + 6, side * -12, 1]; }
   // a finger tent: the backs of the hands tilted in so only the fingertips meet, the wrists well apart
   case "steeple": { const k = F.handS || hz; return [side * 15.5 * k, Math.max(cy + h * .06, mY + F.mw * .35 + 28 + 14 * k), side * -50, 1]; }
   // adjusting a cuff: the hands meet low on the right of the chest, within reach of the far arm and below the tie
   case "cuffR": return [hw * .32, cy + h * .3, 10, 1];
   // the other hand pinches the cuff at the base of the raised one
   case "cuffL": { const k = F.handS || hz; return [hw * .32 + 9 * k, cy + h * .3 + 12 * k, -20, 1]; }
   case "behind": return [side * hw * .92, cy + h * .2, side * 30, 1];
   case "overhead": return [side * 30, B.top - 30, side * -12, 1];
   // two-handed props are held low and in front, below the mouth, even if that means below her base line
   case "both": { const mb = mY + F.mw * .35, sc = clamp((30 - (mb + 14)) / 56, .7, 1.12); F.bothScale = sc; return [side * 30, Math.max(cy + h * .3, mb + 14 + 48 * sc - 14), side * -12, 1]; }
   case "toL": return [-hw * .42, cy + h * .16, -14, 1];
   // a short arm's stand-in for the face: the hand up against the side of the face, at the body's edge
   case "cheekSide": return [side * (hw * .82 + 2), F.cy + F.mY + 6, side * -30, 1];
   // pointing at something off to the side, the index along the forearm
   case "aim": return [side * (hw + 20), cy + h * .08, side * 90, 1];
   case "keysL": return [-30, -26, -8, 1];
   case "keysR": return [30, -26, 8, 1];
   default: return [side * hw * .96, cy + h * .2, 0, 1];
  }
 }
 /** Hands: flat cartoon hands in the character's own style (Taby, and the Studio's first version), three fingers and a
  * thumb. Drawn for the hand on the right of the screen with the palm centre at the origin, fingers up and the wrist
  * at (0, 12); the left hand is the mirror. Palm view puts the thumb toward the body (-x), back view away from it.
  * Each pose is a set of solid parts drawn as one figure: outline pass, then a shade pass, then the lit fill offset
  * toward the key light (upper left) and clipped to the hand, which leaves one soft shade on the lower-right edges.
  * Pinch: thumb and index meet at (-1.7, -14.5), where the monocle rim and the watch crown are held (bodies.js). */
 const R_ = (x, y, w, h, r, a = 0, cx = x + w / 2, cy = y + h / 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"${a ? ` transform="rotate(${a} ${cx} ${cy})"` : ""}/>`;
 const E_ = (cx, cy, rx, ry, a = 0) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${a ? ` transform="rotate(${a} ${cx} ${cy})"` : ""}/>`;
 // a finger: a capsule from its base (x, y) along angle a (degrees from up, + toward +x), length l, width w
 const FG = (x, y, l, w, a = 0) => R_(f1(x - w / 2), f1(y - l), w, f1(l + w / 2), w / 2, a, x, y);
 const PALM = R_(-10, -7, 20, 19, 8.5);
 // knuckle bumps along the top of the back of the hand: the back reads by its silhouette, not by texture
 const KN = E_(-6, -6.6, 3.6, 3.2, -15) + E_(0, -7.8, 3.6, 3.2) + E_(6, -6.6, 3.6, 3.2, 15);
 // fingers fanned for an open hand; together and a little curled at rest
 const FAN = FG(-6.2, -4, 10.5, 6.8, -15) + FG(0, -5.5, 12, 6.8, 0) + FG(6.2, -4, 10.5, 6.8, 15);
 const HANDS = {
  // palm to the viewer (wave, stop, shrug, present): fingers fanned, thumb out toward the body
  open: {base: PALM + FAN + FG(-8, 4, 9, 7, -62), side: "palm", line: "M-4.6 9q-1.8 -4 .8 -8M-7.6 -4.6h3M-1.5 -5.6h3M4.6 -4.6h3", gl: ""},
  // the back of the hand (palm to her own face or to what she holds): thumb on the far side
  back: {base: PALM + FAN + FG(8, 4, 8, 7, 58) + KN, side: "back", line: "", gl: "M-4.5 -1v8M0 -2v9M4.5 -1v8"},
  // relaxed at her side: fingers together, softly curled, thumb along the front
  relax: {base: R_(-9.5, -6, 19, 18, 8) + FG(-5.2, -3, 9, 6.8, -2) + FG(0, -4, 10, 6.8, 0) + FG(5.2, -3, 9, 6.8, 2) + FG(-7.6, 4, 7.5, 6.8, -20), side: "palm", line: "M-2.6 -4v-4.5M2.6 -4v-4.5", gl: ""},
  // counting: two and three fingers raised (count raises them one by one: point, count2, count3)
  count2: {base: R_(-10, -7, 20, 18, 8.5) + FG(-3.6, -5, 14, 7, -2) + FG(3.6, -5, 14, 7, 2) + E_(7.6, -5.4, 3.2, 3) + R_(-11.5, .5, 15, 6.8, 3.4, -12), side: "palm", line: "M0 -5v-9", gl: ""},
  count3: {base: R_(-10, -7, 20, 18, 8.5) + FG(-6.2, -5, 13.5, 6.4, -3) + FG(0, -5.5, 14.5, 6.4, 0) + FG(6.2, -5, 13.5, 6.4, 3) + R_(-11.5, .5, 15, 6.8, 3.4, -12), side: "palm", line: "M-3.1 -5v-9M3.1 -5v-9", gl: ""},
  // index straight up, the other two curled, the thumb folded across them
  point: {base: R_(-10, -7, 20, 18, 8.5) + FG(-4.6, -5, 14.5, 7, 0) + E_(1.6, -7, 3.6, 3.2) + E_(6.6, -6, 3.4, 3.1) + R_(-11.5, 0.5, 15, 6.8, 3.4, -12), side: "palm", line: "M-1 -5v4M4 -4v3", gl: ""},
  // pointing at things, the back of the hand toward the viewer: index up, knuckles, thumb on the far side
  pushup: {base: R_(-10, -7, 20, 18, 8.5) + FG(-4.6, -5, 14.5, 7, 0) + E_(1.6, -7, 3.6, 3.2) + E_(6.6, -6, 3.4, 3.1) + FG(8.5, 3, 7, 7, 52), side: "back", line: "M-1 -5v4M4 -4v3", gl: "M-2 0v7M3 0v7"},
  // a thumbs-up, side on: rolled fingers stacked, the thumb straight up
  thumb: {base: R_(-9.5, -5, 18, 17, 7.5) + R_(-0.5, -5, 11.5, 6, 3) + R_(-0.5, 0.4, 11.5, 6, 3) + R_(-0.5, 5.8, 10.5, 5.8, 2.9) + FG(-4.4, -3, 12, 7.6, -6), side: "edge", line: "M1 0.7h8.5M1 6.1h8", gl: ""},
  // a closed fist, knuckles to the viewer, the thumb folded across the front
  fist: {base: R_(-10, -8, 20, 19, 8.5) + E_(-5.6, -7.6, 3.8, 3) + E_(0.4, -8.4, 3.8, 3) + E_(6.2, -7.4, 3.6, 2.9) + R_(-11, 1.2, 14, 6.6, 3.3, -10), side: "palm", line: "M-2.6 -6.6v3.4M3.3 -6.4v3.4", gl: ""},
  // fingers wrapped round a handle, the thumb resting on top
  grip: {base: R_(-9.5, -8, 17.5, 19, 7.5) + R_(1.5, -7.5, 11, 6, 3) + R_(1.5, -1.9, 11, 6, 3) + R_(1.5, 3.7, 10, 5.8, 2.9) + R_(-6.5, -12.5, 14, 6.4, 3.2, -8), side: "back", line: "M2.5 -1.7h8.5M2.5 3.9h8", gl: ""},
  // a pinch: thumb and index tips meet at the pinch point, the other two fingers up behind (the monocle, the crown)
  pinch: {base: R_(-9, -5, 18.5, 17, 7.5) + E_(-2.4, -8, 4, 4.4) + FG(2, -5, 10, 6.4, -20) + FG(-6, -1, 14, 7, 18) + FG(5.6, -3.5, 9.5, 6.2, 12) + FG(9.4, -1.5, 8, 6, 28), over: FG(-6, -1, 14, 7, 18), side: "back", line: "M7.6 -4v-3.5", gl: "M2 3v5M-1.5 3.5v4.5"},
  // an open palm cupped upward, the fingertips curled up (a watch resting in it)
  cradle: {base: R_(-11, -6, 22, 15, 7) + R_(-9.6, -11, 6.2, 8, 3.1, -8) + R_(-3.1, -12, 6.2, 8.5, 3.1, 0) + R_(3.4, -11, 6.2, 8, 3.1, 8), over: R_(3.4, -11, 6.2, 8, 3.1, 8) + FG(-9, 4, 12, 7, 38), side: "palm", line: "M-6 -4.6v-2.6M.2 -5v-3M6.4 -4.6v-2.6", gl: ""},
  // edge-on views: a chop (the open hand seen side on) and a pointing hand seen side on
  chop: {base: R_(-6.5, -6, 13, 18, 6.5) + FG(.6, -3, 14, 11.5, 3) + FG(-5.8, 4, 8.5, 6.2, -26), side: "edge", line: "M-2.6 -9.5h6.5M-2.6 -5.5h6.8M-2.6 -1.5h6.5", gl: ""},
  pointEdge: {base: R_(-9.5, -5, 18, 17, 7.5) + R_(-.5, 0.4, 11.5, 6, 3) + R_(-.5, 5.8, 10.5, 5.8, 2.9) + FG(1.2, -3, 14, 6.6, 0) + R_(-10, 1, 11, 5.6, 2.8, -12), side: "edge", line: "M1 6.1h8.5M-8.6 3.2L.4 1.4", gl: ""},
  // back views of the closed and resting hands: knuckles up, the thumb on the far side
  fistBack: {base: R_(-10, -8, 20, 19, 8.5) + E_(-5.6, -7.6, 3.8, 3) + E_(0.4, -8.4, 3.8, 3) + E_(6.2, -7.4, 3.6, 2.9) + FG(9.2, 3, 6, 6.4, 50), side: "back", line: "M-5.6 -4.4v2.4M.4 -5.2v2.4M6.2 -4.2v2.4", gl: "M-3.5 0v7M1 -.5v7.5M5.5 0v7"},
  relaxBack: {base: R_(-9.5, -6, 19, 18, 8) + FG(-5.6, -3, 9.5, 6.6, -5) + FG(0, -4, 10.5, 6.6, 0) + FG(5.6, -3, 9.5, 6.6, 5) + FG(8, 4, 7.5, 6.8, 30) + KN, side: "back", line: "M-2.8 -4v-5M2.8 -4v-5", gl: "M-3.5 0v8M0 -.5v8.5M3.5 0v8"},
  // palm views of the pinch and the grip: the thumb crosses in front
  pinchPalm: {base: R_(-9, -5, 18.5, 17, 7.5) + E_(-2.4, -8, 4, 4.4) + FG(2, -5, 10, 6.4, -20) + FG(-6, -1, 14, 7, 18) + FG(5.6, -3.5, 9.5, 6.2, 12) + FG(9.4, -1.5, 8, 6, 28), side: "palm", line: "M-6.8 -2.2L-2.6 -13M7.6 -4v-3.5M-4.6 9q-1.8 -4 .8 -8", gl: ""},
  gripPalm: {base: R_(-9, -8, 18, 19, 7.5) + R_(-9.6, -7, 19.2, 5.8, 2.9) + R_(-9.6, -1.4, 19.2, 5.8, 2.9) + R_(-9, 4.2, 18, 5.6, 2.8) + R_(-6.5, -12.5, 14, 6.4, 3.2, -8), side: "palm", line: "M-8 -1.4h16M-8 4.2h15", gl: ""},
  // a teacup held by its handle: thumb and index pinch the handle, middle finger curled, the little finger out
  teacup: {base: R_(-9, -5, 18.5, 17, 7.5) + E_(-2.4, -8, 4, 4.4) + FG(2, -5, 10, 6.4, -20) + FG(-6, -1, 14, 7, 18) + E_(5.8, -4.6, 3.6, 3.3) + FG(8, 0, 10, 5.4, 52), over: FG(-6, -1, 14, 7, 18), side: "back", line: "M5.6 -2.2v-3", gl: "M2 3v5M-1.5 3.5v4.5"},
  // fingertips together (steepled), the hand seen from the side
  steeple: {base: R_(-7.5, -6, 15, 18, 6.5) + FG(-3.4, -4, 12.5, 6, -3) + FG(1.2, -5, 13.5, 6, 0) + FG(5.2, -3.5, 11.5, 5.8, 4) + FG(6, 3, 7, 6.4, 34), side: "edge", line: "M-1 -5v-6M3.4 -5v-5", gl: ""},
 };
 HANDS.wave = HANDS.open;
 // a glove's flared cuff, behind the wrist
 const CUFF = R_(-8.6, 7.5, 17.2, 7, 3);
 // the open hand's width sets every hand's scale, so a character's hands keep one size in every pose
 const HAND_REF = 27;
 const HAND_W = {open: 27, back: 27, chop: 17, count2: 23, count3: 25, relax: 22, relaxBack: 22, point: 23, pushup: 22, pointEdge: 21, thumb: 21, fist: 22, fistBack: 22, grip: 22, gripPalm: 22, pinch: 22, pinchPalm: 22, teacup: 26, cradle: 25, steeple: 19};
 // closed poses are drawn a little larger, so a fist reads with the same weight as an open hand at one character scale
 const MASS = {fist: 1.15, fistBack: 1.15, grip: 1.1, gripPalm: 1.1, thumb: 1.12, point: 1.08, pushup: 1.08, pointEdge: 1.28}; // not pinch: its tips hold the monocle exactly
 function handW(pose) { return (HAND_W[pose] || 22) * (MASS[pose] || 1); }
 function handPath(pose) { return (HANDS[pose] || HANDS.fist).base; }
 /** look: {stops: [light, base, dark], edge, glove, float}. A hand is shaded like the body it belongs to: one radial
  * light-base-dark fill over the whole hand, key light upper left on screen (mirrored for the left hand), a thin
  * softened outline and faint creases. No drop shadow (it read as a ghost copy). */
 function renderHand(pose, look, side, uid, over = false) {
  const h = HANDS[pose] || HANDS.fist;
  if (over && !h.over) return "";
  const base = over ? h.over : (look.glove ? CUFF : "") + h.base, mass = MASS[pose] || 1, gid = `hg${uid}${side > 0 ? "r" : "l"}`;
  const ln = (d, o, w = 1.1) => d ? `<path d="${d}" fill="none" stroke="${look.edge}" stroke-width="${w}" stroke-linecap="round" opacity="${o}"/>` : "";
  // palm views a touch lighter (with their creases), back views a touch darker (with their knuckles): readable when small
  const tone = h.side === "palm" ? (c) => mixHex(c, "#ffffff", .1) : h.side === "back" ? (c) => mixHex(c, "#000000", .08) : (c) => c, [l, m, d] = look.stops.map(tone);
  return `<g data-l="hand-${pose}" data-side="${h.side}"${mass !== 1 ? ` transform="scale(${mass})"` : ""}><defs><radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="${f1(-6 * side)}" cy="-11" r="27"><stop offset="0" stop-color="${l}"/><stop offset=".5" stop-color="${m}"/><stop offset="1" stop-color="${d}"/></radialGradient></defs>`
   + `<g fill="url(#${gid})" stroke="${look.edge}" stroke-width="1.2" stroke-linejoin="round">${base}</g><g fill="url(#${gid})">${base}</g>`
   + (over ? "" : ln(h.line, h.side === "palm" ? .45 : .3) + (look.glove ? ln(h.gl, .28, 1) + ln("M-7 9.6h14", .25, .9) : "")) + `</g>`;
 }
 TCS.drawFace = drawFace;
 TCS.renderHand = renderHand; TCS.HAND_REF = HAND_REF;
 TCS.HAND_SIDE_OF = (pose) => (HANDS[pose] || HANDS.fist).side;
 // which side each gesture shows (Director, 2026-11-12): the palm only when the hand shows something to the viewer;
 // the back whenever the palm faces the character or what it holds; the edge for pointing at things and chops.
 // Spots not listed keep the pose their gesture asked for.
 const SIDE = {up: "palm", raise: "palm", present: "palm", shrug: "palm", wag: "back", subHigh: "palm",
  chin: "back", cheek: "back", mouth: "back", eye: "back", face: "back", temple: "back", head: "back", ear: "back", bridge: "back", underChin: "back",
  heart: "back", hug: "back", chest: "back", clasp: "back", hold: "back", sip: "back", snack: "back", both: "back", keysL: "back", keysR: "back",
  tie: "back", cuffR: "back", cuffL: "back", hips: "back", fistlow: "back", side: "back", overhead: "back", monocleRim: "back",
  steeple: "back", monoKey: "back", watchKey: "palm", beat: "back", toL: "edge", aim: "edge", cheekSide: "back", chestFront: "edge"};
 // the pose that shows the wanted side for the pose the gesture asked for
 const SWAP = {palm: {back: "open", chop: "open", pushup: "point", pointEdge: "point", fistBack: "fist", relaxBack: "relax", pinch: "pinchPalm", grip: "gripPalm"},
  back: {open: "back", chop: "back", steeple: "back", relax: "relaxBack", point: "pushup", pointEdge: "pushup", fist: "fistBack", pinchPalm: "pinch", gripPalm: "grip"},
  edge: {open: "chop", back: "chop", point: "pointEdge", pushup: "pointEdge"}};
 const sidePose = (pose, want) => (want && SWAP[want][pose]) || pose;
 TCS.HAND_SIDE = SIDE;
 TCS.handPath = handPath;
 TCS.HAND_SHAPES = ["open", "back", "chop", "count2", "count3", "relax", "relaxBack", "point", "pushup", "pointEdge", "fist", "fistBack", "thumb", "grip", "gripPalm", "pinch", "pinchPalm", "teacup", "cradle", "steeple"];

 // ── Drawing the face ───────────────────────────────────────────────────────────────────────────────────────────
 function eyeShape(cx, cy, W, H, side, p, close) {
  const lu = clamp(Math.max(p.lu, 0) + close, 0, 1.05), top = cy - H / 2, bot = cy + H / 2, n = 40, e = 2.5, pts = [];
  const ul = (x) => top + lu * H * 1.02 + p.la * H * .5 * ((x - cx) / (W / 2)) * (-side); // + la cuts the inner corner, − the outer
  const ll = (x) => bot - clamp(p.ll, 0, 1) * H * (.95 - .55 * ((x - cx) / (W / 2)) ** 2);
  let ymin = 1e9, ymax = -1e9;
  for (let i = 0; i < n; i++) {
   const t = i / n * TAU, c = Math.cos(t), s = Math.sin(t);
   const x = cx + W / 2 * Math.sign(c) * Math.pow(Math.abs(c), 2 / e); let y = cy + H / 2 * Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
   y = Math.min(Math.max(y, ul(x)), ll(x)); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); pts.push([x, y]);
  }
  return {pts, h: ymax - ymin, ymin, ymax};
 }
 function star(cx, cy, r) { const p = []; for (let i = 0; i < 10; i++) { const a = -PI / 2 + i * PI / 5, q = i % 2 ? r * .46 : r; p.push([cx + q * Math.cos(a), cy + q * Math.sin(a)]); } return poly(p); }
 function heart(cx, cy, r) { return `M${f1(cx)} ${f1(cy + r * .85)}C${f1(cx - r * 1.3)} ${f1(cy)} ${f1(cx - r * .9)} ${f1(cy - r * 1.05)} ${f1(cx)} ${f1(cy - r * .4)}C${f1(cx + r * .9)} ${f1(cy - r * 1.05)} ${f1(cx + r * 1.3)} ${f1(cy)} ${f1(cx)} ${f1(cy + r * .85)}Z`; }
 function spiral(cx, cy, r, rot) { const p = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * TAU * 2.2 + rot, q = r * i / 40; p.push([cx + q * Math.cos(a), cy + q * Math.sin(a)]); } return smoothOpen(p); }

 // Eye shape keys: every style as a closed outline of EYE_N points, starting at the outer right and running down and round,
 // so any two blend point by point.
 const EYE_N = 40;
 const quadPts = (x0, y0, x1, y1, x2, y2, n = 24) => Array.from({length: n}, (_, i) => { const t = i / (n - 1), m = 1 - t; return [m * m * x0 + 2 * m * t * x1 + t * t * x2, m * m * y0 + 2 * m * t * y1 + t * t * y2]; });
 function linePts(P, n = 24) {
  const seg = P.slice(1).map((q, i) => Math.hypot(q[0] - P[i][0], q[1] - P[i][1])), total = seg.reduce((a, b) => a + b, 0), out = [];
  for (let i = 0; i < n; i++) { let d = i / (n - 1) * total, k = 0; while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; } const t = seg[k] ? Math.min(1, d / seg[k]) : 0; out.push([lerp(P[k][0], P[k + 1][0], t), lerp(P[k][1], P[k + 1][1], t)]); }
  return out;
 }
 // a stroked line as a closed outline: along its lower edge from the right end to the left, round the cap, back along the top
 function strokeKey(line, width) {
  const L = line[0][0] > line[line.length - 1][0] ? line : [...line].reverse(), n = L.length, half = width / 2, lo = [], hi = [];
  for (let i = 0; i < n; i++) { const a = L[Math.max(0, i - 1)], b = L[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1; let nx = -dy / d, ny = dx / d; if (ny < 0) { nx = -nx; ny = -ny; } lo.push([L[i][0] + nx * half, L[i][1] + ny * half]); hi.push([L[i][0] - nx * half, L[i][1] - ny * half]); }
  return resample([...lo, ...hi.reverse()], EYE_N);
 }
 // a closed outline round a centre, sampled by angle from the right going down: the open eye's own order
 function rayKey(cx, cy, poly) {
  const out = [];
  for (let i = 0; i < EYE_N; i++) {
   const a = i / EYE_N * TAU, dx = Math.cos(a), dy = Math.sin(a); let best = 0;
   for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((p[0] - cx) * ey - (p[1] - cy) * ex) / den, u = ((p[0] - cx) * dy - (p[1] - cy) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
   }
   out.push([cx + dx * best, cy + dy * best]);
  }
  return out;
 }
 function resample(P, n) {
  const C = [...P, P[0]], seg = C.slice(1).map((q, i) => Math.hypot(q[0] - C[i][0], q[1] - C[i][1])), total = seg.reduce((a, b) => a + b, 0), out = [];
  for (let i = 0; i < n; i++) { let d = i / n * total, k = 0; while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; } const t = seg[k] ? Math.min(1, d / seg[k]) : 0; out.push([lerp(C[k][0], C[k + 1][0], t), lerp(C[k][1], C[k + 1][1], t)]); }
  return out;
 }
 const starPts = (cx, cy, r) => Array.from({length: 10}, (_, i) => { const a = -PI / 2 + i * PI / 5, q = i % 2 ? r * .46 : r; return [cx + q * Math.cos(a), cy + q * Math.sin(a)]; });
 function heartPts(cx, cy, r) {
  const cub = (p0, p1, p2, p3, n) => Array.from({length: n}, (_, i) => { const t = i / n, m = 1 - t; return [0, 1].map((k) => m * m * m * p0[k] + 3 * m * m * t * p1[k] + 3 * m * t * t * p2[k] + t * t * t * p3[k]); });
  const b = [cx, cy + r * .85], top = [cx, cy - r * .4];
  return [...cub(b, [cx - r * 1.3, cy], [cx - r * .9, cy - r * 1.05], top, 20), ...cub(top, [cx + r * .9, cy - r * 1.05], [cx + r * 1.3, cy], b, 20)];
 }

 /** Everything on the face, in screen space, from the rendered values. */
 function drawFace(R, F, pal, time, spinT, lens) {
  const P = projector(F.R, F.curv, clamp(R.yaw, -F.yawMax, F.yawMax), R.pitch), o = [];
  const col = pal.eye, sh = pal.shine;
  const eyes = [];
  for (const side of [-1, 1]) {
   const lx = side * F.ex * R.gap + R.gx * F.ew * .5, ly = F.eyY + R.ey + R.gy * F.eh * .28;
   const q = P(lx, ly), k = (1 - .12 * R.yaw * side) * (side < 0 ? 1 + R.big : 1 - R.big * .6);
   const W = F.ew * R.ew * q.s * k, H = F.eh * R.eh * q.t * k, cx = F.cx + q.x, cy = F.cy + q.y;
   eyes.push({side, cx, cy, W, H});
   // Every eye style is a shape key: a closed outline of EYE_N points in the same order (from the outer right, down,
   // round). The eye drawn is their blend by the styles' sprung weights, so an open eye morphs into a smile arc, "> <",
   // a star or a heart through real in-between shapes; nothing swaps or cross-fades (Director's motion bar, 13 Nov).
   const winkV = side > 0 ? clamp(R.wink, 0, 1) : 0;
   const keys = {arc: Math.max(R.arc, winkV), sarc: R.sarc, chev: R.chev, star: R.star, heart: R.heart, spin: Math.max(R.spiral, R.dots)};
   let rest = 1; for (const k in keys) { keys[k] = clamp(keys[k], 0, 1); rest -= keys[k]; }
   const wOpen = Math.max(0, rest), wSum = wOpen + Object.values(keys).reduce((a, b) => a + b, 0) || 1;
   const s = eyeShape(cx, cy, W, H, side, R, R._close || 0), sw2 = Math.max(2.5, W * .26);
   const shapes = [[wOpen, s.pts]];
   if (keys.arc > .001) { const wk = winkV / (winkV + R.arc + 1e-6); shapes.push([keys.arc, strokeKey(quadPts(cx - W * lerp(.52, .5, wk), cy + H * lerp(.12, .05, wk), cx, cy - H * lerp(.42, .38, wk), cx + W * lerp(.52, .5, wk), cy + H * lerp(.12, .05, wk)), sw2)]); }
   if (keys.sarc > .001) shapes.push([keys.sarc, strokeKey(quadPts(cx - W * .52, cy + H * .08, cx, cy + H * .34, cx + W * .52, cy + H * .08), sw2 * .8)]);
   if (keys.chev > .001) shapes.push([keys.chev, strokeKey(linePts([[cx + side * W * .4, cy - H * .28], [cx - side * W * .38, cy], [cx + side * W * .4, cy + H * .28]]), sw2)]);
   if (keys.star > .001) shapes.push([keys.star, rayKey(cx, cy, starPts(cx, cy, W * .72))]);
   if (keys.heart > .001) shapes.push([keys.heart, rayKey(cx, cy, heartPts(cx, cy, W * .62))]);
   // the spinning styles (spiral, loading dots) draw themselves on over a small round pupil the eye shrinks into
   if (keys.spin > .001) shapes.push([keys.spin, rayKey(cx, cy, Array.from({length: EYE_N}, (_, i) => [cx + W * .16 * Math.cos(i / EYE_N * TAU), cy + W * .16 * Math.sin(i / EYE_N * TAU)]))]);
   const pts = Array.from({length: EYE_N}, (_, i) => { let x = 0, y = 0; for (const [w, ps] of shapes) { x += w * ps[i][0]; y += w * ps[i][1]; } return [x / wSum, y / wSum]; });
   // a shut eye stays a visible line, 3.4 px between its lids (it used to become a separate bar: a swap); point i on the
   // lower lid faces point EYE_N − i on the upper one
   for (let i = 1; i < EYE_N / 2; i++) { const b = pts[i], t = pts[EYE_N - i], gap = b[1] - t[1]; if (gap < 3.4) { b[1] += (3.4 - gap) / 2; t[1] -= (3.4 - gap) / 2; } }
   const fill = mixHex(mixHex(col, pal.star || col, keys.star / wSum), pal.heart || col, keys.heart / Math.max(1e-6, wSum - keys.star));
   o.push(`<g data-l="eye-base" data-s="${side}"><path d="${smoothClosed(pts)}" fill="${fill}"/>`);
   const open = wOpen / wSum;
   if (open > .02 && s.h > H * .3) {
    // catchlights stay toward the light while the eye moves, which makes it read as a glossy sphere; they belong to the open eye
    const hx = cx - W * .2 - R.gx * W * .1, hy = Math.max(s.ymin + H * .2, cy - H * .22), r1 = W * (.15 + .07 * R.wet) * (1 - clamp(R.lu - .3, 0, .6)) * open;
    o.push(`<ellipse cx="${f1(hx)}" cy="${f1(hy)}" rx="${f1(r1)}" ry="${f1(r1 * 1.15)}" fill="${sh}" opacity=".95"/><circle cx="${f1(cx + W * .18)}" cy="${f1(Math.min(s.ymax - W * .14, cy + H * .18))}" r="${f1(W * (.07 + .04 * R.wet) * (1 - clamp(R.lu - .3, 0, .6)) * open)}" fill="${sh}" opacity=".8"/>`);
    if (R.wet > .05) o.push(`<path d="M${f1(cx - W * .3)} ${f1(s.ymax - H * .12)}Q${f1(cx)} ${f1(s.ymax - H * .02)} ${f1(cx + W * .3)} ${f1(s.ymax - H * .12)}" stroke="${sh}" stroke-width="${f1(W * .07)}" fill="none" stroke-linecap="round" opacity="${f1(clamp(R.wet, 0, 1) * open)}"/>`);
   }
   // heavy lids get a soft crease above them, so a drowsy eye reads as drowsy rather than as a visor
   const luE = clamp(R.lu + (R._close || 0), 0, 1);
   if (open > .5 && luE > .35 && luE < .97 && Math.abs(R.la) < .25) { const ly = cy - H / 2 + luE * H * 1.02; o.push(`<path d="M${f1(cx - W * .6)} ${f1(ly + 1)}Q${f1(cx)} ${f1(ly - 6)} ${f1(cx + W * .6)} ${f1(ly + 1)}" stroke="${col}" stroke-width="${f1(Math.max(2, W * .08))}" fill="none" stroke-linecap="round" opacity="${f1(ramp(luE, .35, .5) * (1 - ramp(luE, .85, .97)) * .55 * open)}"/>`); }
   if (R.tear > .05) { const tx = cx + side * W * .38, ty = s.ymax - 1; o.push(`<path d="M${f1(tx)} ${f1(ty - 8 * R.tear)}q${f1(5.5 * R.tear)} ${f1(8 * R.tear)} 0 ${f1(11 * R.tear)}q${f1(-5.5 * R.tear)} ${f1(-3 * R.tear)} 0 ${f1(-11 * R.tear)}z" fill="#9fd4f5" opacity="${f1(clamp(R.tear, 0, 1))}"/>`); }
   const kw = (k) => keys[k] / wSum;
   if (kw("star") > .05) o.push(`<circle cx="${f1(cx - W * .14)}" cy="${f1(cy - W * .16)}" r="${f1(W * .1 * kw("star"))}" fill="#fff" opacity=".9"/>`);
   if (kw("heart") > .05) o.push(`<circle cx="${f1(cx - W * .2)}" cy="${f1(cy - W * .18)}" r="${f1(W * .1 * kw("heart"))}" fill="#fff" opacity=".8"/>`);
   o.push(`</g>`);
   // the spiral and the loading dots draw on with their weight (a growing stroke), never appearing at once
   const sp = clamp(R.spiral, 0, 1), dt0 = clamp(R.dots, 0, 1);
   if (sp > .02) o.push(`<g data-l="eye-spiral" data-s="${side}"><path d="${spiral(cx, cy, W * .6, (spinT || 0) * 6 * side)}" pathLength="1" stroke-dasharray="${f1(sp * 100) / 100} 1" stroke="${col}" stroke-width="${f1(sw2 * .7)}" fill="none" stroke-linecap="round"/></g>`);
   if (dt0 > .02) { const r = W * .42; let d = ""; for (let i = 0; i < 3; i++) { const a = (spinT || 0) * 4.2 + i * TAU / 3; d += `<circle cx="${f1(cx + r * Math.cos(a))}" cy="${f1(cy + r * Math.sin(a) * H / W)}" r="${f1(W * (.13 + .05 * Math.sin(a * 2)) * 1.35 * dt0)}" fill="${col}"/>`; } o.push(`<g data-l="eye-dots" data-s="${side}">${d}</g>`); }
   // brows
   if (R.bo > .02) {
    const by = cy - H / 2 - F.bg + R.by - (side > 0 ? R.bas * 7 : 0), bx = cx + side * W * .04, L = W * .95 * (1 - .1 * R.yaw * side);
    const rot = -side * R.ba * 24, c = R.bc * 6;
    const bw = Math.max(3, W * .2) * (F.bw || 1), bt = `transform="translate(${f1(bx)} ${f1(by)}) rotate(${f1(rot)})"`, bd = `M${f1(-L / 2)} 0Q0 ${f1(-c - 2)} ${f1(L / 2)} 0`;
    o.push(`<g data-l="brow" opacity="${f1(clamp(R.bo, 0, 1))}">` + (pal.browEdge ? `<path d="${bd}" ${bt} stroke="${pal.browEdge}" stroke-width="${f1(bw + 2.4)}" fill="none" stroke-linecap="round"/>` : "") + `<path d="${bd}" ${bt} stroke="${pal.brow || col}" stroke-width="${f1(bw)}" fill="none" stroke-linecap="round"/></g>`);
   }
  }
  // cheeks and blush, under the outer eye corners
  const bl = clamp(R.cheek * .3 + R.blush * .75, 0, 1);
  for (const e of eyes) {
   const q = P(e.side * (F.ex + F.ew * .45), F.eyY + F.eh * (.62 - .2 * clamp(R.ll, 0, 1))); // a smile lifts the cheeks
   if (bl > .02) o.push(`<ellipse cx="${f1(F.cx + q.x)}" cy="${f1(F.cy + q.y)}" rx="${f1(F.ew * .62 * q.s)}" ry="${f1(F.ew * .32)}" fill="url(#ck${F.uid})" opacity="${f1(bl)}"/>`);
   if (R.blush > .3) for (let j = -1; j <= 1; j++) o.push(`<path d="M${f1(F.cx + q.x + j * 6 * q.s - 2)} ${f1(F.cy + q.y + 3)}l4 -6" stroke="${pal.heart}" stroke-width="1.8" stroke-linecap="round" opacity="${f1((R.blush - .3) * 1.2)}"/>`);
  }
  // mouth
  const mq = P(R.mx * F.mw * .6, F.mY), mcx = F.cx + mq.x, mcy = F.cy + mq.y, Wm = Math.max(6, F.mw * 1.22 * clamp(R.mw, .2, 1.4) * mq.s);
  const curve = R.mc * F.mw * .42, open = clamp(R.mo, 0, 1.3) * F.mw * .8, round = clamp(R.mr, 0, 1), n = 18;
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
   const u = i / n * 2 - 1, x = u * Wm / 2, wob = R.mwob * 1.8 * Math.sin(u * PI * 2.5);
   let y = curve * (1 - u * u) - curve * .5 + wob, y2 = y + open * Math.pow(1 - u * u, .55);
   const ra = Math.acos(clamp(u, -1, 1)), ex2 = Wm * .26 * (1 + .5 * clamp(R.mo, 0, 1)), ey2 = Math.max(2, open * .55 + 2.5);
   const rx = Math.cos(ra) * ex2, ryU = -Math.sin(ra) * ey2, ryL = Math.sin(ra) * ey2;
   up.push([lerp(x, rx, round), lerp(y, ryU, round)]); lo.push([lerp(x, rx, round), lerp(y2, ryL, round)]);
  }
  const tr = `translate(${f1(mcx)} ${f1(mcy)}) rotate(${f1(R.mt * 30 + R.tilt * 0)})`, mstroke = Math.max(2.6, F.mw * .1);
  if (open > 1.2 || round > .5) {
   const d = smoothOpen(up) + "L" + lo.slice().reverse().map((q) => f1(q[0]) + " " + f1(q[1])).join("L") + "Z";
   const id = `mc${F.uid}`;
   o.push(`<g data-l="mouth-open" transform="${tr}"><clipPath id="${id}"><path d="${d}"/></clipPath><path d="${d}" fill="${pal.mouth}" stroke="${col}" stroke-width="${f1(mstroke * .7)}" stroke-linejoin="round"/>`
    + `<g clip-path="url(#${id})">${R.tongue > .05 ? `<ellipse cx="${f1(Wm * .08)}" cy="${f1(Math.max(...lo.map((q) => q[1])) + 1)}" rx="${f1(Wm * .3)}" ry="${f1(open * .45 + 2)}" fill="${pal.tongue}" opacity="${f1(clamp(R.tongue, 0, 1))}"/>` : ""}`
    + `${R.teeth > .05 ? `<rect x="${f1(-Wm * .5)}" y="${f1(Math.min(...up.map((q) => q[1])) - 2)}" width="${f1(Wm)}" height="${f1(Math.max(3, open * .42))}" fill="#fbfaf5" opacity="${f1(R.teeth)}"/>${R.teeth > .6 && open < 12 ? `<path d="M${f1(-Wm * .5)} ${f1(Math.min(...up.map((q) => q[1])) + open * .5)}H${f1(Wm * .5)}" stroke="${pal.mouth}" stroke-width="1.2"/>` : ""}` : ""}</g></g>`);
  } else {
   o.push(`<g data-l="mouth-line" transform="${tr}"><path d="${smoothOpen(up)}" stroke="${col}" stroke-width="${f1(mstroke)}" fill="none" stroke-linecap="round"/>${R.tongue > .4 ? `<path d="M${f1(Wm * .05)} ${f1(curve * .5)}q${f1(Wm * .14)} ${f1(10)} ${f1(Wm * .28)} 0z" fill="${pal.tongue}"/>` : ""}</g>`);
  }
  if (R.puff > .05) { const q = P(-(F.mw * .55 + 8), F.mY - 2); o.push(`<circle cx="${f1(F.cx + q.x)}" cy="${f1(F.cy + q.y)}" r="${f1(9 * R.puff * q.s)}" fill="${pal.cheek}" opacity="${f1(.35 * R.puff)}"/>`); }
  return {svg: o.join(""), eyes};
 }

 // ── Effects: short particle bursts, in front of everything ─────────────────────────────────────────────────────
 const FX = TCS.FX = {
  sparkle: {dur: 1100}, hearts: {dur: 1600}, zzz: {dur: 2800}, tears: {dur: 1400}, tear: {dur: 1300}, steam: {dur: 1300}, vein: {dur: 1500},
  sweat: {dur: 1600}, question: {dur: 1500}, exclaim: {dur: 900}, puff: {dur: 1000}, scribble: {dur: 1400}, gloom: {dur: 2400},
  notes: {dur: 1800}, confetti: {dur: 1800}, ellipsis: {dur: 1600}, flash: {dur: 420},
 };
 function drawFx(list, now, B, F, pal) {
  let o = "";
  const top = B.top, hw = B.hw;
  for (const x of list) {
   const t = clamp((now - x.t0) / x.dur, 0, 1), fade = 1 - ramp(t, .7, 1), inn = ease(ramp(t, 0, .15));
   const s = x.seed;
   switch (x.name) {
    case "sparkle": for (let i = 0; i < 5; i++) { const a = s + i * 1.3, r = hw * (.7 + .5 * t), px = Math.cos(a) * r, py = B.cy + Math.sin(a) * r * .8, k = 7 * bell(t, i * .08, .7 + i * .06); if (k > .2) o += `<path d="M${f1(px)} ${f1(py - k)}Q${f1(px)} ${f1(py)} ${f1(px + k)} ${f1(py)}Q${f1(px)} ${f1(py)} ${f1(px)} ${f1(py + k)}Q${f1(px)} ${f1(py)} ${f1(px - k)} ${f1(py)}Q${f1(px)} ${f1(py)} ${f1(px)} ${f1(py - k)}Z" fill="${pal.star}"/>`; } break;
    case "hearts": for (let i = 0; i < 3; i++) { const tt = ramp(t, i * .15, .8 + i * .07), px = (i - 1) * 30 + Math.sin(tt * 6 + i) * 6, py = top - 6 - tt * 40; if (tt > 0 && tt < 1) o += `<path d="${heart(px, py, 8)}" fill="${pal.heart}" opacity="${f1(1 - tt)}"/>`; } break;
    case "zzz": for (let i = 0; i < 3; i++) { const tt = ramp(t, i * .22, .55 + i * .22), px = hw * .5 + tt * 26 + i * 4, py = top + 6 - tt * 36 - i * 6, k = 10 + i * 3; if (tt > 0 && tt < 1) o += `<text x="${f1(px)}" y="${f1(py)}" font-size="${k}" font-weight="800" font-family="system-ui,sans-serif" fill="${pal.zzz}" opacity="${f1(Math.sin(tt * PI))}">z</text>`; } break;
    case "tears": case "tear": for (const e of F.lastEyes || []) { const tt = ramp(t, 0, 1), px = e.cx + e.side * e.W * .45, py = e.cy + e.H * .4 + tt * tt * 70; o += `<path d="M${f1(px)} ${f1(py - 7)}q5 7 0 10q-5 -3 0 -10z" fill="#9fd4f2" opacity="${f1(fade * .95)}"/>`; } break;
    case "steam": for (const side of [-1, 1]) { const tt = ease(t), px = side * (hw * .62 + tt * 18), py = top + 10 - tt * 34, k = .5 + .7 * tt, op = .85 * fade * inn; o += `<g transform="translate(${f1(px)} ${f1(py)}) scale(${f1(k)})" opacity="${f1(op)}" fill="${pal.steam}" stroke="#9aa3ad" stroke-width="1.4"><path d="M-12 4q-8 0 -6 -8q2 -6 8 -4q2 -8 10 -6q8 2 6 9q8 1 6 8q-2 5 -8 3z"/></g>`; } break;
    case "vein": { const px = hw * .5, py = top + 22, k = 9 * (1 + .25 * Math.sin(t * 18)) * inn; o += `<g transform="translate(${f1(px)} ${f1(py)})" stroke="#d9363e" stroke-width="3.2" stroke-linecap="round" fill="none" opacity="${f1(fade)}"><path d="M${f1(-k)} ${f1(-k * .3)}q${f1(k * .7)} 0 ${f1(k * .7)} ${f1(-k * .7)}M${f1(k)} ${f1(-k * .3)}q${f1(-k * .7)} 0 ${f1(-k * .7)} ${f1(-k * .7)}M${f1(-k)} ${f1(k * .3)}q${f1(k * .7)} 0 ${f1(k * .7)} ${f1(k * .7)}M${f1(k)} ${f1(k * .3)}q${f1(-k * .7)} 0 ${f1(-k * .7)} ${f1(k * .7)}"/></g>`; break; }
    case "sweat": { const px = -hw * .58, py = top + 26 + ease(ramp(t, .3, 1)) * 18; o += `<path d="M${f1(px)} ${f1(py - 12 * inn)}q8 11 0 15q-8 -4 0 -15z" fill="#9fd4f2" stroke="#5aa9d6" stroke-width="1.2" opacity="${f1(fade)}"/>`; break; }
    case "question": { const px = hw * .62, py = top - 4 - 6 * ease(ramp(t, 0, .2)); o += `<text x="${f1(px)}" y="${f1(py)}" font-size="${f1(26 * (.6 + .4 * inn))}" font-weight="800" font-family="system-ui,sans-serif" fill="${pal.zzz}" opacity="${f1(fade)}" transform="rotate(${f1(8 * Math.sin(t * 9))} ${f1(px)} ${f1(py)})">?</text>`; break; }
    case "exclaim": { const px = hw * .6, py = top - 2; o += `<text x="${f1(px)}" y="${f1(py)}" font-size="${f1(28 * (.5 + .5 * inn))}" font-weight="900" font-family="system-ui,sans-serif" fill="${pal.star}" opacity="${f1(fade)}">!</text>`; break; }
    case "puff": { const px = -hw * .45 - t * 22, py = F.cy + F.mY - t * 8; o += `<circle cx="${f1(px)}" cy="${f1(py)}" r="${f1(5 + t * 9)}" fill="${pal.steam}" opacity="${f1(.7 * (1 - t))}"/><circle cx="${f1(px - 9)}" cy="${f1(py + 4)}" r="${f1(3 + t * 6)}" fill="${pal.steam}" opacity="${f1(.5 * (1 - t))}"/>`; break; }
    case "scribble": { const px = hw * .55, py = top - 10, k = 12 * inn; let d = `M${f1(px - k)} ${f1(py)}`; for (let i = 0; i < 7; i++) d += `q${f1(k * .3)} ${f1((i % 2 ? 1 : -1) * k * .8)} ${f1(k * .3)} 0`; o += `<path d="${d}" stroke="${pal.zzz}" stroke-width="2.4" fill="none" stroke-linecap="round" opacity="${f1(fade)}" transform="rotate(${f1(t * 200)} ${f1(px)} ${f1(py)})"/>`; break; }
    case "gloom": for (let i = 0; i < 3; i++) { const px = (i - 1) * 18, py = top - 26 + t * 10; o += `<path d="M${f1(px)} ${f1(py)}q4 6 0 12q-4 6 0 12" stroke="${pal.zzz}" stroke-width="2.2" fill="none" stroke-linecap="round" opacity="${f1(.6 * fade * inn)}"/>`; } break;
    case "notes": for (let i = 0; i < 2; i++) { const tt = ramp(t, i * .3, .7 + i * .3), px = hw * .5 + tt * 20 + i * 12, py = top - tt * 40; if (tt > 0 && tt < 1) o += `<text x="${f1(px)}" y="${f1(py)}" font-size="18" fill="${pal.zzz}" opacity="${f1(Math.sin(tt * PI))}">♪</text>`; } break;
    case "confetti": for (let i = 0; i < 16; i++) { const a = s + i * 2.39, v = 60 + (i % 5) * 18, px = Math.cos(a) * v * t, py = top - 10 + Math.sin(a) * v * t * .6 + 90 * t * t; o += `<rect x="${f1(px)}" y="${f1(py)}" width="6" height="3.5" fill="${[pal.star, pal.heart, "#5FB3B3", "#BC96CE"][i % 4]}" transform="rotate(${f1(t * 720 + i * 40)} ${f1(px)} ${f1(py)})" opacity="${f1(fade)}"/>`; } break;
    case "ellipsis": for (let i = 0; i < 3; i++) o += `<circle cx="${f1(hw * .5 + 10 + i * 10)}" cy="${f1(top - 4 - i * 6)}" r="${f1(3 + i)}" fill="${pal.zzz}" opacity="${f1(bell(t, i * .15, .7 + i * .1))}"/>`; break;
    // a camera flash: a small, quick burst at the camera's side, never a wash over her face
    case "flash": { const px = hw * .95, py = B.cy + B.h * .2, k = 8 + 22 * ease(t); o += `<g opacity="${f1(.85 * (1 - t))}"><circle cx="${f1(px)}" cy="${f1(py)}" r="${f1(k * .5)}" fill="#fff"/>${[0, 1, 2, 3, 4, 5].map((i) => { const a = i * PI / 3; return `<path d="M${f1(px + Math.cos(a) * k * .6)} ${f1(py + Math.sin(a) * k * .6)}L${f1(px + Math.cos(a) * k)} ${f1(py + Math.sin(a) * k)}" stroke="#fff3b0" stroke-width="2.5" stroke-linecap="round"/>`; }).join("")}</g>`; break; }
   }
  }
  return o;
 }

 // ── The rig ────────────────────────────────────────────────────────────────────────────────────────────────────
 let UID = 0;
 const GROUND = 112;
 TCS.VIEWBOX = "-160 -168 320 320";
 TCS.create = function (svg, opts = {}) {
  const uid = ++UID, NS = "http://www.w3.org/2000/svg";
  svg.setAttribute("viewBox", TCS.VIEWBOX);
  svg.innerHTML = `<defs></defs><g class="sh"></g><g class="glow"></g><g class="w"><g class="bk"></g><g class="bd"></g><g class="fc"></g><g class="fr"></g><g class="wn"></g><g class="hd"></g></g><g class="fx"></g>`;
  const $ = (s) => svg.querySelector(s);
  const L = {defs: $("defs"), sh: $(".sh"), glow: $(".glow"), w: $(".w"), bk: $(".bk"), bd: $(".bd"), fc: $(".fc"), fr: $(".fr"), wn: $(".wn"), hd: $(".hd"), fx: $(".fx")};
  let ch = TCS.CHARACTERS[opts.character] || Object.values(TCS.CHARACTERS)[0];
  let T = Object.assign({energy: .5, warmth: .6, play: .4, expr: .55, formal: .5, sass: .3}, opts.personality || {});
  let tu = tune(T), bi = bias(T), intensity = opts.intensity ?? 1;
  const reduced = opts.reduced ?? (g.matchMedia && g.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const cur = Object.assign({}, N), vel = {}, tgt = Object.assign({}, N);
  let oldLoop = null;
  // values on their way to a new target: {from, to, t0, dur}
  const tw = {};
  const pace = () => clamp(tu.tau / .12, .85, 1.3);
  KEYS.forEach((k) => vel[k] = 0);
  let expr = "neutral", clips = [], fxs = [], props = {}, propT = {}, speech = null, loopT0 = 0, loopFrame = 0, nextLoopAct = 0;
  const hands = {L: {x: 0, y: 0, r: 0, s: 0, vx: 0, vy: 0, vr: 0, vs: 0, pose: "open"}, R: {x: 0, y: 0, r: 0, s: 0, vx: 0, vy: 0, vr: 0, vs: 0, pose: "open"}};
  const sec = {x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0};
  let handMode = opts.hands || "arms"; // arms by default (Director, 13 Nov); floating hands are a hidden option
  let raf = 0, last = 0, frames = 0, running = false, destroyed = false, blinkTimer = 0, idleTimer = 0, lastVariant = {}, dyn = "";
  const stats = {frames: 0, since: performance.now()};
  let B = null, F = null;

  function defs() {
   const p = ch.pal;
   L.defs.innerHTML = `<radialGradient id="bg${uid}" cx=".36" cy=".28" r=".95"><stop offset="0" stop-color="${p.light}"/><stop offset=".48" stop-color="${p.base}"/><stop offset="1" stop-color="${p.dark}"/></radialGradient>`
    + `<radialGradient id="hl${uid}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity="${p.gloss ?? .5}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="cs${uid}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${p.dark}" stop-opacity=".55"/><stop offset="1" stop-color="${p.dark}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="gs${uid}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="ck${uid}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${p.cheek}" stop-opacity=".95"/><stop offset="1" stop-color="${p.cheek}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="fl${uid}" cx=".5" cy=".15" r=".8"><stop offset="0" stop-color="#e2403f" stop-opacity=".75"/><stop offset="1" stop-color="#e2403f" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="gl${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4a7a" stop-opacity=".7"/><stop offset=".6" stop-color="#3b4a7a" stop-opacity="0"/></linearGradient>`
    + `<radialGradient id="gw${uid}" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${p.glow || p.light}" stop-opacity=".55"/><stop offset="1" stop-color="${p.glow || p.light}" stop-opacity="0"/></radialGradient>`
    + `<clipPath id="cl${uid}"><path/></clipPath>` + (ch.defs ? ch.defs(uid, p) : "");

   L.defs.insertAdjacentHTML("beforeend", `<mask id="re${uid}" maskUnits="userSpaceOnUse" x="-300" y="-300" width="600" height="600"><path fill="none" stroke="#fff" stroke-width="16"/></mask><mask id="rc${uid}" maskUnits="userSpaceOnUse" x="-300" y="-300" width="600" height="600"><g mask="url(#re${uid})"></g></mask>`);
   L.rc = L.defs.querySelector(`#rc${uid} g`); L.rcEdge = L.defs.querySelector(`#re${uid} path`);
   L.clip = L.defs.querySelector(`#cl${uid} path`);
   L.stops = [...L.defs.querySelectorAll(`#bg${uid} stop`)];
   L.bd.setAttribute("clip-path", `url(#cl${uid})`); L.fc.setAttribute("clip-path", `url(#cl${uid})`);
   dyn = "";
  }

  // targets: the expression's look scaled by intensity and personality amplitude, plus the personality's resting bias
  function retarget() {
   const ex = E[expr] || E.neutral, A = tu.amp * intensity;
   for (const k of KEYS) {
    const base = N[k] + (bi[k] || 0) + ((ch.bias && ch.bias[k]) || 0), look = ex.look[k];
    if (look === undefined) { tgt[k] = base; continue; }
    tgt[k] = STYLE.has(k) ? look : base + (look - N[k]) * A;
   }
   tgt.sx = 1 + (tgt.sx - 1); // keep
   // posture follows the mood: up and a little back when it rises, down and forward when it falls
   // and a warm aura swells behind her as it rises (a falling mood greys through its own gloom)
   const v = VALENCE[ex.g] ?? 0; tgt.lift += -4 * v * A; tgt.pitch += -.03 * v * A; tgt.glow += Math.max(0, v) * .35 * A;
  }
  function setExpression(name, o = {}) {
   if (!E[name]) return;
   const prev = expr, t = performance.now();
   expr = name;
   // a mood's own acts (a sigh, a facepalm) end with the mood, fading out rather than cut
   for (const c of clips) if (c.loop && c.fade0 === undefined) c.fade0 = t;
   // the old mood's loop (a sway, a breath) fades out over its first moments, never vanishing at once
   if (prev !== name && E[prev] && E[prev].loop && LOOPS[E[prev].loop] && LOOPS[E[prev].loop].fn) oldLoop = {lp: LOOPS[E[prev].loop], t0: loopT0, fade0: t};
   if (o.intensity !== undefined) intensity = o.intensity;
   retarget();
   if (!reduced) for (const k of KEYS) if (Math.abs(tgt[k] - cur[k]) > 1e-3) tw[k] = {from: cur[k], to: tgt[k], t0: t + LAG[k] * pace(), dur: TWEEN_MS * pace()};
   if (prev !== name && !reduced && !opts.static) { const d = (VALENCE[(E[name] || {}).g] ?? 0) - (VALENCE[(E[prev] || {}).g] ?? 0); play("shift", {amp: Math.abs(d) < .25 ? .35 : clamp(d, -1, 1), raw: true}); }
   const ex = E[name];
   loopT0 = performance.now(); nextLoopAct = loopT0 + 1500;
   // every change morphs: the face's shape keys blend through in-betweens (the motion bar, 13 Nov, replaced the old
   // "cut through a blink so the new face pops" rule)
   if (shaped(tgt)) clips = clips.filter((c) => !(/link/.test(c.name) && !c.cut)); // no blink carries over onto shaped eyes
   if (ex.fx && !reduced) spawn(ex.fx);
   if (name === "sad" || name === "sulky") spawn("gloom");
   wake();
  }
  function setPersonality(t) { Object.assign(T, t); tu = tune(T); bi = bias(T); retarget(); scheduleIdle(); wake(); }
  function setCharacter(id) { if (!TCS.CHARACTERS[id]) return; ch = TCS.CHARACTERS[id]; defs(); retarget(); wake(); render(performance.now(), true); }
  function play(name, o = {}) {
   if (ch.remap && ch.remap[name] && !o.raw) name = ch.remap[name];
   const c = C[name]; if (!c) return;
   if (c.needs && !ch[c.needs]) return; // e.g. the pocket actions need a character with a pocket and chain
   if (/^(blink|doubleBlink|slowBlink)$/.test(name) && !o.cut && eyesShaped()) return;
   if (reduced && !o.force && c.g !== undefined && name !== "blink") { if (o.cut) snapFace(); return; }
   const dur = (o.dur || c.dur) * (name.includes("link") ? 1 : tu.gdur);
   clips.push({name, c, loop: !!o.fromLoop, t0: performance.now() + (o.delay || 0), dur, a: (o.amp ?? 1) * (name.includes("link") ? 1 : tu.gamp), cut: o.cut, cutDone: false});
   wake();
  }
  function snapFace() { for (const k of KEYS) if (!SPRING.has(k)) { cur[k] = tgt[k]; vel[k] = 0; delete tw[k]; } }
  function spawn(name) { if (!FX[name] || reduced) return; fxs.push({name, t0: performance.now(), dur: FX[name].dur, seed: Math.random() * 6}); wake(); }
  function prop(name, on = true) {
   if (name === "monocle" && ch.attach) { if (on) play("monocleOut", {force: true}); else play("monocleDrop", {force: true}); }
   const P = TCS.PROPS[name]; if (!P) return;
   if (on) {
    // one prop per mount: a new one replaces the old one, which leaves first
    for (const k in props) if (k !== name && !props[k].out && TCS.propConflicts(k, name)) prop(k, false);
    props[name] = {t0: performance.now(), out: 0};
    if (P.use && !reduced && !g.__noAutoUse && !(name === "monocle" && ch.attach)) setTimeout(() => props[name] && use(name), 700); // QA turns the automatic first use off to time it itself
   } else if (props[name] && !props[name].out) props[name].out = performance.now();
   wake();
  }
  function use(name) { const P = TCS.PROPS[name]; if (!P || !props[name] || props[name].out || !P.use || ch.noHands) return; props[name].use = performance.now(); props[name].useDur = TCS.USES[P.use].dur; const fx = TCS.USES[P.use].fn(.5).fx; if (fx) spawn(fx); wake(); }
  function clearProps() { for (const k in props) prop(k, false); }

  // ── speech: the mouth follows the syllable envelope; gestures fire on their words ──
  function speak(plan, hooks = {}) {
   stopSpeech();
   speech = {plan, hooks, t0: performance.now() + 80, fired: new Set(), word: -1, offset: 0};
   wake();
   return new Promise((res) => speech.done = res);
  }
  function syncSpeech(i) { if (!speech) return; const w = speech.plan.words[i]; if (w) speech.offset = (performance.now() - speech.t0) / 1000 - w.t; }
  // follow a real audio clock: the mouth and gestures stay on the audio even if a frame or the network stutters
  function speechTime(sec) { if (speech) { speech.t0 = performance.now() - sec * 1000; speech.offset = 0; wake(); } }
  function stopSpeech() { if (speech) { const d = speech.done; speech = null; d && d(); } }

  // ── scheduling: blinks and idle acts; at rest the loop sleeps ──
  function scheduleBlink() { clearTimeout(blinkTimer); if (opts.static || destroyed) return; blinkTimer = setTimeout(() => { if (!document.hidden && !speechBusy() && !eyesShaped()) play(Math.random() < .18 ? "doubleBlink" : "blink"); scheduleBlink(); }, (tu.blink * (.55 + Math.random() * .9)) * 1000); }
  function speechBusy() { return !!speech; }
  // closed or shaped eyes (arcs, > <, stars…) and heavy lids never get a blink on top
  const shaped = (v) => Math.max(v.arc, v.sarc, v.chev, v.star, v.heart, v.spiral, v.dots, v.wink) > .3;
  function eyesShaped() { return shaped(cur) || shaped(tgt) || cur.lu > .6; }
  function scheduleIdle() {
   clearTimeout(idleTimer); if (opts.static || opts.quiet || destroyed || reduced) return;
   idleTimer = setTimeout(() => { if (!document.hidden && !speech && !clips.some((c) => !/link/.test(c.name)) && !(E[expr].loop && LOOPS[E[expr].loop].acts)) idleAct(); scheduleIdle(); }, tu.idle * (.6 + Math.random() * .8) * 1000);
  }
  function idleAct() {
   const w = [["glance", 1], ["glanceBack", 1], ["lookAround", .5 + T.energy], ["smile", .2 + T.warmth], ["tilt", .2 + T.warmth * .4], ["hop", T.play * T.energy * 1.4], ["squish", T.play * .7], ["eyeRoll", T.sass * .7 * (expr === "neutral" ? 1 : 0)], ["stretch", (1 - T.energy) * .4], ["fidget", .3 + T.play]];
   if (ch.idle) w.push(...ch.idle);
   if (["sad", "sulky", "lonely", "angry", "frustrated", "asleep", "sleepy"].includes(expr)) w.splice(3);
   let s = 0; w.forEach((x) => s += x[1]); let r = Math.random() * s;
   for (const [k, v] of w) { r -= v; if (r <= 0) { if (k === "fidget") fidget(); else play(k); return; } }
   // a prop she holds is used now and then: a sip, an adjustment, a tap
   const hp = Object.keys(props).find((k) => TCS.PROPS[k].use); if (hp && Math.random() < .5) use(hp);
  }
  function fidget() { if (ch.fidget) { clips.push({name: "fidget", c: {dur: ch.fidget.dur, fn: ch.fidget.fn}, t0: performance.now(), dur: ch.fidget.dur * tu.gdur, a: tu.gamp}); wake(); } }

  function wake() { if (destroyed) return; if (opts.static) { render(performance.now(), true); return; } if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } }

  // the silhouette profile: the body's left and right edge at 41 heights, measured once per character from its
  // neutral outline (hidden path, isPointInFill), then scaled with the body
  function profileOf(c) {
   if (c._prof) return c._prof;
   const R0 = Object.assign({}, N), ctx0 = {t: 0, uid, sec: {x: 0, y: 0, vx: 0, vy: 0}, pal: c.pal, R: R0, expr: "neutral", proj: projector(c.face.R, c.face.curv ?? 1, 0, 0)};
   const b0 = c.body(R0, ctx0), n = 41, Lx = [], Rx = [];
   let probe = document.getElementById("tcs-probe");
   if (!probe) { probe = document.createElementNS("http://www.w3.org/2000/svg", "svg"); probe.id = "tcs-probe"; probe.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden"); probe.innerHTML = "<path/>"; document.body.appendChild(probe); }
   const path = probe.firstChild; path.setAttribute("d", b0.d);
   const inside = (x, y) => { try { return path.isPointInFill(new DOMPoint(x, y)); } catch { return Math.abs(x) < b0.hw; } };
   for (let i = 0; i < n; i++) {
    const y = -b0.h * i / (n - 1) * .985 - (i === 0 ? 1 : 0);
    let r = 0; while (r < 260 && inside(r + 1, y)) r++;
    let l = 0; while (l < 260 && inside(-(l + 1), y)) l++;
    Rx.push(r || b0.hw * .2); Lx.push(l || b0.hw * .2);
   }
   c._prof = {n, h: b0.h, hw: b0.hw, R: Rx, L: Lx};
   return c._prof;
  }
  function stepSprings(dt, now) {
   const k = tu.k, z = tu.z, c = 2 * z * Math.sqrt(k);
   let moving = false;
   for (const key of KEYS) {
    const target = tgt[key], w = tw[key];
    if (w && w.to === target) {
     // a change: slow in, slow out, from wherever it was
     const p = clamp((now - w.t0) / w.dur, 0, 1);
     cur[key] = w.from + (w.to - w.from) * smoother(p); vel[key] = 0;
     if (p < 1) moving = true; else delete tw[key];
    } else if (!SPRING.has(key)) {
     // any other new target (a personality, an intensity) travels the same way
     if (Math.abs(target - cur[key]) > 1e-3) { tw[key] = {from: cur[key], to: target, t0: now, dur: TWEEN_MS * pace()}; moving = true; } else cur[key] = target;
    } else {
     const acc = k * (target - cur[key]) - c * vel[key];
     vel[key] += acc * dt; cur[key] += vel[key] * dt;
     if (Math.abs(target - cur[key]) > 1e-3 || Math.abs(vel[key]) > 1e-3) moving = true; else { cur[key] = target; vel[key] = 0; }
    }
   }
   return moving;
  }
  function stepHand(h, tx, ty, tr, ts, dt) {
   // a new pose starts with a small anticipation away from it (90 ms), then an under-damped spring (ζ 0.78) carries the
   // hand there with a touch of overshoot and lets it settle; size eases critically damped (it never pulses)
   if (Math.hypot(tx - (h.gx ?? tx), ty - (h.gy ?? ty)) > 18) { const d = Math.hypot(tx - h.x, ty - h.y) || 1, mg = Math.min(6, d * .07); h.ant = .09; h.ax = h.x - (tx - h.x) / d * mg; h.ay = h.y - (ty - h.y) / d * mg; }
   h.gx = tx; h.gy = ty;
   if (h.ant > 0) { h.ant -= dt; tx = h.ax; ty = h.ay; }
   const k = clamp(tu.k * .8, 60, 150), cc = 2 * Math.sqrt(k), cu = 2 * .78 * Math.sqrt(k);
   let m = h.ant > 0;
   for (const [p, v, t] of [["x", "vx", tx], ["y", "vy", ty], ["r", "vr", tr], ["s", "vs", ts]]) {
    const acc = k * (t - h[p]) - (p === "s" ? cc : cu) * h[v]; h[v] += acc * dt; h[p] += h[v] * dt;
    if (Math.abs(t - h[p]) > .05 || Math.abs(h[v]) > .05) m = true; else { h[p] = t; h[v] = 0; }
   }
   return m;
  }

  function frame(now) {
   if (destroyed) return;
   const dt = Math.min(.05, (now - last) / 1000);
   const ex = E[expr], lp = ex.loop && LOOPS[ex.loop];
   // throttled loops: skip frames to hold their fps, unless something else needs full rate
   const fullRate = clips.length || speech || Object.values(props).some((p) => now - p.t0 < 900 || p.out || (p.use && now - p.use < p.useDur));
   const busy = fullRate || fxs.length;
   // a throttled loop (breathing, thinking) keeps its low rate even while its own effects (zzz, …) float by
   if (lp && lp.fps && !fullRate && !reduced) { const step = 1000 / lp.fps; if (now - loopFrame < step - 2) { raf = requestAnimationFrame(frame); return; } loopFrame = now; }
   last = now;
   const moving = render(now, false, dt);
   if (moving || busy || (lp && lp.fps && !reduced && !(lp.stop && (now - loopT0) / 1000 > lp.stop)) || (lp && lp.acts)) {
    if (lp && lp.acts && !reduced && !opts.quiet && now > nextLoopAct && !speech) {
     let s = 0; lp.acts.forEach((a) => s += a[1]); let r = Math.random() * s; for (const [k, v] of lp.acts) { r -= v; if (r <= 0) { play(k, {fromLoop: true}); break; } }
     if (lp.fxEvery) spawn(lp.fxEvery);
     nextLoopAct = now + (lp.every[0] + Math.random() * (lp.every[1] - lp.every[0])) * 1000;
    }
    if (lp && lp.acts && !lp.fps && !moving && !busy) { running = false; setTimeout(wake, Math.max(50, nextLoopAct - now)); return; }
    raf = requestAnimationFrame(frame);
   } else running = false;
  }

  // A layer is rebuilt only when its markup changed: at rest most layers (arms, sleeves and their masks) stay as they were,
  // so the browser neither rebuilds nor repaints them.
  const put = (el, html) => { if (el.__h !== html) { el.__h = html; el.innerHTML = html; } };
  function render(now, snap, dt = 1 / 60) {
   let moving = false;
   if (snap) { for (const k of KEYS) cur[k] = tgt[k]; } else moving = stepSprings(dt, now);
   if (Object.keys(tw).length) moving = true;
   // rendered values: state + clips + loop + speech
   const Rv = Object.assign({}, cur), handReq = {L: null, R: null};
   const add = (d, a = 1) => { for (const k in d) if (k in Rv) Rv[k] += d[k] * a; };
   const ex = E[expr], lp = ex.loop && LOOPS[ex.loop];
   let spinT = 0;
   if (lp && lp.fn && !reduced) {
    // a new mood's own loop (a laugh, a sway) eases in after the change's move, never starting at full strength
    const s = (now - loopT0) / 1000, fade = (lp.stop ? 1 - ramp(s, lp.stop - .6, lp.stop) : 1) * ease(ramp(s, .7, 1.2));
    const r = lp.fn(s, tu.gamp * intensity);
    if (fade > 0) { add(r.d || {}, fade); if (r.hands && fade > .5 && !(ch.exprHands && ch.exprHands[expr])) Object.assign(handReq, r.hands); }
    if (r.spin !== undefined) spinT = r.spin;
    if (r.fx && !snap) { const lastFx = fxs.find((x) => x.name === r.fx && now - x.t0 < 600); if (!lastFx) spawn(r.fx); }
   } else if (lp && lp.spin) spinT = now / 1000;
   if (oldLoop && !reduced) {
    const fade = 1 - clamp((now - oldLoop.fade0) / 280, 0, 1);
    if (fade <= 0 || oldLoop.lp === lp) oldLoop = null; else { add(oldLoop.lp.fn((now - oldLoop.t0) / 1000, tu.gamp * intensity).d || {}, fade); moving = true; }
   }
   if (E[expr].look.dots || E[expr].look.spiral) spinT = (now - loopT0) / 1000;
   Rv._close = 0;
   const eyesClosedOrShaped = shaped(cur);
   clips = clips.filter((c) => {
    const t = c.frozen !== undefined ? c.frozen : (now - c.t0) / c.dur; if (t < 0) return true; if (t >= 1) return false;
    const fade = c.fade0 === undefined ? 1 : 1 - clamp((now - c.fade0) / 220, 0, 1); if (fade <= 0) return false;
    if (eyesClosedOrShaped && /link/.test(c.name) && !c.cut) return false;
    const r = c.c.fn(t, c.a) || {};
    if (c.name.includes("link")) Rv._close = Math.max(Rv._close, ((r.d && r.d.lu) || 0) * fade);
    else add(r.d || {}, fade);
    if (r.hands && fade > .5) for (const s of ["L", "R"]) if (r.hands[s]) handReq[s] = r.hands[s];
    if (c.cut && !c.cutDone && t > .45) { c.cutDone = true; snapFace(); }
    return true;
   });
   const pre = TCS.propPre(props, now);
   add(pre.d);
   // speech: envelope → mouth; gestures fire once at their time
   if (speech) {
    const st = (now - speech.t0) / 1000 - speech.offset, P = speech.plan;
    if (st >= 0) {
     let env = 0, shape = 0, wi = -1;
     for (const sy of P.syl) { const u = (st - sy.t) / sy.d; if (u > -.2 && u < 1.2) { const b = Math.sin(PI * clamp(u, 0, 1)); if (b > env) { env = b * sy.a; shape = sy.round; } } }
     for (let i = 0; i < P.words.length; i++) if (st >= P.words[i].t) wi = i;
     if (wi !== speech.word) { speech.word = wi; speech.hooks.onWord && speech.hooks.onWord(wi); }
     for (let i = 0; i < P.events.length; i++) {
      const e = P.events[i]; if (speech.fired.has(i) || st < e.t) continue; speech.fired.add(i);
      if (e.kind === "expr") setExpression(e.name, {noCut: true});
      else if (e.kind === "fx") spawn(e.name);
      else if (e.kind === "prop") prop(e.name, e.on !== false);
      else { const v = TCS.variant(e.kind, T, lastVariant[e.kind]); lastVariant[e.kind] = v; play(v, {amp: e.amp || 1}); e.played = v; }
      speech.hooks.onEvent && speech.hooks.onEvent(e, i);
     }
     const A = clamp(.3 + .7 * T.expr, .3, 1);
     // lip sync: blend the current viseme into the next over the last third of its time (coarticulation)
     // a live audio source (lipsync.js) drives the mouth from the sound itself; text visemes are the fallback
     const live = speech.hooks.mouth && speech.hooks.mouth();
     if (live) {
      const V = TCS.VISEMES[live.shape === "st" ? "etc" : live.shape] || TCS.VISEMES.aa, o = live.open;
      Rv.mo = Math.max(0, Rv.mo + (live.shape === "mbp" ? -.3 * (1 - o) : (V.mo || 0) * .4 + o * .75)); Rv.mr += (V.mr || 0) * Math.min(1, o * 1.6); Rv.mw += (V.mw || 0) * Math.min(1, o * 1.6);
      Rv.teeth = Math.max(Rv.teeth, (V.teeth || 0) * Math.min(1, o * 2)); Rv.tongue = Math.max(Rv.tongue, (V.tongue || 0) * o);
      if (live.shape !== speech.vis) { speech.vis = live.shape; speech.hooks.onViseme && speech.hooks.onViseme(live.shape === "st" ? "etc" : live.shape); }
     }
     const VS = live ? [] : (P.vis || []);
     let vi = -1; for (let i = 0; i < VS.length; i++) if (st >= VS[i].t) vi = i; else break;
     if (vi >= 0 && st < VS[vi].t + VS[vi].d + .12) {
      const cv = VS[vi], nv = VS[vi + 1], u = clamp((st - cv.t) / cv.d, 0, 1), bl = nv && nv.t - (cv.t + cv.d) < .08 ? ease(ramp(u, .66, 1)) : 0;
      const A1 = TCS.VISEMES[cv.v], A2 = nv ? TCS.VISEMES[nv.v] : A1, g = (k) => lerp(A1[k] || 0, A2[k] || 0, bl);
      Rv.mo = Math.max(0, Rv.mo + g("mo")); Rv.mr += g("mr"); Rv.mw += g("mw"); Rv.teeth = Math.max(Rv.teeth, g("teeth")); Rv.tongue = Math.max(Rv.tongue, g("tongue"));
      if (cv.v !== speech.vis) { speech.vis = cv.v; speech.hooks.onViseme && speech.hooks.onViseme(cv.v); }
     } else if (!VS.length && !live) { Rv.mo += env * .62 * (1 - shape * .3); Rv.mr += env * shape * .7; Rv.mw += env * .08 * (1 - shape); }
     // prosody: loud syllables lift the head a little and nudge the brows
     Rv.lift -= env * 2.2 * A; Rv.bo = Math.max(Rv.bo, env * .35 * A); Rv.by -= env * 2 * A;
     if (st > P.end + .25) { const d = speech.done, h = speech.hooks; speech = null; h.onEnd && h.onEnd(); d && d(); }
    }
    moving = true;
   }
   if (reduced) { for (const k of ["lift", "lean", "tilt", "yaw", "pitch"]) Rv[k] = cur[k]; }
   Rv.sx = clamp(Rv.sx, .8, 1.25); Rv.sy = clamp(Rv.sy, .8, 1.25);

   // secondary motion: appendages lag behind the body's movement on a loose spring
   const drive = Rv.tilt + Rv.lean + Rv.yaw * 22, driveY = Rv.lift;
   if (!snap && dt > 0) {
    sec.vx += -(drive - sec.px) * 26; sec.vy += -(driveY - sec.py) * 20;
    sec.vx += (-120 * sec.x - 9 * sec.vx) * dt; sec.vy += (-120 * sec.y - 9 * sec.vy) * dt;
    sec.x += sec.vx * dt; sec.y += sec.vy * dt; sec.px = drive; sec.py = driveY;
    if (Math.abs(sec.x) + Math.abs(sec.y) + Math.abs(sec.vx) + Math.abs(sec.vy) > .05) moving = true; else sec.x = sec.y = sec.vx = sec.vy = 0;
   }

   // body
   const pal = ch.palette ? ch.palette(Rv, expr) : ch.pal;
   if (ch.palette) { const key = pal.base + pal.light + pal.dark; if (key !== dyn) { dyn = key; L.stops[0].setAttribute("stop-color", pal.light); L.stops[1].setAttribute("stop-color", pal.base); L.stops[2].setAttribute("stop-color", pal.dark); } }
   const ctx = {t: now / 1000, uid, sec, pal, R: Rv, expr, proj: projector(ch.face.R, ch.face.curv ?? 1, clamp(Rv.yaw, -(ch.face.yawMax ?? 2), ch.face.yawMax ?? 2), Rv.pitch)};
   B = ch.body(Rv, ctx);
   const f = ch.face, sxF = Rv.sx, syF = Rv.sy;
   F = {uid, R: f.R, curv: f.curv ?? 1, cx: 0, cy: B.cy + f.y * syF, ex: f.ex * sxF, eyY: f.eyY * syF, ew: f.ew, eh: f.eh, mY: f.mY * syF, mw: f.mw * sxF, bg: f.bg ?? 10, bw: f.bw, yawMax: f.yawMax ?? 2, noFace: !!ch.noFace, chained: !!ch.attach, lastEyes: F && F.lastEyes};
   L.clip.setAttribute("d", B.d);
   // rim light on the shadow side, a soft highlight on the light side, occlusion at the base
   const yawS = Rv.yaw * B.hw * .35;
   const rim = `<path d="${B.d}" fill="${pal.rim}" opacity="${pal.rimO ?? .55}"/><path d="${B.d}" fill="url(#bg${uid})" transform="translate(${f1(-3.5 - Rv.yaw * 2)} -4)"/>`;
   const hi = `<ellipse cx="${f1(-B.hw * .36 - yawS)}" cy="${f1(B.top + B.h * .22)}" rx="${f1(B.hw * .42)}" ry="${f1(B.h * .2)}" fill="url(#hl${uid})" transform="rotate(-24 ${f1(-B.hw * .36 - yawS)} ${f1(B.top + B.h * .22)})"/>`;
   const core = `<ellipse cx="${f1(B.hw * .5 - yawS)}" cy="${f1(B.cy + B.h * .3)}" rx="${f1(B.hw * .85)}" ry="${f1(B.h * .45)}" fill="url(#cs${uid})" opacity=".55"/>`;
   const tint = (Rv.flush > .02 ? `<rect x="-200" y="${f1(B.top)}" width="400" height="${f1(B.h)}" fill="url(#fl${uid})" opacity="${f1(clamp(Rv.flush, 0, 1))}"/>` : "")
    + (Rv.gloom > .02 ? `<rect x="-200" y="${f1(B.top)}" width="400" height="${f1(B.h)}" fill="url(#gl${uid})" opacity="${f1(clamp(Rv.gloom, 0, 1) * .45)}"/>` : "");
   // where a sleeve passes behind the edge, the plain body fill covers the rim highlight (no light seam beside the sleeve)
   put(L.bd, rim + `<g mask="url(#rc${uid})"><path d="${B.d}" fill="url(#bg${uid})"/></g>` + (B.body || "") + core + hi + tint);
   if (L.rcEdge) L.rcEdge.setAttribute("d", B.d);
   const back = B.back || "";
   const face = ch.noFace ? {svg: "", eyes: drawFace(Rv, F, pal, now / 1000, spinT).eyes} : drawFace(Rv, F, pal, now / 1000, spinT);
   F.lastEyes = face.eyes;
   put(L.fc, (B.faceUnder || "") + face.svg + (ch.over ? ch.over(Rv, ctx, F) : ""));
   put(L.fr, B.front || "");
   // contact shadow and the glow behind her
   const lift = Rv.lift, ls = clamp(1 + lift / 90, .45, 1.1);
   put(L.sh, `<ellipse cx="${f1(Rv.lean * 1.2)}" cy="${GROUND + 2}" rx="${f1(B.hw * 1.02 * ls)}" ry="${f1(10 * ls)}" fill="url(#gs${uid})" opacity="${f1(.9 * ls)}"/>`);
   put(L.glow, Rv.glow > .03 ? `<circle cx="0" cy="${f1(GROUND + B.cy)}" r="${f1(B.hw * 1.45)}" fill="url(#gw${uid})" opacity="${f1(clamp(Rv.glow, 0, 1))}"/>` : "");
   L.w.setAttribute("transform", `translate(0 ${f1(GROUND + lift)}) rotate(${f1(Rv.lean)}) translate(0 ${f1(B.cy)}) rotate(${f1(Rv.tilt)}) scale(${f1(Rv.zoom * 1000) / 1000}) translate(0 ${f1(-B.cy)})`);
   L.fx.setAttribute("transform", `translate(0 ${f1(GROUND + lift)})`);

   // props and hands: a gesture's hands win over a prop's, a prop's over the expression's
   const pr = TCS.propDraw(props, now, B, F, Rv, face.eyes, pal);
   for (const k in props) if (props[k].out && now - props[k].out > 400) delete props[k];
   // a hand that holds something keeps doing what the prop needs; a passing gesture never takes it away
   for (const s of ["L", "R"]) if (pre.hands[s] && (!handReq[s] || pr.held[s] || pr.held.both)) handReq[s] = pre.hands[s];
   const ed = (ch.exprHands && ch.exprHands[expr]) || E[expr].hands; if (ed) for (const s of ["L", "R"]) if (!handReq[s] && ed[s]) handReq[s] = ed[s];
   for (const id in props) { const st = props[id]; if (st.k && st.k.flash && !st.flashed) { st.flashed = true; spawn("flash"); } if (!st.use) st.flashed = false; }
   let hs = "", both = "", backHands = "", overs = "", rimCut = "";
   const LS = ch.limbs || {limb: "arms", shoulderY: .58, armLen: .38, hand: 1.2, reach: ["chest", "face", "head"]};
   // stub arms cannot reach round to hold a two-handed object below the mouth, so for that the hands float free
   // a body whose mouth sits too low to hold a two-handed object below it carries the object beside it instead
   const bothRoom = pr.held.both && pr.held.both.grip ? (-6 - (F.cy + F.mY + F.mw * .35 + 4)) / ((pr.held.both.grip.top || 40) * .55) : 1;
   const besideBody = bothRoom < 1;
   // stub arms cannot reach round a two-handed object, so for that the hands float free (as they do beside the body)
   const floatMode = handMode === "float" || LS.limb === "float" || LS.limb === "none" || (!!(pr.held.both && pr.held.both.grip) && (LS.limb === "stub" || besideBody));
   const prof = profileOf(ch), hScale = B.h / prof.h, wScale = B.hw / prof.hw;
   const edgeAt = (side, y) => { const f = clamp(-y / B.h, 0, 1) * (prof.n - 1), i = Math.floor(f), t = f - i, xs = side > 0 ? prof.R : prof.L; return side * lerp(xs[i], xs[Math.min(prof.n - 1, i + 1)], t) * wScale; };
   // the character's own eye spacing at rest, not this frame's (a head turn or squint must not resize her hands)
   const eyeSpan = 2 * Math.abs((ch.face && ch.face.ex) || 30);
   // a hand is never wider than 0.6 × her eye spacing (an open hand is about 30 units across at scale 1)
   // a hand is never wider than 0.6 × her eye spacing (a fist is 19 units wide at scale 1); floating hands sit at that size
   const handS = F.handS = floatMode ? .6 * eyeSpan / HAND_REF : Math.min((LS.hand || 1.2) * 1.25, .72 * eyeSpan / HAND_REF), Lfull = Math.max(30, B.h * (LS.armLen || .36));
   // two-handed props: the object sits at the "both" spot; each hand goes to its own grip point on it
   const bothG = pr.held.both && pr.held.both.grip;
   let bothPos = null;
   // the object sits below the mouth: its top (its height above the grip line) clears the lips
   if (pr.held.both) { const sp = spot("both", 1, B, F, ch), heavy = bothG && bothG.weight === "heavy", mb = F.cy + F.mY + F.mw * .35 + 4; const shY0 = -B.h * (LS.shoulderY || .58), reachY = floatMode ? -B.h * .2 : Math.min(-14, shY0 + Lfull * .9), top = (bothG && bothG.top) || 40;
    bothPos = [0, Math.min(reachY, Math.max(sp[1] + (heavy ? 8 : 0), mb + top * 1.12))]; bothPos.s = clamp((bothPos[1] - mb) / top, .38, 1.12);
    // short arms (a stub, a low face): the object stays below the mouth and the hands hold it as low as they can reach
    if (bothPos.s < .65) { bothPos[1] = Math.min(-6, mb + top * .65); bothPos.s = .65; }
    if (besideBody) { bothPos[0] = B.hw + top * .45; bothPos[1] = Math.min(-8, B.cy + B.h * .35); bothPos.s = .75; } }
   const zoneOf = (n) => /^(chin|mouth|sip|snack|cheek|ear|eye|face|bridge|temple|monocleRim|monoKey|underChin|wag)$/.test(n) ? "face" : /^(head|up|overhead|raise)$/.test(n) ? "head" : "chest";
   const lean = {v: 0};
   for (const s of ["L", "R"]) {
    const side = s === "L" ? -1 : 1, h = hands[s], hp = pr.held[s] || (pr.held.both && bothG ? pr.held.both : null);
    let q = handReq[s];
    if (ch.noHands && !pr.held[s]) continue;
    // a floating hand has no arm to put behind the back: it simply goes away
    if (floatMode && q && /^(behind|cross)$/.test(q[0])) q = null;
    // the shoulder sits on this character's silhouette edge at its own height (limb spec); nowhere else
    // the shoulder sits inside the silhouette edge by most of a sleeve width, so the sleeve root never shows on the edge
    const shIn = 18.8 * (LS.thick || 1) * handS, shY = -B.h * (LS.shoulderY || .58), shX = edgeAt(side, shY) - side * shIn;
    // a gesture this body cannot reach becomes its substitute: a small raised hand at the upper chest, and a lean
    let zone = q ? zoneOf(q[0]) : "rest", sub = false;
    if (q && !floatMode && LS.reach && !LS.reach.includes(zone)) { sub = true; q = zone === "face" ? ["cheekSide", "back"] : ["subHigh", /^(thumb|point|count2|count3)$/.test(q[1]) ? q[1] : "open", 0, q[3] || 0, 0, 0, 1, 0, 0, q[9]]; lean.v += side * -3; zone = "chest"; }
    // at rest the arm hangs from the shoulder along her side, nearly straight, the hand against the hip
    // at rest: the upper arm hangs down along her side, the forearm bends a little forward and the hand rests on the
    // hip, inside the outline (elbow always below the shoulder)
    const restY = Math.min(-B.h * .2, shY + Lfull * .75), rest = floatMode ? [side * B.hw * .7, 80] : [side * (Math.max(Math.abs(edgeAt(side, restY)), Math.abs(edgeAt(side, restY + 14 * handS))) + 13 * handS), restY]; // resting: the hand hangs just outside her side, above the hem
    let tx, ty, tr, ts = handS * (floatMode ? 1 : 1), pose;
    if (pr.held.both && bothG) {
     const g = bothG[s], k = bothPos.s || 1.12; tx = bothPos[0] + g[0] * k; ty = bothPos[1] + g[1] * k + 6; tr = side * 6; pose = bothG.shape; zone = "chest";
    } else if (q) {
     // body-relative poses are authored from the shoulder, in arm lengths (outward, down), so every body gets its own
     const REL = {up: [.55, -.78, 18], raise: [.45, -.55, 6], present: [.55, .12, 10], beat: [.5, .22, 4], shrug: [.72, -.08, 70], wag: [.42, -.62, 0], side: [.15, .78, 12], fistlow: [.22, .7, 10], hips: [.12, .5, -35], chestFront: [-.42, .42, -4], overhead: [.05, -.95, -12], subHigh: [.3, .15, -10]};
     const Lnom = floatMode ? B.h * .4 : Lfull * (LS.limb === "stub" ? .8 : 1), rel = LS.limb === "stub" && q[0] === "shrug" && !floatMode ? [.35, -.25, 50] : REL[q[0]]; // stubs shrug with palms up beside the body, not stretched out
     let sp = rel ? [shX + side * rel[0] * Lnom, shY + rel[1] * Lnom, side * rel[2], 1] : spot(q[0], side, B, F, ch, q);
     // floating hands stay close to the body: just outside its edge at the gesture's height, never off in the corners
     if (floatMode && rel) { const yy = clamp(shY + rel[1] * B.h * .5, -B.h * .92, -14); sp = [edgeAt(side, yy) + side * (14 + Math.max(0, rel[0]) * 10) * handS, yy, side * rel[2], 1]; }
     // a thumbs-up sits below the mouth, in front of the chest; with floating hands, beside the body
     if (q[0] === "chestFront") { const below = F.cy + F.mY + F.mw * .35 + 30; sp = floatMode ? [side * (B.hw + 14), Math.min(-14, F.cy + F.mY + 6), side * -4, 1] : [side * (Math.abs(edgeAt(side, F.cy + F.mY)) + 12 * handS), F.cy + F.mY, side * -4, 1]; } // on an arm: beside the body at mouth height, in clear space
     tx = sp[0] + (q[2] || 0) * side; ty = sp[1] + (q[3] || 0); tr = sp[2] + (q[4] || 0) * side; pose = q[1] || "open";
    } else if (floatMode) { tx = h.x; ty = h.y + 8; tr = h.r; pose = h.pose || "open"; ts = handS * .55; } // leaving: it pops out where it is (shrinks fast, then is gone)
    else { [tx, ty] = rest; tr = side * 168; pose = "relax"; }
    // floating fists over the head clear ears, flanges and needles: well above the top, not on it
    // a floating hand at the head sits against the side of the head (clear of ears, flanges and needles on top)
    if (floatMode && q && q[0] === "head") { if ((q[3] || 0) < -10) { const yy = B.top + B.h * .1; tx = edgeAt(side, yy) + side * 18 * handS; ty = yy - 4; } else { const yy = B.top + B.h * .28 + (q[3] || 0); tx = edgeAt(side, yy) + side * 4 * handS; ty = yy; } }
    // floating hands stay inside the character's own space, never out past its sides
    if (floatMode && q) {
     tx = clamp(tx, -Math.min(B.hw + 26 * handS, 136), Math.min(B.hw + 26 * handS, 136)); if (!q[5] && !hp) ty = Math.min(ty, -16 * handS);
    }
    // chest gestures stay below the face: a hand in front of the face area drops below the mouth, or, on a body
    // whose face sits low (a loaf, a stone), moves out beside the face instead
    if (zone === "chest" && !(pr.held.both && bothG) && q && !/^(behind|cheek|heart|hug|tie|steeple|underChin|cuff[LR]|mono[A-Z]\w*|watchKey)$/.test(q[0]) || (q && /^(heart|hug)$/.test(q[0]))) {
     // margins from the hand's own size (fingers reach about 18 × scale above the palm centre), so no part of it covers the face
     const faceHalf = Math.abs(F.ex) + F.ew * .8, mouthBot = F.cy + F.mY + F.mw * .35 + 6 + 20 * handS;
     const eyeTop = F.cy + F.eyY - F.eh * .8;
     if (Math.abs(tx) < faceHalf + 12 * handS && ty > eyeTop - 12 && ty < mouthBot) { if (mouthBot < -B.h * .12) ty = mouthBot; else if (!floatMode) tx = side * (Math.abs(edgeAt(side, ty)) + 6 * handS); else { const E2 = F.lastEyes || [], out = Math.max(faceHalf, ...E2.map((e) => Math.abs(e.cx) + e.W * .5)); tx = side * (out + 16 * handS + 6); } } // on an arm, beside the body (a short arm can reach that)
    }
    // floating hands keep off the character's own badges and trims (its keep-out circles); so do arm hands where the
    // character asks (Alfred's resting monocle), except on an authored path that has to reach it
    // two passes over the keep-out circles, so neighbouring ones settle instead of pushing the hand back and forth
    if (q && !q[5] && (floatMode || ch.keepArms)) for (const [kx, ky, kr, ok] of ch.keep ? [...ch.keep(B), ...ch.keep(B)] : []) { if (ok && new RegExp(`^(${ok})$`).test(q[0])) continue; const dx = tx - kx, dy = ty - ky, d = Math.hypot(dx, dy), m = kr + 13 * handS; if (d < m) { const ux = d > .5 ? dx / d : Math.sign(kx) || 1, uy = d > .5 ? dy / d : 0; tx = kx + ux * m; ty = ky + uy * m; } }
    if (pr.held.both && bothG) pose = sidePose(pose, "back"); else if (q && pose) pose = sidePose(pose, SIDE[q[0]]);
    if (hp && hp.grip && !(pr.held.both && bothG)) { pose = sidePose(hp.grip.shape, "back"); if (ch.gentleman && hp.id === "tea") pose = "teacup"; if (hp.grip.weight === "heavy") { ty += 10; lean.v += side * -2; } }
    h.pose = pose;
    // a whole floating hand stays inside the frame (the view is 320 wide), with room for lean and zoom
    if (floatMode && q && ts) { const half = handW(pose) * ts / 2 + 10; tx = clamp(tx, -160 + half, 160 - half); }
    // a prop arrives with the wrist already turned to hold it, so it never swings upside down on the way in
    if (pr.held[s] && pr.held[s].enter > .85) { h.r = tr; h.vr = 0; }
    if (!h.vis) { if (floatMode && !q && !hp) continue; h.vis = true; Object.assign(h, floatMode ? {x: tx, y: ty + 8, r: tr - side * 12, s: ts * .6} : {x: rest[0], y: rest[1], r: side * 172, s: ts}); h.vx = h.vy = h.vr = h.vs = 0; } // a floating hand pops in at its pose (60 % to full size, opaque, about 0.12 s), never fades
    // on an arm, a target out of reach (or too close to the shoulder) is moved to the edge of reach before the spring,
    // so the hand eases there instead of the arm snapping it back
    if (!floatMode && !(q && q[5]) && ts) { const a1 = tr * PI / 180, ox = Math.sin(a1) * 11 * ts, oy = -Math.cos(a1) * 11 * ts, vx = tx - ox - shX, vy = ty - oy - shY, dv = Math.hypot(vx, vy) || 1, k3 = clamp(dv, Lfull * .32, Lfull * .97) / dv; if (k3 !== 1) { tx = shX + vx * k3 + ox; ty = shY + vy * k3 + oy; } }
    if (!floatMode && zone === "chest" && q && !q[5] && !/^(behind|tie|steeple|underChin|cuff[LR]|mono[A-Z]\w*|watchKey)$/.test(q[0])) {
     const faceHalf = Math.abs(F.ex) + F.ew * .8, eyeTop = F.cy + F.eyY - F.eh * .8, mouthLow = F.cy + F.mY + F.mw * .35 + 6 + 18 * handS;
     if (Math.abs(tx) < faceHalf + 20 * handS && ty > eyeTop - 12 && ty < mouthLow + 12 * handS) { ty = shY + Lfull * .45; tx = side * (Math.abs(edgeAt(side, ty)) + 5 * handS); } // a short arm cannot get below a low face: beside the body
    }
    const px0 = h.x, py0 = h.y;
    // an authored path: a floating hand grows in on it; a hand on an arm keeps its size, blends from its spring onto the
    // path as the path fades in (q[6]); its speed is capped below (what it carries rides it)
    if (q && q[5] && !floatMode) {
     h.vis = true; const w = q[6] ?? 1; h.capUntil = now + 1200;
     if (stepHand(h, tx, ty, tr, ts, dt)) moving = true;
     h.x = lerp(h.x, tx, w); h.y = lerp(h.y, ty, w); h.r = lerp(h.r, tr, w); h.s = ts;
    }
    else if (q && q[5]) { h.vis = true; h.capUntil = now + 1200; h.x = tx; h.y = ty; h.r = tr; const g = q[6] ?? 1; h.s = ts * (.6 + .4 * g); h.vx = h.vy = h.vr = h.vs = 0; } // on its path it pops in (60 % to full size) where it is needed, never fades
    else if (snap || ch.noHands) { h.x = tx; h.y = ty; h.r = tr; h.s = ts; }
    else if (stepHand(h, tx, ty, tr, ts, dt * (hp && hp.grip && hp.grip.weight === "heavy" ? .6 : !q && !hp ? .6 : 1))) moving = true; // heavy props and returns to rest are slower (slow out)
    // a hand on (or just off) an authored path, or carrying a prop on an arm, is speed-capped by the wall clock, 3.7 units
    // per 30 fps frame: what it carries rides it (a teacup never swings), and it leaves slowly (slow out)
    if (!(floatMode && q && q[5]) && (h.capUntil > now || (hp && !floatMode))) { const m = Math.hypot(h.x - px0, h.y - py0), cap = 110 * clamp((now - (h.capT || now)) / 1000, 1 / 240, 1 / 30); if (m > cap) { h.x = px0 + (h.x - px0) * cap / m; h.y = py0 + (h.y - py0) * cap / m; moving = true; } }
    h.capT = now;
    if (floatMode && !q && !hp && h.s < handS * .62) { h.vis = false; continue; }
    if (q && q[5] && floatMode && (q[6] ?? 1) < .05) continue;
    // hands in the character's own material and outline; a gentleman wears white gloves
    const edge = pal.edge || pal.dark, flat = ch.gentleman ? "#fbfaf6" : ch.handFill ? ch.handFill(pal) : null;
    const look = ch.gentleman ? {stops: ["#ffffff", "#f3efe7", "#cfc8ba"], edge: "#9a8e7b", glove: true}
     : {stops: flat ? [mixHex(flat, "#ffffff", .3), flat, mixHex(flat, pal.dark, .35)] : [pal.light, pal.base, pal.dark], edge};
    let hr = h.r, hx = h.x, hy = h.y, arm = "", armBack = "", meta = "";
    if (!floatMode) {
     // two-bone reach from the fixed shoulder; the elbow bends out and down (pole), bend 0–150°, and never pokes more
     // than a quarter of the body's width beyond its silhouette; a hand asked to go further stops where it can reach
     const a0 = hr * PI / 180;
     let wx = hx - Math.sin(a0) * 11 * h.s, wy = hy + Math.cos(a0) * 11 * h.s;
     // one arm length per character, always (targets are clamped to its reach before the spring, below)
     const Leff = Lfull;
     const ua = Leff * .5, fa = Leff * .5, dMin = Math.sqrt(ua * ua + fa * fa - 2 * ua * fa * Math.cos(30 * PI / 180));
     // the hand is the target and never moves for the arm (moving it made the hand, and what it carries, jump): out of
     // reach the arm stretches a little; too close, the bend stops at 150° and the curve simply ends at the wrist; an
     // elbow past its limit is pulled in to the limit rather than swapped for the other solution
     const dx = wx - shX, dy = wy - shY, d = Math.hypot(dx, dy) || 1, dk = clamp(d, dMin, Leff * .98), k2 = clamp(d / (Leff * .98), 1, 1.08);
     const ua2 = ua * k2, fa2 = fa * k2, th = Math.atan2(dy, dx), al = Math.acos(clamp((ua2 * ua2 + dk * dk - fa2 * fa2) / (2 * ua2 * dk), -1, 1));
     const e1 = [shX + ua2 * Math.cos(th + al), shY + ua2 * Math.sin(th + al)], e2 = [shX + ua2 * Math.cos(th - al), shY + ua2 * Math.sin(th - al)];
     // the elbow bends out and down: for the face and head out first (the forearm comes in from the side, never a strap
     // across the face); in front of the chest, and to bring something to the mouth, down first (the forearm rises in front)
     const toMouth = !!hp || (q && /^(sip|snack|mouth|chin|underChin)$/.test(q[0])), face = (zone === "face" || zone === "head") && !toMouth, score = face ? (e) => side * e[0] + .3 * e[1] : (e) => .6 * side * e[0] + e[1];
     let elbow = score(e1) >= score(e2) ? e1 : e2;
     // a composed character keeps his elbows in, except to reach the face or head (else the arm straps across the face)
     const eOut = face ? Math.max(LS.elbowOut ?? .25, .45) : LS.elbowOut ?? .25, elim = Math.abs(edgeAt(side, clamp(elbow[1], -B.h, 0))) + B.hw * eOut;
     if (Math.abs(elbow[0]) > elim) elbow = [Math.sign(elbow[0]) * elim, elbow[1]];
     let bend = 180 - (Math.acos(clamp((ua2 * ua2 + fa2 * fa2 - dk * dk) / (2 * ua2 * fa2), -1, 1)) * 180 / PI);
     // at rest the upper arm hangs DOWN along her side from the shoulder: the elbow is placed on the outline, below the
     // shoulder near the waist, and the forearm comes slightly forward to the hand at the hip
     if (!q && !hp) { const ey = shY + Math.max(8, (wy - shY) * .5); elbow = [side * (Math.max(Math.abs(edgeAt(side, ey)), Math.abs(edgeAt(side, wy))) + 13 * handS), ey]; bend = 25; } // it hangs clear of the body: the elbow outside the widest point below the shoulder // a slight outward bend: it hangs, it is not a bracket
     // follow-through: the elbow trails the solution on its own spring, so a pose change or an elbow switching sides
     // never snaps, and the forearm leads the upper arm
     if (!h.el || snap) h.el = {x: elbow[0], y: elbow[1], vx: 0, vy: 0};
     else { const ke = 260, ce = 2 * .9 * Math.sqrt(ke); for (const [p, v, t] of [["x", "vx", elbow[0]], ["y", "vy", elbow[1]]]) { h.el[v] += (ke * (t - h.el[p]) - ce * h.el[v]) * dt; h.el[p] += h.el[v] * dt; } if (Math.hypot(elbow[0] - h.el.x, elbow[1] - h.el.y) > .2) moving = true; }
     elbow = [Math.sign(h.el.x) * Math.min(Math.abs(h.el.x), Math.abs(edgeAt(side, clamp(h.el.y, -B.h, 0))) + B.hw * eOut), h.el.y]; // the trailing elbow keeps the same limit
     hx += wx - (h.x - Math.sin(a0) * 11 * h.s); hy += wy - (h.y + Math.cos(a0) * 11 * h.s);
     // a pointing finger lines up with the forearm (except resting on the chin or the glasses bridge)
     if (/^point(Edge)?$/.test(pose) && q && q[0] === "toL") { hr = Math.atan2(wx - elbow[0], -(wy - elbow[1])) * 180 / PI; hx = wx + Math.sin(hr * PI / 180) * 11 * h.s; hy = wy - Math.cos(hr * PI / 180) * 11 * h.s; }
     // (the front copy is hidden over the body only along the first fifth of the arm, never by a circle round the
     // shoulder: a forearm coming back over the head near the shoulder must stay whole)
     // a sleeve: one round-joined stroke along the shoulder-elbow-wrist curve (never kinks or spikes at any bend), its
     // width set by the hand (about 0.55 of an open hand), drawn in front; near the shoulder it is hidden where it overlaps
     // the body, so it grows out from under the silhouette edge. With the elbow outside the body the whole upper arm is
     // hidden over the body (it comes from behind the edge); with the elbow inside, the arm crosses in front
     const ws = 14.5 * (LS.thick || 1) * h.s, W0 = ws * 1.8, Cp = [], N = 20;
     for (let i = 0; i <= N; i++) { const t = i / N, mt = 1 - t; Cp.push([mt * mt * shX + 2 * t * mt * elbow[0] + t * t * wx, mt * mt * shY + 2 * t * mt * elbow[1] + t * t * wy]); }
     const elbowOut = !!(q || hp) && !toMouth && !(q && /^(watchKey|face)$/.test(q[0])) && Math.abs(elbow[0]) > Math.abs(edgeAt(side, clamp(elbow[1], -B.h, 0))); // at rest the sleeve hangs visibly
     const cd = "M" + Cp.map((p) => `${f1(p[0])} ${f1(p[1])}`).join("L"), sc = ch.sleeve || pal.base, se = ch.sleeveEdge || edge, mk = `am${uid}${s}`;
     // a soft sleeve, tapered from 1.8 × a hand-scaled width at the shoulder to about 1 × at the cuff, as ten overlapping
     // stroke segments (all outlines first, then all fills, so it reads as one figure), one soft shade along its length
     const K = 10, seg = (k) => "M" + Cp.slice(k * N / K, (k + 1) * N / K + 1).map((p) => `${f1(p[0])} ${f1(p[1])}`).join("L"), wk = (k) => W0 * (k === 0 ? .86 : lerp(1, .58, k / (K - 1)));
     const st = (c, dw, o = "", kw = 1) => Array.from({length: K}, (_, k) => `<path d="${seg(k)}" fill="none" stroke="${c}" stroke-width="${f1(wk(k) * kw + dw)}" stroke-linecap="${k ? "round" : "butt"}" stroke-linejoin="round"${o}/>`).join(""); // the root segment ends flat: no lobe past the shoulder
     const ms = `as${uid}${s}`, tube = `<mask id="${ms}" maskUnits="userSpaceOnUse" x="-200" y="-260" width="400" height="360">${st("#fff", -2.2)}</mask>`
      + `<g mask="url(#${ms})">${st(mixHex(sc, "#000000", .3), 0, ` opacity=".4" transform="translate(${f1(W0 * .28)} ${f1(W0 * .26)})"`, .75)}${ch.sleeveHi ? st(mixHex(sc, "#ffffff", .5), 0, ` opacity="${ch.sleeveHi}" transform="translate(${f1(-W0 * .3)} ${f1(-W0 * .32)})"`, .3) : ""}</g>`;
     // a shirt cuff at the wrist (and a cuff link), where the style has one
     const core = st(mixHex(sc, "#ffffff", .12), 0, "", .55), cf = ch.cuff || {fill: pal.rim || mixHex(pal.base, "#ffffff", .6), edge}, cuffSvg = cf ? (() => { const band = "M" + Cp.slice(N - 2).map((p) => `${f1(p[0])} ${f1(p[1])}`).join("L"), w = wk(K - 1) + 1.5, e = Cp[N - 1]; return `<path d="${band}" fill="none" stroke="${cf.edge}" stroke-width="${f1(w + 1.8)}" stroke-linecap="butt"/><path d="${band}" fill="none" stroke="${cf.fill}" stroke-width="${f1(w)}" stroke-linecap="butt"/>${cf.link ? `<circle cx="${f1(e[0])}" cy="${f1(e[1])}" r="${f1(1.6 * h.s)}" fill="${cf.link}" stroke="#a86f2a" stroke-width=".6"/>` : ""}`; })() : "";
     meta = ` data-ox="${f1(shX)}" data-oy="${f1(shY)}" data-ax="${f1(edgeAt(side, shY) - side * shIn)}" data-ay="${f1(-B.h * (LS.shoulderY || .58))}" data-bend="${f1(bend)}" data-ex="${f1(elbow[0])}" data-elim="${f1(Math.abs(edgeAt(side, clamp(elbow[1], -B.h, 0))) + B.hw * eOut)}" data-hy="${f1(hy)}" data-hem="0" data-bh="${f1(B.h)}" data-zone="${zone}" data-spot="${q ? q[0] : ""}" data-ey="${f1(elbow[1])}" data-sub="${sub ? 1 : 0}" data-pose="${pose}" data-hr="${f1(hr)}" data-side="${side}"`;
     arm = `<mask id="${mk}" maskUnits="userSpaceOnUse" x="-200" y="-260" width="400" height="360"><rect x="-200" y="-260" width="400" height="360" fill="#fff"/><g clip-path="url(#cl${uid})"><path d="M${Cp.slice(0, Math.round(N * .2) + 1).map((p) => `${f1(p[0])} ${f1(p[1])}`).join("L")}" fill="none" stroke="#000" stroke-width="${f1(W0 + 6)}" stroke-linecap="round"/>${elbowOut ? `<path d="M${Cp.slice(0, N / 2 + 1).map((p) => `${f1(p[0])} ${f1(p[1])}`).join("L")}" fill="none" stroke="#000" stroke-width="${f1(W0 + 6)}" stroke-linecap="round"/>` : ""}</g></mask>`
      + `<g data-l="arm"${meta} mask="url(#${mk})">${st(se, 2)}${st(mixHex(sc, "#ffffff", .42), -1)}${st(sc, -3)}${core}${tube}${cuffSvg}</g>`;
     // the same sleeve behind the body: near the shoulder only this copy shows, so the sleeve comes out from under the
     // body's own edge (no glued-on tube, no gap), with a soft shade where it tucks under
     rimCut += st("#fff", 4);
     armBack = `<g data-l="arm-back"><radialGradient id="rs${uid}${s}" gradientUnits="userSpaceOnUse" cx="${f1(shX)}" cy="${f1(shY)}" r="${f1(W0 * 1.3)}"><stop offset="0" stop-color="#000" stop-opacity=".38"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>${st(se, 1.6)}${st(sc, -1.6)}${core}<g mask="url(#${ms})"><circle cx="${f1(shX)}" cy="${f1(shY)}" r="${f1(W0 * 1.3)}" fill="url(#rs${uid}${s})"/></g></g>`;
    } else { meta = ` data-zone="${zone}" data-spot="${q ? q[0] : ""}" data-pose="${pose}" data-hr="${f1(hr)}" data-hy="${f1(hy)}" data-bh="${f1(B.h)}" data-side="${side}"`; }
    h.dx = hx - h.x; h.dy = hy - h.y;
    // the held prop sits on the hand exactly at its grip point; it rises from below the frame (or out of a pocket)
    // on the way in and is lowered back out of frame on the way out, so it never pops in or out
    let propSvg = "";
    const own = pr.held[s];
    if (own) {
     const g = own.grip || {pt: [0, 0]}, from = g.from === "pocket" && ch.attach ? [B.hw * .58, -B.h * .35] : [hx, 70];
     const ent = own.enter > .02 ? own.enter : 0, ox = (from[0] - hx) * ent, oy = (from[1] - hy) * ent + 90 * own.exit;
     // the prop keeps its own allowed orientation (a cup stays upright) unless a use tilts it
     const wrap = ((hr % 360) + 540) % 360 - 180, pRot = own.use ? hr : (g.rot ? clamp(wrap, g.rot[0], g.rot[1]) : hr);
     propSvg = `<g data-l="prop" data-p="${own.id}" data-u="${own.use || ""}" data-phase="${own.enter > .02 ? "enter" : own.exit > .02 ? "exit" : "held"}" data-gx="${f1(hx + ox)}" data-gy="${f1(hy + oy)}" data-hx="${f1(hx)}" data-hy="${f1(hy)}" data-rot="${f1(pRot)}" data-rmin="${g.rot ? g.rot[0] : -180}" data-rmax="${g.rot ? g.rot[1] : 180}" transform="translate(${f1(hx + ox)} ${f1(hy + oy)}) rotate(${f1(pRot)}) scale(${f1(h.s * 100) / 100})"><g transform="scale(${side} 1) translate(${-g.pt[0]} ${-g.pt[1]})">${own.svg}</g></g>`;
    }
    let one = arm + propSvg;
    if (!ch.noHands) one += `<g data-hand="${s}" data-hs="${Math.round(h.s * 100) / 100}"${Math.abs(h.s - ts) > .01 ? " data-settling" : ""}${floatMode && (!q && !hp || h.y > 20) ? " data-leaving" : ""}${meta} transform="translate(${f1(hx)} ${f1(hy)}) rotate(${f1(hr)}) scale(${f1(h.s * 100) / 100})"><g transform="scale(${side} 1)">`
     + renderHand(pose, look, side, uid) + `</g></g>`;
    // parts drawn over what the hand holds (the thumb over a watch in the palm) go above everything carried
    if (!ch.noHands && HANDS[pose] && HANDS[pose].over) overs += `<g transform="translate(${f1(hx)} ${f1(hy)}) rotate(${f1(hr)}) scale(${f1(h.s * 100) / 100})"><g transform="scale(${side} 1)">${renderHand(pose, look, side, uid, true)}</g></g>`;
    // a counting hand shows its number in a small bubble above it
    if (q && q[9]) one += `<g data-l="count" transform="translate(${f1(hx + side * 18 * h.s)} ${f1(hy - 26 * h.s)})"><circle r="${f1(8 * h.s)}" fill="#fffdf7" stroke="${edge}" stroke-width="1.2"/><text text-anchor="middle" dy="${f1(3.6 * h.s)}" font-size="${f1(10 * h.s)}" font-weight="700" font-family="system-ui, sans-serif" fill="${edge}">${q[9]}</text></g>`;
    if (q && q[0] === "behind") backHands += armBack + one; else { hs += one; backHands += armBack; }
    const a = hr * PI / 180, hsC = h.s;
    // a lens held up to her face shows that part of her face magnified (TABY-BREAKDOWN §1.7)
    if (own && own.lens && own.lens.k > .3) {
     const g = own.grip || {pt: [0, 0]}, lpx = (own.lens.x - g.pt[0]) * side, lpy = own.lens.y - g.pt[1];
     const lx = hx + (Math.cos(a) * lpx - Math.sin(a) * lpy) * hsC, ly = hy + (Math.sin(a) * lpx + Math.cos(a) * lpy) * hsC, lr = own.lens.r * hsC;
     hs += `<clipPath id="ln${uid}"><circle cx="${f1(lx)}" cy="${f1(ly)}" r="${f1(lr)}"/></clipPath><g clip-path="url(#ln${uid})" opacity="${f1(ramp(own.lens.k, .3, .6))}"><g transform="translate(${f1(lx)} ${f1(ly)}) scale(1.7) translate(${f1(-lx)} ${f1(-ly)})"><path d="${B.d}" fill="${pal.base}"/>${face.svg}</g></g><circle cx="${f1(lx)}" cy="${f1(ly)}" r="${f1(lr)}" fill="none" stroke="${"#E8A75A"}" stroke-width="5"/>`;
    }
    if (own && own.mark) hs += `<g transform="translate(${f1(hx - 10)} ${f1(B.cy + B.h * .48)})">${own.mark}</g>`;
   }
   if (ch.attach) {
    const H = (h) => ({x: h.x + (h.dx || 0), y: h.y + (h.dy || 0), r: h.r, s: h.s, vis: h.vis});
    const at = ch.attach({uid, now, dt: snap ? 0 : dt, R: Rv, B, F, eyes: face.eyes, hands: {L: H(hands.L), R: H(hands.R)}, acts: clips.filter((c) => now >= c.t0).map((c) => ({name: c.name, t: c.frozen !== undefined ? c.frozen : (now - c.t0) / c.dur})), reduced});
    if (at) { hs = at.svg + hs + (at.top || ""); if (at.moving) moving = true; }
   }
   if (lean.v) { L.w.setAttribute("transform", L.w.getAttribute("transform").replace(/rotate\(([-\d.]+)\)/, (m, v) => `rotate(${f1(+v + lean.v)})`)); }
   if (pr.held.both && bothPos) {
    const bh = pr.held.both, g = bh.grip || {}, enter = bh.enter || 0, exit = bh.exit || 0;
    const oy = (70 - bothPos[1]) * enter + 90 * exit;
    both = `<g data-l="prop" data-p="${bh.id}" data-u="${bh.use || ""}" data-phase="${enter > .02 ? "enter" : exit > .02 ? "exit" : "held"}" data-gx="${f1(bothPos[0])}" data-gy="${f1(bothPos[1] + oy)}" data-hx="${f1(bothPos[0])}" data-hy="${f1(bothPos[1] + oy)}" data-rot="0" data-rmin="-10" data-rmax="10" transform="translate(${f1(bothPos[0])} ${f1(bothPos[1] + oy)}) scale(${f1((bothPos.s || 1.12) * 100) / 100})">${bh.svg}</g>`;
   }
   put(L.wn, pr.worn + pr.float);
   put(L.bk, back + (backHands || ""));
   put(L.hd, pr.front + both + hs + overs);
   if (L.rc) put(L.rc, rimCut);
   if (pr.moving) moving = true;
   // effects
   fxs = fxs.filter((x) => now - x.t0 < x.dur);
   put(L.fx, fxs.length ? drawFx(fxs, now, B, F, pal) : "");
   if (fxs.length) moving = true;
   stats.frames++; frames++;
   if (opts.onFrame) opts.onFrame(Rv);
   return moving || clips.length > 0;
  }

  function onVis() { if (document.hidden) { cancelAnimationFrame(raf); running = false; } else wake(); }
  document.addEventListener("visibilitychange", onVis);
  defs(); retarget(); if (opts.expression) { expr = opts.expression; retarget(); }
  render(performance.now(), true); scheduleBlink(); scheduleIdle();

  return {
   setExpression, setPersonality, setCharacter, play, spawn, prop, use, clearProps, speak, syncSpeech, speechTime, stopSpeech, fidget,
   setIntensity(v) { intensity = v; retarget(); wake(); },
   setHandMode(m) { handMode = m === "float" ? "float" : "arms"; hands.L.vis = hands.R.vis = false; wake(); },
   get handMode() { return handMode; },
   get expression() { return expr; }, get character() { return ch.id; }, get personality() { return Object.assign({}, T); },
   get props() { return Object.keys(props).filter((k) => !props[k].out); },
   stats, redraw() { render(performance.now(), true); },
   freeze(name, t) { clips = clips.filter((c) => /link/.test(c.name)); const c = C[(ch.remap && ch.remap[name]) || name]; if (!c || (c.needs && !ch[c.needs])) return; clips.push({name, c, t0: performance.now(), dur: c.dur, a: tu.gamp, frozen: t}); wake(); },
   unfreeze() { clips = clips.filter((c) => c.frozen === undefined); wake(); },
   pocket(state) { if (ch.pocketState) { ch.pocketState(uid, state); wake(); } },
   debug() { return {clips: clips.map((c) => c.name), shaped: shaped(cur), closing: clips.some((c) => /link/.test(c.name) && !c.cut)}; },
   destroy() { destroyed = true; cancelAnimationFrame(raf); clearTimeout(blinkTimer); clearTimeout(idleTimer); document.removeEventListener("visibilitychange", onVis); },
  };
 };
})(window);
