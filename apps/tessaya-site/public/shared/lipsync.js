/* Lip sync from the audio that is actually playing, for any voice and any source (a clip, a TTS stream, a mic).
 * Per frame: RMS envelope → jaw (attack/release smoothing, noise gate, normalised to this voice's running loudness);
 * spectral shape (low/high band ratio, zero-crossing rate, spectral centroid normalised to this voice's own range)
 * → one of six mouth shapes. Word or phoneme timings, when a source has them, are blended in by the caller.
 * Exposes TCS.LipSync.attach(mediaElement) → {read(), stop()}; read() returns {open, shape, weights}.
 * The same numbers drive every character and can drive the R1's eyes. */
(function (g) {
 "use strict";
 const TCS = g.TCS = g.TCS || {};
 let ctx = null;
 const SHAPES = ["mbp", "aa", "ee", "oh", "fv", "st"];
 TCS.LipSync = {
  SHAPES,
  attach(el) {
   ctx = ctx || new (g.AudioContext || g.webkitAudioContext)();
   if (ctx.state === "suspended") ctx.resume();
   const src = el.__lsSrc || (el.__lsSrc = ctx.createMediaElementSource(el));
   const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0;
   src.connect(an); an.connect(ctx.destination);
   const td = new Float32Array(an.fftSize), fd = new Float32Array(an.frequencyBinCount), hz = ctx.sampleRate / an.fftSize;
   // running calibration for this voice: loudness peak, and the range of its spectral centroid
   const cal = {peak: .02, mean: 0, sd: 400, n: 0};
   let jaw = 0, last = performance.now(), shape = "mbp", hold = 0;
   const read = () => {
    const now = performance.now(), dt = Math.min(.05, (now - last) / 1000); last = now;
    an.getFloatTimeDomainData(td); an.getFloatFrequencyData(fd);
    let s = 0, zc = 0; for (let i = 0; i < td.length; i++) { s += td[i] * td[i]; if (i && (td[i] >= 0) !== (td[i - 1] >= 0)) zc++; }
    const rms = Math.sqrt(s / td.length), zcr = zc / td.length;
    cal.peak = Math.max(rms, cal.peak * Math.pow(.5, dt / 4)); // the peak decays with a 4 s half-life, so it follows the voice
    const gate = rms < Math.max(.004, cal.peak * .08);
    const target = gate ? 0 : Math.min(1, Math.pow(rms / (cal.peak * .85), .7));
    // fast attack, slower release, so syllables open crisply and close softly
    const k = 1 - Math.exp(-dt / (target > jaw ? .03 : .085)); jaw += (target - jaw) * k;
    let lo = 0, hi = 0, num = 0, den = 0;
    for (let i = 1; i < fd.length; i++) { const f = i * hz, p = Math.pow(10, fd[i] / 10); if (f < 900) lo += p; else if (f > 3000 && f < 9000) hi += p; if (f > 100 && f < 6000) { num += f * p; den += p; } }
    const centroid = den ? num / den : 0, ratio = hi / (lo + 1e-12);
    // this voice's own brightness: a running mean and spread of its spectral centroid (fast at first, then steady)
    if (!gate) { cal.n++; const k2 = Math.max(.02, 1 / cal.n); if (cal.n === 1) cal.mean = centroid; cal.mean += (centroid - cal.mean) * k2; cal.sd += (Math.abs(centroid - cal.mean) - cal.sd) * k2; }
    const z = (centroid - cal.mean) / Math.max(120, cal.sd * 1.25); // below 0 = darker than her average, above = brighter
    let next;
    if (gate || jaw < .08) next = "mbp";
    else if (zcr > .22 && ratio > .9) next = "st";       // hiss: s, t, sh
    else if (zcr > .16 && ratio > .45 && jaw < .45) next = "fv";
    else if (z < -.55) next = "oh";                       // darker than her average: o, u, w
    else if (z > .55) next = "ee";                        // brighter: e, i
    else next = "aa";
    hold -= dt; if (next !== shape && hold <= 0) { shape = next; hold = .045; } // hold each shape ≥ 45 ms: no chatter
    return {open: jaw, shape, rms, zcr, centroid: z};
   };
   return {read, stop() { try { src.disconnect(an); an.disconnect(); src.connect(ctx.destination); } catch {} }};
  },
 };
})(window);
