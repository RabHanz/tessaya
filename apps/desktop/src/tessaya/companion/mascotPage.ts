/**
 * What runs in the mascot's page (resources/tessaya/companion/stage.html): one rig, driven by cues from the main process.
 * The rig draws only while something moves, so a change runs at the display's own rate, as in the Character Studio.
 * Only long-running states keep a ceiling: speaking 30 a second, thinking 15, her sleeping breath 6.
 */
export const MASCOT_SCRIPT = String.raw`(() => {
 if (window.mascot) return;
 const raf = window.requestAnimationFrame.bind(window);
 let fps = Infinity, still = Infinity, lastT = 0;
 // Every callback asked for before the next frame runs in that one frame, so two loops never double the rate.
 let queued = [], timer = 0;
 window.requestAnimationFrame = (cb) => {
  queued.push(cb);
  if (timer) return 0;
  const run = () => raf((t) => {
   const early = 1000 / fps - (t - lastT);
   if (early > 4) { timer = setTimeout(run, early); return; }
   timer = 0; lastT = t; const due = queued; queued = []; for (const f of due) f(t);
  });
  const wait = 1000 / fps - (performance.now() - lastT);
  timer = wait > 2 ? setTimeout(run, wait) : (run(), 1);
  return 0;
 };
 window.cancelAnimationFrame = () => { queued = []; };
 const svg = document.getElementById("c");
 let rig = null, held = false, persona = "", level = 0, sound = { zcr: 0, bright: 0 }, speaking = false, moodProp = null;
 // her body's sounds and her bed (sounds.js), silent until the main process sends his levels
 const snd = TCS.SOUND ? TCS.SOUND.create({ P: () => (rig && rig.physics ? rig.physics() : null) }) : null;
 const ipc = window.mascotIpc;
 ipc.onLevel((v, shape) => { level = v; sound = shape || { zcr: 0, bright: 0 }; });
 // Her mouth from the sound she is playing: the level opens the jaw (fast attack, slow release, gated and normalised to
 // this voice's running peak). The shape is the viseme her reply's text aligned to this moment (visemes.ts) when there is
 // one; until the alignment reaches it, hiss, brightness against her own average and darkness pick one of six, each
 // held at least 45 ms, as the Character Studio's lipsync.js does.
 let cal, jaw, lastM, shapeNow, hold;
 const calibrate = () => { cal = { peak: 0.02, mean: 0, sd: 0.08, n: 0 }; jaw = 0; lastM = performance.now(); shapeNow = "mbp"; hold = 0; };
 calibrate();
 const mouth = () => {
  const now = performance.now(), dt = Math.min(0.05, (now - lastM) / 1000); lastM = now;
  cal.peak = Math.max(level, cal.peak * Math.pow(0.5, dt / 4));
  const gate = level < Math.max(0.004, cal.peak * 0.08);
  const target = gate ? 0 : Math.min(1, Math.pow(level / (cal.peak * 0.85), 0.7));
  jaw += (target - jaw) * (1 - Math.exp(-dt / (target > jaw ? 0.03 : 0.085)));
  if (!gate) { cal.n++; const k = Math.max(0.02, 1 / cal.n); if (cal.n === 1) cal.mean = sound.bright; cal.mean += (sound.bright - cal.mean) * k; cal.sd += (Math.abs(sound.bright - cal.mean) - cal.sd) * k; }
  const z = (sound.bright - cal.mean) / Math.max(0.03, cal.sd * 1.25);
  const next = sound.viseme ? sound.viseme : gate || jaw < 0.08 ? "rest" : sound.zcr > 0.22 && sound.bright > 0.35 ? "st" : sound.zcr > 0.14 && sound.bright > 0.25 && jaw < 0.45 ? "fv" : z < -0.55 ? "oh" : z > 0.55 ? "ee" : "aa";
  hold -= dt; if (sound.viseme || (next !== shapeNow && hold <= 0)) { if (next !== shapeNow) hold = 0.045; shapeNow = next; }
  return { open: jaw, shape: shapeNow };
 };
 const forever = { words: [], syl: [], events: [], vis: [], end: 1e9 };
 let lineNext = "";
 const planOf = (text) => typeof TCS.plan === "function" ? Object.assign({}, TCS.plan(String(text).slice(0, 600)), { vis: [], end: 1e9 }) : forever;
 // captured, so the release still arrives when her window moves out from under a fast hand
 svg.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; svg.setPointerCapture(e.pointerId); ipc.send("baton-mascot:press"); });
 const up = (e) => { if (e.button === 0 || e.type !== "pointerup") ipc.send("baton-mascot:release"); };
 addEventListener("pointerup", up);
 svg.addEventListener("pointercancel", up);
 svg.addEventListener("lostpointercapture", up);
 // a move with no button held means the release never came (seen on X11): let go now
 svg.addEventListener("pointermove", (e) => { if (e.buttons === 0 && svg.hasPointerCapture(e.pointerId)) { svg.releasePointerCapture(e.pointerId); } });
 svg.addEventListener("contextmenu", (e) => { e.preventDefault(); ipc.send("baton-mascot:menu"); });
 window.mascot = {
  init(o) {
   // Her persona record's body over the studio's preset (desktopMascot.ts bodyOf).
   const b = typeof o.persona === "string" ? { persona: o.persona } : o.persona;
   const B = TCS.PERSONAS[b.persona] || TCS.PERSONAS.custom;
   const P = { character: b.character || B.character, traits: Object.assign({}, B.traits, b.traits) };
   const key = JSON.stringify(P);
   if (rig && rig.handMode !== o.hands) rig.setHandMode(o.hands);
   if (rig && persona === key) return;
   persona = key;
   if (snd) snd.state({ energy: P.traits.energy ?? 0.5 });
   if (rig) { rig.setCharacter(P.character); rig.setPersonality(P.traits); return; }
   // at rest she costs next to nothing (release smoke): her blinks and idle acts draw 30 a second, Calm's half as often
   rig = TCS.create(svg, { character: P.character, personality: P.traits, expression: "neutral", intensity: 0.85, quiet: o.quiet, reduced: o.reduced, hands: o.hands, beatFps: 30, idleEvery: o.calm ? 2 : 1 });
   rig.hold(held);
  },
  // he is away (desktopMascot HOLD_AWAY_S): her blinks and idle acts wait; anything asked of her still plays
  hold(on) { held = on; if (rig) rig.hold(on); },
  cue(c) {
   if (!rig) return;
   still = c.expression === "asleep" ? 6 : c.expression === "thinking" ? 15 : Infinity;
   if (!speaking) fps = still;
   const name = TCS.EXPRESSIONS[c.expression] ? c.expression : "neutral";
   rig.setExpression(name, { noCut: name === "neutral", brief: !!c.brief, intensity: c.intensity ?? 0.85 });
   if (snd) snd.state({ group: TCS.EXPRESSIONS[name].g, asleep: name === "asleep" });
   if (c.clip) rig.play(c.clip);
   if (c.fx) rig.spawn(c.fx);
   // the prop her mood brings (tessaya-shared expressionMap): a new one replaces it, null puts it away
   if (c.prop !== undefined && c.prop !== moodProp) {
    if (moodProp) rig.prop(moodProp, false);
    moodProp = c.prop && TCS.PROPS[c.prop] ? c.prop : null;
    if (moodProp) rig.prop(moodProp, true);
   }
  },
  speak(on) {
   if (!rig || on === speaking) return;
   speaking = on; fps = on ? 30 : still;
   if (snd) snd.state({ speaking: on });
   if (on) { calibrate(); rig.speak(lineNext ? planOf(lineNext) : forever, { mouth }); lineNext = ""; } else rig.stopSpeech();
  },
  // the sentence now sounding: her gestures and feelings land on its words by meaning (speech.js), her mouth stays on
  // the audio; the plan never ends on its own, the sound does
  line(text) {
   if (!rig) return;
   if (!speaking) { lineNext = String(text); return; }
   rig.speak(planOf(text), { mouth });
  },
  play(name) { if (rig) rig.play(name); },
  motion(vx, vy) { if (rig && rig.motion) rig.motion(vx, vy); if (snd) snd.motion(vx, vy); },
  // her character's own body (bodies.js TCS.PHYSICS): her flight for the window's physics, and how she reacts
  physics() { return rig && rig.physics ? TCS.flightOf(rig.physics()) : null; },
  react(kind, speed) { if (rig && rig.react) rig.react(kind, speed || 0); if (snd && kind !== "trace") snd.react(kind, speed || 0); },
  // his levels (gains, 0 off), whether she shows, and whether he is talking to her (the bed steps back for the mic)
  audio(o) { if (snd) snd.state(o); },
  walk(ms, dir) { if (rig && rig.walk) rig.walk(ms, dir); else if (rig) rig.play("hop"); },
  look(gx, gy) { if (rig && rig.look) rig.look(gx, gy); },
  impact(speed, landed) { if (rig && rig.impact) rig.impact(speed, landed !== false); },
  // a moment as the brain worded it (tessaya-shared expression): her face and gesture, and the words above her head
  say(e) {
   if (!rig) return;
   if (e.mood && TCS.EXPRESSIONS[e.mood]) rig.setExpression(e.mood, { brief: true });
   if (e.gesture && e.gesture !== "none") rig.play(e.gesture);
   if (!e.text) return;
   let b = document.getElementById("say");
   if (!b) {
    b = document.createElement("div"); b.id = "say";
    b.style.cssText = "position:absolute;left:50%;top:4%;transform:translateX(-50%);max-width:94%;padding:3px 8px;border-radius:10px;background:#fff;color:#1c1b19;border:1px solid #d9d6cf;font:600 11px/1.25 system-ui,sans-serif;text-align:center;pointer-events:none;transition:opacity .25s";
    document.body.appendChild(b);
   }
   b.textContent = e.text; b.style.opacity = "1";
   clearTimeout(b.t); b.t = setTimeout(() => { b.style.opacity = "0"; }, 1200 + 260 * e.text.split(/\s+/).length);
  },
  // her character's own act, picked by the rig (rig.js signature) from her personality
  signature() { return rig && rig.signature ? rig.signature() : null; },
  // what she does with a quiet minute, by her personality: a walk, a funny moment or her own act
  idleChoice() {
   const T = rig ? rig.personality : { energy: 0.5, play: 0.5, formal: 0.5 };
   return TCS.util.weighted([["walk", 0.4 + T.energy], ["funny", 0.2 + T.play], ["signature", 0.4 + T.formal * 0.6]]);
  },
  press(a) { if (rig && rig.press) rig.press(a); if (snd) snd.press(a); },
  release() { if (rig && rig.release) rig.release(); if (snd) snd.release(); },
  // a funny moment of her own (bodies.js funny, likeliest first) or the one named; what the window must do with it
  humour(name, can) {
   if (!rig || !rig.humour) return null;
   const ok = (n) => (n !== "monocle" || rig.character === "tweed") && (n !== "hang" || (can && can.hang)) && (n !== "peek" || (can && can.peek));
   if (name && !ok(name)) return null;
   const list = (rig.physics().funny || []).filter(ok);
   const pick = name || list[Math.floor(Math.random() * Math.min(2, list.length))];
   if (!pick) return null;
   const r = rig.humour(pick);
   return r === null ? null : Object.assign({ name: pick }, r);
  },
 };
})();`;
