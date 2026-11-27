/* The Tessel's eyes: the device's own eye renderer (firmware smp-0.3.135), compiled to WebAssembly, on its own 33 ms tick, as on the device.
 * It redraws only when the renderer says something visible changed, and stops ticking while `watch` is off-screen.
 * TSEyes({wasm, watch, onDraw(rgbaCanvas)}) → Promise<{expr, play, gaze, persona, canvas}>; canvas is 320×160 (both eyes). */
(function (g) {
 "use strict";
 // split the 320×160 frame into the two eye canvases, smoothly upscaled: the firmware draws 160 px per eye, as on the
 // device, so the canvases are 512 px (sharp enough for 4K and as 3D textures) and filtered rather than pixel-doubled
 g.TSEyesBlit = (ctxs, cv) => ctxs.forEach((x, i) => { if (!x) return; const n = x.canvas.width; x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high"; x.drawImage(cv, i * 160, 0, 160, 160, 0, 0, n, n); });
 g.TSEyes = async function (o) {
  const stub = new Proxy({}, {get: () => () => 0});
  const {instance} = await WebAssembly.instantiateStreaming(fetch(o.wasm), {wasi_snapshot_preview1: stub});
  const ex = instance.exports; ex._initialize && ex._initialize();
  const mem = () => new Uint8Array(ex.memory.buffer);
  const setName = (s) => { const b = new TextEncoder().encode(s), p = ex.wp_name_buf(); mem().set(b, p); mem()[p + b.length] = 0; };
  const t0 = performance.now(), now = () => (1000 + performance.now() - t0) >>> 0;
  ex.wp_init(now(), 42);
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 160;
  const cx = canvas.getContext("2d"), img = new ImageData(320, 160);
  let api = null;
  const draw = () => { ex.wp_render(); img.data.set(new Uint8Array(ex.memory.buffer, ex.wp_rgba(), 320 * 160 * 4)); cx.putImageData(img, 0, 0); o.onDraw && o.onDraw(canvas); api && api.onDraw && api.onDraw(canvas); };
  let timer = 0, seen = true;
  const run = () => { if (timer || !seen || document.hidden) return; timer = setInterval(() => { if (ex.wp_step(now())) draw(); }, 33); };
  const halt = () => { clearInterval(timer); timer = 0; };
  if (o.watch) new IntersectionObserver(([e]) => { seen = e.isIntersecting; seen ? run() : halt(); }).observe(o.watch);
  document.addEventListener("visibilitychange", () => (document.hidden ? halt() : run()));
  draw(); run();
  api = {
   canvas,
   expr(e) { setName(e); ex.wp_expr(now()); run(); },
   play(c) { setName(c); ex.wp_play(now()); run(); },
   gaze(x, y, ms = 2600) { ex.wp_gaze(x, y, ms, now()); run(); },
   persona(i) { ex.wp_persona(i); draw(); },
   prop(name) { setName(name); ex.wp_acc(); draw(); },
  };
  api.PERSONA = {freya: 0, tessaya: 1, alfred: 2, sebastian: 3};
  return api;
 };
 // who is who: persona → character body, Pocket TTS voice, and her short "yes?" clip
 g.TS_WHO = {
  tessaya: {name: "Tessaya", ch: "selvedge", voice: "Eve", yes: "t-yes"},
  freya: {name: "Freya", ch: "felt", voice: "Azelma", yes: "f-yes"},
  alfred: {name: "Alfred", ch: "tweed", voice: "Peter", yes: "a-yes"},
  sebastian: {name: "Sebastian", ch: "spool", voice: "Michael", yes: "s-yes"},
  onyx: {name: "Onyx", ch: "pebble", voice: null, yes: null},
 };
})(window);
