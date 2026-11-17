/* Her body's sounds (Director, 18 Nov). Foley made the moment something happens to her, from what happened (a poke, a
 * squish, a landing at this speed) and what she is made of (TCS.PHYSICS: mass, soft, bounce), with fresh jitter every
 * time so no two are alike; and a warm bed under her presence that breathes with her mood and steps back while she talks
 * or listens. TCS.SOUND.foley and .bed are pure (samples), so a test measures them; TCS.SOUND.create plays them through
 * one master with a limiter, and lets the audio device sleep whenever nothing sounds. */
(function (g) {
 "use strict";
 const TCS = g.TCS = g.TCS || {}, TAU = Math.PI * 2;
 const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
 const rngOf = (seed) => () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

 // ── Layers: a gliding tone (with harmonics, vibrato and a creak) and filtered noise, each with its own envelope. Steps
 // are recurrences and a sine table, no Math.exp or Math.sin per sample, so an event renders in about a millisecond.
 const SINE = new Float32Array(4096);
 for (let i = 0; i < 4096; i++) SINE[i] = Math.sin(i / 4096 * TAU);
 const sin1 = (cycles) => SINE[(cycles - Math.floor(cycles)) * 4096 | 0];
 const span = (out, rate, L) => { const s0 = Math.round((L.at || 0) * rate); return [s0, Math.max(0, Math.min(out.length - s0, Math.round(L.dur * rate)))]; };
 function tone(out, rate, L) {
  const f1 = L.f1 || L.f0, h2 = L.harm ? L.harm[0] || 0 : 0, h3 = L.harm ? L.harm[1] || 0 : 0;
  // past what this rate can hold it would fold back as a whine
  if (Math.max(L.f0, f1) * (h3 ? 3 : h2 ? 2 : 1) > rate * .45) return;
  const [s0, n] = span(out, rate, L), tail = .006 * rate, aN = Math.max(1, L.attack * rate);
  const gN = Math.max(1, Math.round((L.glide || L.dur) * rate)), gk = Math.pow(f1 / L.f0, 1 / gN), dk = Math.exp(-1 / (L.decay * rate));
  const vib = L.vib, vk = vib ? Math.exp(-1 / (vib.decay * rate)) : 1, am = L.am;
  let f = L.f0 / rate, ph = 0, env = 1, vd = vib ? vib.depth : 0;
  for (let i = 0; i < n; i++) {
   const t = i / rate;
   ph += vib ? f * (1 + vd * sin1(vib.rate * t)) : f;
   if (i < gN) f *= gk;
   vd *= vk;
   const a = (i < aN ? i / aN : 1) * env * (n - i < tail ? (n - i) / tail : 1);
   env *= dk;
   const w = am ? 1 - am.depth * (.5 + .5 * sin1(am.rate * t)) : 1;
   out[s0 + i] += L.gain * a * w * (sin1(ph) + h2 * sin1(2 * ph) + h3 * sin1(3 * ph));
  }
 }
 function noise(out, rate, L, r) {
  const [s0, n] = span(out, rate, L), tail = .006 * rate, aN = Math.max(1, L.attack * rate), dk = Math.exp(-1 / (L.decay * rate));
  const damp = 1 / (L.q || 1), lpA = L.lp ? 1 - Math.exp(-TAU * Math.min(L.lp, rate * .45) / rate) : 0, am = L.am;
  // a state-variable band-pass whose centre glides from bp to bp1
  const fk = L.bp ? Math.pow((L.bp1 || L.bp) / L.bp, 1 / Math.max(1, n)) : 1;
  let k = L.bp ? 2 * Math.sin(Math.PI * Math.min(L.bp, rate / 7) / rate) : 0, lo = 0, bd = 0, lp = 0, env = 1;
  for (let i = 0; i < n; i++) {
   let x = r() * 2 - 1;
   if (L.bp) { lo += k * bd; const hi = x - lo - damp * bd; bd += k * hi; x = bd * damp; k *= fk; }
   if (lpA) { lp += lpA * (x - lp); x = lp; }
   const a = (i < aN ? i / aN : 1) * env * (n - i < tail ? (n - i) / tail : 1);
   env *= dk;
   const w = am ? 1 - am.depth * (.5 + .5 * sin1(am.rate * i / rate)) : 1;
   out[s0 + i] += L.gain * a * w * x;
  }
 }

 // ── What each event sounds like, from her material. ps: her pitch (lighter is higher); bright: rigid rings, plush squelches
 const VARIANTS = {poke: 3, release: 2, land: 2};
 function layersOf(kind, o, r) {
  const J = (x) => 1 + (r() * 2 - 1) * x;
  const soft = clamp(o.soft ?? .6, 0, 1), mass = clamp(o.mass ?? 1, .3, 2), bounce = clamp(o.bounce ?? .3, 0, 1);
  const bright = 1 - soft, ps = Math.pow(1 / mass, .5) * J(.07), v = o.variant || 0;
  const e = Math.pow(clamp(((o.speed || 0) - 200) / 2200, .05, 1), .8), G = J(.15), P = 1.4 * G;
  const thud = (k, lift) => {
   const f0 = 78 * ps * lift * J(.06), L = [
    // her weight: a falling low note, with harmonics a laptop's small speaker can still play
    {f0: f0 * 1.9, f1: f0, glide: .045, attack: .002, decay: .07 + .07 * mass, dur: .45, gain: .2 * k * G, harm: [.8, .4]},
    // the knock of her body
    {f0: (190 + 140 * bright) * ps * J(.08), f1: (150 + 90 * bright) * ps, glide: .06, attack: .002, decay: .035 + .03 * bright, dur: .2, gain: .26 * k * G, harm: [.3]},
   ], N = [{lp: 700 + 3200 * bright, attack: .001, decay: .012, dur: .06, gain: .22 * k * (.4 + bright) * G}];
   // a plush body splats: a wet squelch with a flutter in it
   if (soft > .35) N.push({bp: (v ? 950 : 720) * ps * J(.12), bp1: (v ? 520 : 430) * ps, q: 1.6, attack: .004, decay: .05 + .09 * soft, dur: .32, gain: .55 * k * soft * G, am: {rate: 26 + 22 * r(), depth: .5}});
   // a rigid one rings: a clack, metal for the stiffest
   if (bright > .6) { const f = 1700 * ps * J(.1), d = bright > .9 ? .22 : .07; [[1, .5], [2.76, .3], [5.4, .14]].forEach(([m, a]) => L.push({f0: f * m, attack: .001, decay: d / Math.sqrt(m), dur: .4, gain: .07 * a * k * bright * bright * G})); }
   return {tones: L, noises: N};
  };
  switch (kind) {
   case "land": case "under": {
    const s = thud(e, 1);
    // a springy body answers a hard landing with a little boing
    if (bounce > .38 && e > .25) s.tones.push({at: .012, f0: 250 * ps * J(.1), attack: .008, decay: .14 + .25 * bounce, dur: .6, gain: .11 * e * bounce * G, harm: [.2], vib: {rate: 8 + 5 * r(), depth: .12, decay: .25}});
    return s;
   }
   case "wall": return thud(e * .7, 1.25);
   case "bump": { const s = thud(e * .6, 1.4); s.tones.push({f0: 230 * ps * J(.08), f1: 270 * ps, glide: .06, attack: .004, decay: .07, dur: .25, gain: .14 * e * G, harm: [.35]}); return s; }
   case "poke": {
    if (bright > .75) return {tones: [{f0: 1200 * ps * J(.1), attack: .001, decay: .045, dur: .2, gain: .12 * P}, {f0: 320 * ps * J(.08), f1: 260 * ps, attack: .002, decay: .04, dur: .15, gain: .16 * P, harm: [.4]}], noises: [{lp: 3000, attack: .001, decay: .006, dur: .03, gain: .3 * P}]};
    const f = 430 * ps * J(.08), tones = v === 0 ? [{f0: f * .8, f1: f * 1.3, glide: .07, attack: .004, decay: .07, dur: .25, gain: .2 * P, harm: [.25]}]
     : v === 1 ? [{f0: f * 1.4, f1: f * 2.1, glide: .05, attack: .003, decay: .05, dur: .2, gain: .15 * P, vib: {rate: 32, depth: .03, decay: .2}}]
     : [{f0: f, f1: f * 1.1, glide: .05, attack: .003, decay: .04, dur: .12, gain: .17 * P, harm: [.2]}, {at: .075, f0: f * 1.3, f1: f * 1.45, glide: .05, attack: .003, decay: .05, dur: .2, gain: .15 * P, harm: [.2]}];
    return {tones, noises: [{bp: 1400 * ps * J(.1), bp1: 900 * ps, q: 2, attack: .002, decay: .035, dur: .15, gain: .3 * soft * P}]};
   }
   case "pickup": return {
    tones: [{f0: 280 * ps * J(.08), f1: 560 * ps * J(.06), glide: .16, attack: .03, decay: .13, dur: .45, gain: .14 * G, vib: {rate: 6, depth: .02, decay: 1}, harm: [.2]}],
    noises: [{bp: 1900, q: .7, attack: .05, decay: .1, dur: .35, gain: .12 * G}]};
   case "press": return {
    tones: [{f0: 520 * ps * J(.08), f1: 320 * ps, glide: .26, attack: .02, decay: .2, dur: .55, gain: .13 * (.8 + .5 * soft) * G, am: {rate: 20 + 9 * r(), depth: .55}, harm: [.3, .15]}],
    noises: [{bp: 900 * ps, bp1: 600 * ps, q: 1.2, attack: .02, decay: .15, dur: .45, gain: .3 * soft * G, am: {rate: 24, depth: .5}}]};
   case "release": {
    const f = 210 * ps * (1.25 - .35 * soft) * J(.08);
    return {
     tones: [{f0: v ? f * .85 : f, f1: v ? f * 1.15 : f, glide: .12, attack: .006, decay: .22 + .35 * soft, dur: .9, gain: .126 * G, harm: [.22], vib: {rate: 6 + 6 * soft, depth: .05 + .16 * soft, decay: .3}}],
     noises: [{lp: 1600, attack: .001, decay: .008, dur: .04, gain: .25 * G}]};
   }
   case "stretch": return {tones: [{f0: 300 * ps * J(.1), f1: 650 * ps, glide: .22, attack: .02, decay: .16, dur: .45, gain: .12 * G, am: {rate: 32 + 8 * r(), depth: .45}, harm: [.3]}], noises: []};
   case "settle": return soft > .3
    ? {tones: [{f0: 150 * ps * J(.08), attack: .01, decay: .12 + .1 * soft, dur: .5, gain: (.05 + .08 * soft) * G, harm: [.45, .2], am: {rate: 6 + 3 * soft, depth: .6}}], noises: []}
    : {tones: [0, .12].map((at, i) => ({at, f0: 340 * ps * J(.1), attack: .002, decay: .03, dur: .12, gain: (.14 - .05 * i) * G, harm: [.4]})), noises: []};
   case "pet": return {tones: [], noises: [{bp: 1700 * J(.1), bp1: 1300, q: .8, attack: .09, decay: .14, dur: .45, gain: .2 * G}]};
   default: return null;
  }
 }

 const SOUND = TCS.SOUND = {
  KINDS: ["land", "under", "wall", "bump", "poke", "pickup", "press", "release", "stretch", "settle", "pet"],
  VARIANTS,
  /** One event's sound as samples at `rate` (o: speed px/s, mass, soft, bounce, variant, seed); null for a silent kind. */
  foley(kind, o) {
   const r = rngOf(o.seed ?? 1), s = layersOf(kind, o, r);
   if (!s) return null;
   const ends = [...s.tones, ...s.noises].map((l) => (l.at || 0) + l.dur);
   const out = new Float32Array(Math.ceil(Math.max(...ends) * o.rate));
   for (const l of s.tones) tone(out, o.rate, l);
   for (const l of s.noises) noise(out, o.rate, l, r);
   return out;
  },
  /** Her bed, one seamless loop of BED_S seconds at `rate`: a warm open chord that breathes, with air under it. */
  bed(rate) {
   const n = Math.round(BED_S * rate), out = new Float32Array(n), r = rngOf(7), q = 1 / BED_S;
   // every frequency a whole number of cycles per loop, so the loop has no seam; detuned pairs beat slowly
   const snap = (f) => Math.round(f / q) * q;
   const voices = [[73.42, .5], [110, .42], [146.83, .3], [185, .2], [220, .19], [329.63, .09], [440, .035], [554.37, .025]].map(([f, a], i) => ({f: snap(f), a, d: q * (1 + i % 3), k: 1 + i % 3, p: r()}));
   // one cycle of a felted tone: the note and a little of its octave and twelfth
   const WAVE = Float32Array.from(SINE, (_, i) => SINE[i] + .16 * SINE[i * 2 % 4096] + .05 * SINE[i * 3 % 4096]);
   const swell = new Float32Array(voices.length);
   for (let i = 0; i < n; i++) {
    const t = i / rate;
    if (i % 32 === 0) voices.forEach((v, j) => { swell[j] = v.a * (.7 + .3 * sin1(v.k * t / BED_S + v.p)); });
    // a breath every BED_S / 3 seconds: in quicker, out slower
    const c = 3 * t / BED_S, b = .5 + .5 * sin1(c - .19 * sin1(c));
    let x = 0;
    for (let j = 0; j < voices.length; j++) {
     const v = voices[j], lo = (v.f - v.d) * t, hi = (v.f + v.d) * t;
     x += swell[j] * (WAVE[(lo - Math.floor(lo)) * 4096 | 0] + WAVE[(hi - Math.floor(hi)) * 4096 | 0]);
    }
    out[i] = x * (.72 + .28 * b);
   }
   // the air: noise made periodic (filtered twice round the loop), low and soft, swelling on each breath in
   const white = Float32Array.from({length: n}, () => r() * 2 - 1), a1 = 1 - Math.exp(-TAU * 380 / rate), a2 = 1 - Math.exp(-TAU * Math.min(2400, rate * .4) / rate);
   let l1 = 0, l2 = 0, h = 0;
   for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    l1 += a1 * (white[i] - l1); l2 += a1 * (l1 - l2); h += a2 * (white[i] - h);
    if (pass === 1) { const b = .5 + .5 * sin1(3 * i / rate / BED_S); out[i] += (2.6 * l2 + .05 * (h - l1)) * (.3 + .7 * b * b); }
   }
   let sum = 0;
   for (let i = 0; i < n; i++) sum += out[i] * out[i];
   const k = BED_RMS / Math.sqrt(sum / n);
   for (let i = 0; i < n; i++) out[i] *= k;
   return out;
  },
 };
 // the bed at gain 1 (Settings → Normal): -28 LUFS mono, -25 as it plays on two speakers; it sits under 2 kHz, so 11 kHz holds it
 const BED_S = 16, BED_RMS = .0498, BED_RATE = 11025, FOLEY_RATE = 24000;
 // by her mood's family: how open the bed is (low-pass Hz), how present, and how fast it breathes (also its pitch)
 const BED_MOOD = {Joy: [3600, 1.1, 1.03], Love: [3000, 1.05, 1], Surprise: [3800, 1, 1.04], Curious: [3000, 1, 1.02], Calm: [2400, 1, 1], Sad: [1400, .9, .97], Sulky: [1600, .9, .98], Angry: [2000, .95, 1.01], Sleepy: [1100, .8, .96]};

 /** The player: o.P() is her physics now (rig.physics). Every call is cheap and safe before any sound is wanted. */
 SOUND.create = (o) => {
  const AC = g.AudioContext || g.webkitAudioContext;
  const st = {physics: 0, bed: 0, shown: true, speaking: false, listening: false, asleep: false, group: "Calm", energy: .5};
  let ctx = null, master, foleyBus, bedLp, bedGain, bedBuf = null, making = false, bedSrc = null, fading = null, fadeT = 0, sleepT = 0;
  let rustle = null, rustleBuf = null, rustleT = 0, armed = false, held = false, lastSp = 0, landAt = -1e9, stretchAt = -1e9, releaseAt = -1e9, pressed = false;
  const last = {};
  const ensure = () => {
   if (!AC) return null;
   if (!ctx) {
    ctx = new AC({latencyHint: "interactive"});
    // the limiter: everything she makes passes it, so nothing she does can clip
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -6; master.knee.value = 0; master.ratio.value = 20; master.attack.value = .002; master.release.value = .15;
    // Chromium's compressor adds a fixed make-up gain (about 3.4 dB at these settings): this takes it back out
    const out = ctx.createGain(); out.gain.value = .68;
    master.connect(out).connect(ctx.destination);
    foleyBus = ctx.createGain(); foleyBus.connect(master);
    bedLp = ctx.createBiquadFilter(); bedLp.type = "lowpass"; bedLp.frequency.value = 2400; bedLp.Q.value = .5;
    bedGain = ctx.createGain(); bedGain.gain.value = 0;
    bedLp.connect(bedGain).connect(master);
   }
   clearTimeout(sleepT);
   if (ctx.state === "suspended") ctx.resume().catch(() => {});
   return ctx;
  };
  // nothing sounding: the audio device sleeps, so at rest with the bed off she costs nothing
  const rest = () => { clearTimeout(sleepT); sleepT = setTimeout(() => { if (ctx && !bedSrc && !fading && !rustle) ctx.suspend().catch(() => {}); }, 2500); };
  const play = (kind, speed) => {
   if (st.physics <= 0 || !st.shown || st.asleep) return;
   const c = ensure();
   if (!c) return;
   const P = (o && o.P && o.P()) || {}, vs = VARIANTS[kind] || 1;
   let v = Math.floor(Math.random() * vs);
   if (vs > 1 && v === last[kind]) v = (v + 1) % vs;
   last[kind] = v;
   const pcm = SOUND.foley(kind, {speed, mass: P.mass, soft: P.soft, bounce: P.bounce, variant: v, seed: Math.random() * 2 ** 31 | 0, rate: FOLEY_RATE});
   if (!pcm) return;
   const buf = c.createBuffer(1, pcm.length, FOLEY_RATE);
   buf.copyToChannel(pcm, 0);
   const src = c.createBufferSource(), gn = c.createGain();
   src.buffer = buf; gn.gain.value = st.physics * (st.speaking ? .6 : 1);
   src.connect(gn).connect(foleyBus);
   src.onended = () => { src.disconnect(); gn.disconnect(); rest(); };
   src.start();
  };
  const stopRustle = () => { if (!rustle) return; const r = rustle; rustle = null; r.gn.gain.setTargetAtTime(0, ctx.currentTime, .05); setTimeout(() => { try { r.src.stop(); } catch { /* stopped */ } r.src.disconnect(); rest(); }, 300); };
  // the soft rustle of her moving through the air: louder and brighter the faster she goes
  const move = (sp) => {
   const level = clamp((sp - 250) / 2750, 0, 1);
   if (!rustle) {
    if (level <= 0 || st.physics <= 0 || !st.shown || st.asleep) return;
    const c = ensure();
    if (!c) return;
    if (!rustleBuf) {
     const n = c.sampleRate * 2, w = Float32Array.from({length: n}, () => Math.random() * 2 - 1), d = new Float32Array(n), a = 1 - Math.exp(-TAU * 1200 / c.sampleRate);
     let y = 0;
     for (let p = 0; p < 2; p++) for (let i = 0; i < n; i++) { y += a * (w[i] - y); if (p) d[i] = y; }
     rustleBuf = c.createBuffer(1, n, c.sampleRate); rustleBuf.copyToChannel(d, 0);
    }
    const src = c.createBufferSource(), bp = c.createBiquadFilter(), gn = c.createGain();
    src.buffer = rustleBuf; src.loop = true; bp.type = "bandpass"; bp.Q.value = .7; gn.gain.value = 0;
    src.connect(bp).connect(gn).connect(foleyBus); src.start();
    rustle = {src, bp, gn};
   }
   clearTimeout(rustleT);
   const now = ctx.currentTime;
   rustle.gn.gain.setTargetAtTime(.32 * st.physics * level * level, now, .06);
   rustle.bp.frequency.setTargetAtTime(500 + 2300 * level, now, .06);
   if (level <= 0) rustleT = setTimeout(stopRustle, 400);
  };
  const bed = () => {
   const want = st.bed > 0 && st.shown && !st.asleep;
   if (!want) {
    if (!bedSrc) return;
    fading = bedSrc; bedSrc = null;
    bedGain.gain.setTargetAtTime(0, ctx.currentTime, .4);
    clearTimeout(fadeT);
    fadeT = setTimeout(() => { try { fading.stop(); } catch { /* stopped */ } fading.disconnect(); fading = null; rest(); }, 2500);
    return;
   }
   const c = ensure();
   if (!c) return;
   if (!bedSrc && fading) { clearTimeout(fadeT); bedSrc = fading; fading = null; }
   if (!bedSrc) {
    // made once, when the page is idle: tens of milliseconds that must not land on one of her frames
    if (!bedBuf) {
     if (!making) { making = true; (g.requestIdleCallback || setTimeout)(() => { const pcm = SOUND.bed(BED_RATE); bedBuf = c.createBuffer(1, pcm.length, BED_RATE); bedBuf.copyToChannel(pcm, 0); bed(); }); }
     return;
    }
    bedSrc = c.createBufferSource(); bedSrc.buffer = bedBuf; bedSrc.loop = true;
    bedSrc.connect(bedLp); bedSrc.start();
   }
   const [cut, lift, pace] = BED_MOOD[st.group] || BED_MOOD.Calm, duck = st.listening ? .2 : st.speaking ? .3 : 1, now = c.currentTime;
   bedGain.gain.setTargetAtTime(st.bed * lift * duck, now, duck < 1 ? .08 : .8);
   bedLp.frequency.setTargetAtTime(cut, now, 1.2);
   bedSrc.playbackRate.setTargetAtTime(pace * (1 + (st.energy - .5) * .04), now, 2);
  };
  return {
   /** Levels (physics, bed: gains, 0 off), shown, speaking, listening, asleep, her mood's family (group) and energy. */
   state(next) {
    Object.assign(st, next);
    if (st.physics <= 0 || !st.shown || st.asleep) stopRustle();
    if (ctx || (st.bed > 0 && st.shown && !st.asleep)) bed();
   },
   react(kind, speed) {
    const t = performance.now();
    if (kind === "pickup") { armed = true; held = false; return; }
    if (kind === "poke") { armed = held = false; if (t - releaseAt > 150) play("poke", 400); return; }
    if (kind === "land" || kind === "under") { held = false; landAt = t; }
    if (kind !== "hello") play(kind, speed);
   },
   motion(vx, vy) {
    const sp = Math.hypot(vx, vy), t = performance.now();
    // lifted, not just pressed: a poke never whoops
    if (armed && sp > 150) { armed = false; held = true; play("pickup", sp); }
    if (held && sp > 1800 && t - stretchAt > 700) { stretchAt = t; play("stretch", sp); }
    if (sp === 0 && lastSp > 0 && t - landAt < 1500) setTimeout(() => play("settle", 0), 90);
    lastSp = sp;
    move(sp);
   },
   press(a) { if (a !== 0 && !pressed) { pressed = true; play("press", 0); } },
   release() { if (pressed) { pressed = false; releaseAt = performance.now(); play("release", 0); } },
  };
 };
})(window);
