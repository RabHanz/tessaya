/* The Tessaya mark as five real threads (two woven through three, at 45°), each a damped string fixed at both ends.
 * Drag across a thread to pluck it; while she speaks, her voice drives them. Drawn only while a thread still moves:
 * at rest the canvas holds its last frame and costs nothing. Geometry from kit/masters/tessaya-mark.svg (256 units).
 * Loom(canvas, {THREE, colors() → {ink, dye}, level() → 0..1, fit: 0..1 of the short side, cx, cy}) → {ring, resize} */
export function Loom(canvas, o) {
 const THREE = o.THREE, reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
 const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
 renderer.setPixelRatio(Math.min(2, devicePixelRatio));
 const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
 // in the mark's rotated frame: [axis, offset, from, to, gaps[], dyed]; width 22 units
 const SPEC = [
  ["u", -32, -88, 88, [[-20, 20]], false], ["u", 32, -44, 44, [], false],
  ["v", -64, -78, 78, [[-52, -12]], true], ["v", 0, -78, 78, [[12, 52]], true], ["v", 64, -78, 78, [[-52, -12]], false],
 ];
 const SEG = 64, threads = [];
 for (const [axis, off, a, b, gaps, dyed] of SPEC) {
  const geo = new THREE.BufferGeometry(), pos = new Float32Array((SEG + 1) * 2 * 3), idx = [];
  for (let s = 0; s < SEG; s++) { const t = a + (b - a) * (s + .5) / SEG; if (gaps.some(([g0, g1]) => t > g0 && t < g1)) continue; const k = s * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  geo.setIndex(idx); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.MeshBasicMaterial({side: THREE.DoubleSide});
  const m = new THREE.Mesh(geo, mat); m.position.z = axis === "v" ? 1 : 0; scene.add(m);
  threads.push({axis, off, a, b, dyed, m, pos, u: new Float32Array(SEG + 1), v: new Float32Array(SEG + 1)});
 }
 let W = 1, H = 1, k = 1, cx = 0, cy = 0, running = false, lastP = null;
 const R2 = Math.SQRT1_2;
 // mark frame → screen: x = (u − v)/√2, y = (u + v)/√2 as in the SVG (y down); the camera's y points up
 const toScreen = (u, v) => [cx + (u - v) * R2 * k, H - (cy + (u + v) * R2 * k)];
 function paint() { const c = o.colors(); for (const t of threads) t.m.material.color.set(t.dyed ? c.dye : c.ink); }
 function resize() {
  const r = canvas.getBoundingClientRect(); W = r.width; H = r.height; renderer.setSize(W, H, false);
  cam.right = W; cam.top = H; cam.updateProjectionMatrix();
  k = Math.min(W, H) * (o.fit ?? .9) / 236; cx = W * (o.cx ?? .5); cy = H * (o.cy ?? .5);
  paint(); draw();
 }
 function draw() {
  const hw = 11;
  for (const t of threads) {
   for (let s = 0; s <= SEG; s++) {
    const along = t.a + (t.b - t.a) * s / SEG, d = t.u[s];
    const [u0, v0, u1, v1] = t.axis === "u" ? [along, t.off + d - hw, along, t.off + d + hw] : [t.off + d - hw, along, t.off + d + hw, along];
    const p0 = toScreen(u0, v0), p1 = toScreen(u1, v1), q = s * 6;
    t.pos[q] = p0[0]; t.pos[q + 1] = p0[1]; t.pos[q + 3] = p1[0]; t.pos[q + 4] = p1[1];
   }
   t.m.geometry.attributes.position.needsUpdate = true;
  }
  renderer.render(scene, cam);
 }
 // a kick spread over a few nodes, so a pluck rings in the low modes instead of tearing the ribbon
 const kick = (t, s, a) => { for (let j = -7; j <= 7; j++) { const n = s + j; if (n > 0 && n < SEG) t.v[n] += a * Math.exp(-j * j / 10); } };
 function step(level) {
  let e = 0;
  threads.forEach((t, i) => {
   if (level > .04) { const s = Math.round(SEG * (.3 + .4 * ((i * 7) % 5) / 5)); kick(t, s, level * .32 * (i % 2 ? 1 : -1)); }
   for (let it = 0; it < 2; it++) for (let s = 1; s < SEG; s++) t.v[s] = (t.v[s] + (t.u[s - 1] + t.u[s + 1] - 2 * t.u[s]) * .42) * .988;
   for (let s = 1; s < SEG; s++) { t.u[s] = Math.max(-26, Math.min(26, t.u[s] + t.v[s])); e += Math.abs(t.v[s]); }
  });
  return e;
 }
 function frame() {
  const lv = reduced ? 0 : o.level();
  const e = step(lv); draw(); o.onFrame && o.onFrame(lv);
  if (e > .25 || lv > .01) requestAnimationFrame(frame); else { running = false; o.onFrame && o.onFrame(0); }
 }
 function ring() { if (!running) { running = true; requestAnimationFrame(frame); } }
 // screen → mark frame
 const toMark = (x, y) => { const X = (x - cx) / k, Y = (y - cy) / k; return [(X + Y) * R2, (Y - X) * R2]; };
 canvas.addEventListener("pointermove", (ev) => {
  const r = canvas.getBoundingClientRect(), p = toMark(ev.clientX - r.left, ev.clientY - r.top);
  if (lastP && !reduced) for (const t of threads) {
   const [al, ac, pl, pc] = t.axis === "u" ? [p[0], p[1], lastP[0], lastP[1]] : [p[1], p[0], lastP[1], lastP[0]];
   if ((ac - t.off) * (pc - t.off) < 0 && al > t.a && al < t.b) {
    const s = Math.round((al - t.a) / (t.b - t.a) * SEG), k0 = Math.max(-9, Math.min(9, (ac - pc) * .9));
    if (s > 0 && s < SEG) { kick(t, s, k0 * .45); ring(); }
   }
  }
  lastP = p;
 });
 canvas.addEventListener("pointerleave", () => { lastP = null; });
 new ResizeObserver(resize).observe(canvas);
 // the threads take the theme's colours whenever it changes, from the system or the page's own switch
 const repaint = () => { paint(); draw(); };
 matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaint);
 new MutationObserver(repaint).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
 resize();
 return {ring, resize, pluck(n = 1) { threads.forEach((t, i) => kick(t, Math.round(SEG * (.25 + .1 * i)), (i % 2 ? 1.6 : -1.6) * n)); ring(); }};
}
