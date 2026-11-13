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
 let rig = null, persona = "", peak = 0.02, level = 0, speaking = false;
 const ipc = window.mascotIpc;
 ipc.onLevel((v) => { level = v; peak = Math.max(v, peak * 0.995); });
 // Her mouth from her own voice's level: louder opens wider, the quietest closes it.
 const mouth = () => {
  const open = level < peak * 0.08 ? 0 : Math.min(1, Math.pow(level / (peak * 0.85), 0.7));
  return { open, shape: open < 0.08 ? "mbp" : open > 0.6 ? "aa" : open > 0.3 ? "oh" : "ee" };
 };
 const forever = { words: [], syl: [], events: [], vis: [], end: 1e9 };
 svg.addEventListener("pointerdown", (e) => { if (e.button === 0) ipc.send("baton-mascot:press"); });
 addEventListener("pointerup", (e) => { if (e.button === 0) ipc.send("baton-mascot:release"); });
 svg.addEventListener("contextmenu", (e) => { e.preventDefault(); ipc.send("baton-mascot:menu"); });
 window.mascot = {
  init(o) {
   const P = TCS.PERSONAS[o.persona] || TCS.PERSONAS.tessaya;
   if (rig && persona === o.persona) return;
   persona = o.persona;
   if (rig) { rig.setCharacter(P.character); rig.setPersonality(P.traits); return; }
   rig = TCS.create(svg, { character: P.character, personality: P.traits, expression: "neutral", intensity: 0.85, quiet: o.quiet, reduced: o.reduced });
  },
  cue(c) {
   if (!rig) return;
   still = c.expression === "asleep" ? 6 : c.expression === "thinking" ? 15 : Infinity;
   if (!speaking) fps = still;
   rig.setExpression(c.expression, { noCut: c.expression === "neutral" });
   if (c.clip) rig.play(c.clip);
   if (c.fx) rig.spawn(c.fx);
  },
  speak(on) {
   if (!rig || on === speaking) return;
   speaking = on; fps = on ? 30 : still;
   if (on) { peak = 0.02; rig.speak(forever, { mouth }); } else rig.stopSpeech();
  },
  play(name) { if (rig) rig.play(name); },
 };
})();`;
