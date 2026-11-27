/* The Drop: a drop of dye as a soft body. Six blobs on springs make one metaball surface; the pointer pushes them
 * apart and they pull back together, and her voice swells the drop. Colour follows mood; o.moods overrides the default woad calm, weld happy.
 * A fragment shader draws it at most at 1.5× pixel ratio, and only while something still moves.
 * Drop(canvas, {THREE, level() → 0..1, cx, cy, size, moods?: {calm|happy|listening: [deep, lit]}}) → {ring, mood(name)} */
export function Drop(canvas, o) {
 const THREE = o.THREE, reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
 const renderer = new THREE.WebGLRenderer({canvas, antialias: false, alpha: true, premultipliedAlpha: false});
 renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
 const N = 6, blobs = Array.from({length: N}, (_, i) => ({a: i / N * Math.PI * 2 + .4, x: 0, y: 0, vx: 0, vy: 0, r: i ? .42 + .1 * ((i * 3) % 4) / 3 : .74}));
 const M0 = {calm: ["#14505a", "#5fb3b3"], happy: ["#9a6c10", "#e5b532"], listening: ["#1d3f7a", "#7fa6e6"], ...o.moods};
 const MOODS = Object.fromEntries(Object.entries(M0).map(([k, [d, l]]) => [k, [new THREE.Color(d), new THREE.Color(l)]]));
 const u = {uRes: {value: new THREE.Vector2(1, 1)}, uB: {value: Array.from({length: N}, () => new THREE.Vector3())}, uDeep: {value: MOODS.calm[0].clone()}, uLit: {value: MOODS.calm[1].clone()}, uK: {value: 1}};
 const mat = new THREE.ShaderMaterial({uniforms: u, transparent: true, vertexShader: "varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy, 0., 1.); }",
  fragmentShader: `precision highp float; varying vec2 v; uniform vec2 uRes; uniform vec3 uB[${N}]; uniform vec3 uDeep, uLit; uniform float uK;
  float field(vec2 p){ float f = 0.; for (int i = 0; i < ${N}; i++){ vec2 d = p - uB[i].xy; f += uB[i].z * uB[i].z / (dot(d, d) + 1e-4); } return f; }
  void main(){
   vec2 p = (v - .5) * uRes / min(uRes.x, uRes.y) / uK;
   float f = field(p), w = fwidth(f) * 1.3;
   float a = smoothstep(1. - w, 1. + w, f);
   // shade a dome that saturates inside, so the blob centres never show
   float h0 = 1. - exp(-max(f - 1., 0.) * .45);
   float hx = 1. - exp(-max(field(p + vec2(.006, 0.)) - 1., 0.) * .45), hy = 1. - exp(-max(field(p + vec2(0., .006)) - 1., 0.) * .45);
   vec3 n = normalize(vec3(-(hx - h0) * 18., -(hy - h0) * 18., 1.));
   float lit = clamp(dot(n, normalize(vec3(-.5, .6, .8))), 0., 1.);
   float depth = h0;
   vec3 c = mix(uLit, uDeep, smoothstep(.2, 1., depth) * .55);
   c += pow(clamp(dot(reflect(vec3(0., 0., -1.), n), normalize(vec3(-.4, .5, .75))), 0., 1.), 24.) * .55;
   c *= .72 + .38 * lit;
   gl_FragColor = vec4(c, a);
  }`});
 const scene = new THREE.Scene(), cam = new THREE.Camera();
 scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
 let W = 1, H = 1, running = false, ptr = null, moodT = 0;
 const target = {deep: MOODS.calm[0].clone(), lit: MOODS.calm[1].clone()};
 function size() { const r = canvas.getBoundingClientRect(); W = r.width; H = r.height; renderer.setSize(W, H, false); u.uRes.value.set(W, H); u.uK.value = o.size || .55; draw(); }
 const C = () => [((o.cx ?? .5) - .5) * W / Math.min(W, H) / u.uK.value, -((o.cy ?? .5) - .5) * H / Math.min(W, H) / u.uK.value];
 function draw() { const [cx, cy] = C(); blobs.forEach((b, i) => u.uB.value[i].set(cx + b.x, cy + b.y, b.r * .3 * (1 + (b.swell || 0)))); renderer.render(scene, cam); }
 function step(lv) {
  let e = 0; const t = performance.now() / 1000;
  blobs.forEach((b, i) => {
   // home: the centre for the core, a small ring for the others
   const hx = i ? Math.cos(b.a) * (.2 + .04 * (i % 2)) : 0, hy = i ? Math.sin(b.a) * .17 : 0;
   b.vx += (hx - b.x) * .06; b.vy += (hy - b.y) * .06;
   if (ptr) { const dx = b.x - ptr.x, dy = b.y - ptr.y, d2 = dx * dx + dy * dy + .002; if (d2 < .2) { b.vx += dx / d2 * .0016 * ptr.s; b.vy += dy / d2 * .0016 * ptr.s; } }
   b.vx *= .86; b.vy *= .86; b.x += b.vx; b.y += b.vy;
   b.swell = lv * (.22 + .1 * Math.sin(t * 9 + i * 1.7));
   e += Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(hx - b.x) * .05 + Math.abs(hy - b.y) * .05;
  });
  u.uDeep.value.lerp(target.deep, .08); u.uLit.value.lerp(target.lit, .08);
  const c = u.uLit.value, t2 = target.lit;
  return e + Math.abs(c.r - t2.r) + Math.abs(c.g - t2.g) + Math.abs(c.b - t2.b);
 }
 function frame() { const lv = reduced ? 0 : o.level(); const e = step(lv); draw(); if (e > .002 || lv > .01 || ptr) requestAnimationFrame(frame); else running = false; }
 function ring() { if (!running) { running = true; requestAnimationFrame(frame); } }
 canvas.addEventListener("pointermove", (ev) => {
  if (reduced) return;
  const r = canvas.getBoundingClientRect(), [cx, cy] = C(), m = Math.min(W, H) * u.uK.value;
  const x = (ev.clientX - r.left - W / 2) / m - cx, y = -(ev.clientY - r.top - H / 2) / m - cy;
  const sp = ptr ? Math.min(3, Math.hypot(x - ptr.x, y - ptr.y) * 40) : 0; ptr = {x, y, s: .4 + sp}; ring();
 });
 canvas.addEventListener("pointerleave", () => { ptr = null; ring(); });
 new ResizeObserver(size).observe(canvas);
 size();
 return {ring, mood(name, ms = 0) { const m = MOODS[name] || MOODS.calm; target.deep.copy(m[0]); target.lit.copy(m[1]); ring(); clearTimeout(moodT); if (ms) moodT = setTimeout(() => this.mood("calm"), ms); }};
}
