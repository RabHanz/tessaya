/**
 * What runs in the phone companion's web view, on top of the server's `/companion/stage.html` (the Character Studio's
 * rig): her face, and her voice from the room's 16 kHz PCM, played in order with the mouth on each chunk's own loudness.
 * The rig draws only while something moves, and never more than 30 frames a second.
 */
export const COMPANION_PAGE_SCRIPT = String.raw`(() => {
 if (window.companion) return true;
 const raf = window.requestAnimationFrame.bind(window);
 let lastT = 0;
 window.requestAnimationFrame = (cb) => {
  const wait = 1000 / 30 - (performance.now() - lastT);
  const go = () => raf((t) => { lastT = t; cb(t); });
  return wait > 2 ? setTimeout(go, wait) : go();
 };
 const post = (m) => window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m));
 const svg = document.getElementById("c");
 let rig = null, persona = "";
 let ctx = null, nextAt = 0, sources = [], levels = [], endTimer = 0, playing = false, peak = 0.02;
 const level = () => {
  const now = ctx ? ctx.currentTime : 0;
  let v = 0;
  for (const l of levels) { if (l.at <= now) v = l.v; else break; }
  return v;
 };
 const mouth = () => {
  const v = level(); peak = Math.max(v, peak * 0.995);
  const open = v < peak * 0.08 ? 0 : Math.min(1, Math.pow(v / (peak * 0.85), 0.7));
  return { open, shape: open < 0.08 ? "mbp" : open > 0.6 ? "aa" : open > 0.3 ? "oh" : "ee" };
 };
 const forever = { words: [], syl: [], events: [], vis: [], end: 1e9 };
 const setPlaying = (on) => {
  if (on === playing) return;
  playing = on;
  post({ type: "playing", on });
  if (!rig) return;
  if (on) { peak = 0.02; rig.speak(forever, { mouth }); } else rig.stopSpeech();
 };
 const settle = () => {
  clearTimeout(endTimer);
  const left = ctx ? (nextAt - ctx.currentTime) * 1000 : 0;
  endTimer = setTimeout(() => {
   if (ctx && ctx.currentTime >= nextAt - 0.01) { sources = []; levels = []; setPlaying(false); } else settle();
  }, Math.max(20, left + 60));
 };
 window.companion = {
  persona(name) {
   const P = TCS.PERSONAS[name] || TCS.PERSONAS.tessaya;
   if (!rig) rig = TCS.create(svg, { character: P.character, personality: P.traits, expression: "neutral", intensity: 0.85, quiet: true });
   else if (name !== persona) { rig.setCharacter(P.character); rig.setPersonality(P.traits); }
   persona = name;
  },
  cue(c) {
   if (!rig) return;
   rig.setExpression(c.expression, { noCut: c.expression === "neutral" });
   if (c.clip) rig.play(c.clip);
   if (c.fx) rig.spawn(c.fx);
  },
  audio(b64) {
   ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
   if (ctx.state === "suspended") ctx.resume();
   const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
   const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
   if (pcm.length === 0) return;
   const buf = ctx.createBuffer(1, pcm.length, 16000), ch = buf.getChannelData(0);
   let sum = 0;
   for (let i = 0; i < pcm.length; i++) { ch[i] = pcm[i] / 32768; sum += ch[i] * ch[i]; }
   const src = ctx.createBufferSource();
   src.buffer = buf; src.connect(ctx.destination);
   const at = Math.max(ctx.currentTime + 0.06, nextAt);
   src.start(at);
   sources.push(src);
   levels.push({ at, v: Math.sqrt(sum / pcm.length) });
   if (levels.length > 400) levels = levels.slice(-200);
   nextAt = at + buf.duration;
   setPlaying(true);
   settle();
  },
  flush() {
   for (const s of sources) { try { s.stop(); } catch {} }
   sources = []; levels = []; nextAt = 0;
   clearTimeout(endTimer);
   setPlaying(false);
  },
 };
 post({ type: "ready" });
 return true;
})();`;

/** A message from the page: its rig loaded, or her voice started or stopped playing. */
export const companionPageMessage = (
  data: string,
): { readonly type: "ready" } | { readonly type: "playing"; readonly on: boolean } | null => {
  try {
    const m: unknown = JSON.parse(data);
    if (typeof m !== "object" || m === null || !("type" in m)) return null;
    if (m.type === "ready") return { type: "ready" };
    if (m.type === "playing" && "on" in m && typeof m.on === "boolean")
      return { type: "playing", on: m.on };
    return null;
  } catch {
    return null;
  }
};
