/* The voice demo: one pre-rendered line in the persona's real on-device voice (Pocket TTS, rendered ahead of time),
 * her Soft Marimba cues around it, the real eyes and the real rig reacting. The mouth follows the audio itself
 * (lipsync.js); gestures and the transcript follow the words, stretched to the clip's real length.
 * TSVoice({base}) → {say(action, {rig, eyes, onWord, onState}) → Promise<"done"|"stopped"|"blocked">, stop(), yes(who, {rig, eyes})}
 * The eyes follow each [expr:…] beat (and the moods the planner reads) on the audio clock, as the rig does. */
(function (g) {
 "use strict";
 g.TSVoice = function (o) {
  const base = o.base;
  const cue = (n, vol = .55) => { const a = new Audio(`${base}sounds/${n}.mp3`); a.volume = vol; a.play().catch(() => {}); };
  let cur = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function stop(barge = true) {
   if (!cur) return;
   const c = cur; cur = null;
   c.resolve("stopped"); c.audio.pause(); c.ls && c.ls.stop(); cancelAnimationFrame(c.raf);
   c.rig && c.rig.stopSpeech();
   if (barge) { c.eyes && c.eyes.expr("attentive"); c.rig && c.rig.setExpression("attentive", {brief: true}); cue("end"); }
   c.onState && c.onState(barge ? "stopped" : "idle");
  }
  async function say(act, h = {}) {
   stop(false);
   const W = g.TS_WHO[act.who];
   const audio = new Audio(`${base}voice/${act.clip}.m4a`); audio.preload = "auto";
   let resolve; const finished = new Promise((r) => (resolve = r));
   const c = cur = {audio, rig: h.rig, eyes: h.eyes, onState: h.onState, raf: 0, ls: null, resolve};
   h.onState && h.onState("waking");
   if (h.eyes) { h.eyes.persona(h.eyes.PERSONA[act.who] ?? 1); h.eyes.expr("attentive"); h.eyes.gaze(0, -.05, 1200); }
   if (h.rig && h.rig.character !== W.ch) h.rig.setCharacter(W.ch);
   h.rig && h.rig.setExpression("attentive", {brief: true});
   cue("wake");
   await wait(act.quick ? 260 : 520); if (cur !== c) return finished;
   if (!act.quick) { h.onState && h.onState("thinking"); h.eyes && h.eyes.expr("thinking"); cue("thinking", .35); }
   await Promise.all([wait(act.quick ? 0 : 650), new Promise((r) => (audio.readyState >= 1 ? r() : audio.addEventListener("loadedmetadata", r, {once: true})))]);
   if (cur !== c) return finished;
   const est = TCS.plan(act.say), f = Math.max(.6, (audio.duration - .15) / est.end);
   const plan = TCS.plan(act.say, {times: est.words.map((w) => [w.t * f, (w.t + w.d) * f])});
   h.eyes && h.eyes.expr(act.eyes);
   h.onState && h.onState("speaking", plan.words);
   try { c.ls = TCS.LipSync.attach(audio); } catch { c.ls = null; }
   const hooks = {
    onWord: (i) => h.onWord && h.onWord(i, plan.words),
    mouth: () => (c.last = c.ls && !audio.paused ? c.ls.read() : null),
    onEnd: () => {},
   };
   audio.addEventListener("playing", () => {
    if (cur !== c) return;
    h.rig && h.rig.speak(plan, hooks);
    const beats = h.eyes || h.onBeat ? plan.events.filter((e) => e.kind === "expr") : [];
    const tick = () => { if (cur !== c) return; h.rig && h.rig.speechTime(audio.currentTime);
     while (beats.length && beats[0].t <= audio.currentTime) { const n = beats.shift().name; h.eyes && h.eyes.expr(n); h.onBeat && h.onBeat(n); } if (!audio.paused && !audio.ended) c.raf = requestAnimationFrame(tick); };
    tick();
   }, {once: true});
   audio.addEventListener("ended", () => {
    if (cur !== c) return;
    cur = null; c.ls && c.ls.stop(); cue("finished", .4); resolve("done");
    h.eyes && h.eyes.expr(act.after || "calm"); h.rig && h.rig.setExpression(act.after || "neutral", {noCut: true});
    h.onState && h.onState("idle");
   }, {once: true});
   audio.play().catch(() => { h.onState && h.onState("blocked"); cur = null; resolve("blocked"); });
   return finished;
  }
  async function yes(who, h = {}) {
   const W = g.TS_WHO[who]; if (!W || !W.yes) return;
   return say({who, clip: W.yes, say: {tessaya: "Yes?", freya: "Mm-hm?", alfred: "Sir?", sebastian: "Go on."}[who], eyes: "attentive", quick: true}, h);
  }
  return {say, stop: () => stop(true), yes, get busy() { return !!cur; }, level: () => (!cur || !cur.ls || cur.audio.paused ? 0 : cur.rig ? (cur.last ? cur.last.open : 0) : cur.ls.read().open)};
 };
})(window);
