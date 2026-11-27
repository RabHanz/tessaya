/* One device, turned by hand: a Blender turntable (N frames, rendered in the plush thread's studio from each device's
 * design file) drawn to a canvas. Drag or use the arrow keys to turn it all the way round; it never turns by itself.
 * The live screens (the eye canvases, the phone's rig) ride on top, mapped onto each frame's screen quad with a CSS
 * homography, and fade out as the screen turns away, where the render's own baked screen takes over.
 * The front frame loads when the caller asks, the 45-degree views near the screen, the rest on hover, touch or focus; nothing runs while it is still.
 * TSSpin(el, {src, name, screens: [element per screen in the JSON's order]}) → Promise<{front(), turnTo(i)}> */
(function (g) {
 "use strict";
 // the 3×3 projective map taking the box (0,0)-(w,h) onto the quad q = [TLx,TLy, TRx,TRy, BRx,BRy, BLx,BLy]
 const adj = (m) => [m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4], m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5], m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]];
 const mul = (a, b) => { const c = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += a[3 * i + k] * b[3 * k + j]; c.push(s); } return c; };
 const mv = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
 const basis = (p) => { const m = [p[0], p[2], p[4], p[1], p[3], p[5], 1, 1, 1], v = mv(adj(m), [p[6], p[7], 1]); return mul(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]); };
 function homography(w, h, q) {
  const s = basis([0, 0, w, 0, 0, h, w, h]), d = basis([q[0], q[1], q[2], q[3], q[6], q[7], q[4], q[5]]);
  const t = mul(d, adj(s)).map((x, _, a) => x / a[8] || 0);
  return `matrix3d(${[t[0], t[3], 0, t[6], t[1], t[4], 0, t[7], 0, 0, 1, 0, t[2], t[5], 0, t[8]].map((x) => +x.toFixed(9)).join(",")})`;
 }
 // one viewer fetches its remaining frames at a time: four at once hit Chrome's resource limit
 let queue = Promise.resolve();
 const VIEW = ["front", "front left", "left side", "back left", "back", "back right", "right side", "front right"];
 // coarse to fine: 0, N/2, N/4, 3N/4, … so a whole turn is there after a few frames
 const order = (n) => { const o = [0], seen = new Set(o); for (let s = n / 2; s >= 1; s /= 2) for (let i = 0; i < n; i += s) { const k = Math.round(i); if (!seen.has(k)) { seen.add(k); o.push(k); } } for (let i = 0; i < n; i++) if (!seen.has(i)) o.push(i); return o; };

 g.TSSpin = async function (el, o) {
  const meta = await (await fetch(o.src + ".json")).json(), N = meta.n;
  const big = Math.min(2, devicePixelRatio || 1) * el.clientWidth > meta.small.w * 1.15;
  const dir = o.src + (big ? "/l/" : "/s/"), ar = meta.w / meta.h;
  el.style.setProperty("--ar", ar.toFixed(4));
  const cv = el.querySelector("canvas"), x = cv.getContext("2d"), layer = el.querySelector(".spin-screens");
  const imgs = new Array(N), base = o.screens.map((s) => [s.offsetWidth || s.width, s.offsetHeight || s.height]);
  let cur = 0, pos = 0, vel = 0, raf = 0, W = 0, H = 0;
  const loadOne = (i) => new Promise((res) => { const im = new Image(); im.decoding = "async"; im.src = `${dir}${String(i).padStart(3, "0")}.webp`; im.decode().then(() => { imgs[i] = im; res(); }, res); });
  const nearest = (i) => { for (let d = 0; d < N; d++) { if (imgs[(i + d) % N]) return imgs[(i + d) % N]; if (imgs[(i - d + N) % N]) return imgs[(i - d + N) % N]; } return null; };
  const size = () => { const r = cv.getBoundingClientRect(), k = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = Math.round(W * k); cv.height = Math.round(H * k); draw(true); };
  function draw(force) {
   // pos is the physical angle in steps; a set stored the other way round (dir -1) is read backwards
   const k = ((Math.round(pos) % N) + N) % N, i = (meta.dir || 1) > 0 ? k : (N - k) % N;
   if (i === cur && !force) return;
   cur = i; const im = nearest(i);
   x.clearRect(0, 0, cv.width, cv.height); if (im) x.drawImage(im, 0, 0, cv.width, cv.height);
   const fr = meta.frames[i];
   o.screens.forEach((s, k) => {
    const f = fr[k], [f0, f1] = o.fade || [.5, .8], a = Math.min(1, Math.max(0, (f.f - f0) / (f1 - f0)));
    s.style.opacity = a.toFixed(3); s.style.visibility = a > 0 ? "visible" : "hidden";
    if (a > 0) s.style.transform = homography(base[k][0], base[k][1], f.q.map((v, j) => v * (j % 2 ? H : W)));
   });
   const deg = Math.round(k * 360 / N);
   el.setAttribute("aria-valuenow", String(deg)); el.setAttribute("aria-valuetext", `${o.name}, ${VIEW[Math.round(deg / 45) % 8]}`);
  }
  // inertia after a fling; the loop runs only while it is moving
  const tick = () => { raf = 0; pos += vel; vel *= .92; if (target !== null) { const d = target - pos; vel = d * .16; if (Math.abs(d) < .05) { pos = target; target = null; vel = 0; } } draw(); if (Math.abs(vel) > .02 || target !== null) raf = requestAnimationFrame(tick); };
  let target = null;
  const go = () => { if (!raf) raf = requestAnimationFrame(tick); };
  let drag = null;
  el.addEventListener("pointerdown", (e) => { if (e.button) return; drag = {x: e.clientX, p: pos, t: e.timeStamp, last: e.clientX}; target = null; vel = 0; el.setPointerCapture(e.pointerId); el.classList.add("held"); });
  el.addEventListener("pointermove", (e) => { if (!drag) return; const per = N / Math.max(240, W * 1.4); pos = drag.p + (e.clientX - drag.x) * per; vel = (e.clientX - drag.last) * per; drag.last = e.clientX; draw(); });
  const up = () => { if (!drag) return; drag = null; el.classList.remove("held"); go(); };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  el.addEventListener("keydown", (e) => { const s = {ArrowLeft: -1, ArrowRight: 1}[e.key]; if (s) { e.preventDefault(); target = Math.round((target ?? pos)) + s; go(); } else if (e.key === "Home") { e.preventDefault(); api.front(); } });
  new ResizeObserver(size).observe(cv);
  await loadOne(0); size(); el.classList.add("ready");
  // frame 0 comes with the caller; near the screen the 45-degree views follow, and the in-betweens on hover, touch or focus,
  // one viewer at a time, so scrolling past a card costs eight frames, not all of them
  const rest = order(N).slice(1), coarse = rest.slice(0, 7), fine = rest.slice(7);
  const fetchAll = (list) => { queue = queue.then(async () => { for (let k = 0; k < list.length; k += 4) { await Promise.all(list.slice(k, k + 4).map(loadOne)); draw(true); } }); };
  let nearDone = false, touched = false;
  const io = new IntersectionObserver(([e]) => { if (!e.isIntersecting) return; io.disconnect(); nearDone = true; if (!touched) fetchAll(coarse); }, {rootMargin: "200px"});
  io.observe(el);
  const more = () => { if (touched) return; touched = true; io.disconnect(); fetchAll(nearDone ? fine : rest); };
  for (const t of ["pointerenter", "pointerdown", "focus"]) el.addEventListener(t, more);
  const api = {
   /** turn back to face the viewer, the short way round */
   front() { const r = Math.round(pos / N) * N; target = r; go(); },
   turnTo(i) { target = i; go(); },
  };
  return api;
 };
})(window);
