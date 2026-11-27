/* Six short scenes that show the brain behind the face. Each is a list of steps: what you say, what a persona says
 * (your side spoken by a Gemini TTS voice, then a clip in her real Pocket TTS voice, with [expr:…] beats the eyes and body follow), and what the board shows
 * (a memory row, a plan, a playbook line). Statuses follow the LEDGER: live, in our evals, or coming.
 * TSScenes({base, list, eyes:[cL, cR], eyesWatch, rig: svg, log, board, title, note, stop, status, item(scene) → html}) */
(function (g) {
 "use strict";
 g.TS_SCENES = [
  {id: "memory", n: "01", title: "Memory", kick: "She remembers, then uses it", status: "live", who: "freya",
   note: "Every memory is a row you can see, edit or forget. She recalls the ones that fit the moment.",
   board: `<div class="card mem" data-r="row"><small>Memory · from you, Monday</small><b>Coffee: black, no sugar</b><span class="acts"><i>Pin</i><i>Edit</i><i>Forget</i></span></div>
    <div class="card recall" data-r="recall"><small>Recalled for this reply</small><b>Coffee: black, no sugar</b><b>Coming up: review due 17:00</b></div>`,
   steps: [
    {you: "Freya, black coffee for me, no sugar, by the way.", clip: "u-coffee1", at: "Mon 09:12"},
    {her: "freya", clip: "f-coffee1", say: "[expr:happy] Black, no sugar. Noted. [expr:playful] Brave of you.", after: "happy"},
    {on: "row"}, {wait: 1100},
    {you: "Ugh, this review is taking forever. I'm grabbing a coffee.", clip: "u-coffee2", at: "Thu 15:40"},
    {on: "recall"}, {wait: 500},
    {her: "freya", clip: "f-coffee2", say: "[expr:happy] Black, no sugar, I know. [expr:playful] Quick one, though. [expr:attentive] The review's due at five and you're down to the last file.", after: "happy"},
   ]},
  {id: "dictation", n: "02", title: "Dictation", kick: "Say it messy, get it clean", status: "live", who: "tessaya",
   note: "Hold Ctrl+Alt+Space, talk, let go. Fillers and the bit you took back are gone before you look up.",
   board: `<div class="card dict"><small>Hold Ctrl+Alt+Space · speaking</small><p class="raw" data-dict></p></div>
    <div class="card field" data-r="field"><small>#launch · message</small><p class="out"></p><span class="clock" data-s="clock"></span></div>`,
   steps: [
    {dictate: {words: "um can we move the the standup to ten no ten thirty the client's flying in".split(" "), clip: "u-dictate", filler: [0, 4], fix: [8, 9],
     clean: "Can we move the standup to 10:30? The client's flying in.", ms: 480}},
   ]},
  {id: "team", n: "03", title: "Orchestration", kick: "One sentence, a whole team", status: "live", who: "tessaya",
   note: "Jobs, persona roles and approvals on your phone are live. Personas handing work to each other is coming.",
   board: `<ol class="plan">
    <li data-r="p1"><b>Onyx</b><span>Build and run the checks</span><em data-s="p1">queued</em></li>
    <li data-r="p2"><b>Sebastian</b><span>Release post, in your voice</span><em data-s="p2">queued</em></li>
    <li data-r="p3"><b>Your phone</b><span>Approve the release</span><em data-s="p3">waiting</em></li></ol>
    <div class="card live" data-r="live"><b>Live at 21:14</b><small>She told you on your phone.</small></div>`,
   steps: [
    {you: "Tessaya, can you get tonight's release out? Ping me when it's live.", clip: "u-release", at: "Fri 20:58"},
    {her: "tessaya", clip: "t-release1", say: "[expr:determined] Right. [lean] Onyx takes the build and the checks. Sebastian writes the post in your voice. [expr:focused] Nothing ships until you say yes.", after: "focused",
     cues: [[1.2, {on: "p1", set: {p1: "running"}}], [3.6, {on: "p2", set: {p2: "writing"}}], [6.4, {on: "p3"}]]},
    {set: {p1: "38 of 41 green"}}, {wait: 600},
    {her: "sebastian", clip: "s-release", say: "[expr:skeptical] Draft's done. I took out the line about it being twice as fast. [shake] We can't prove that yet.", after: "smug"},
    {set: {p2: "draft ready · 1 claim cut", p1: "41 of 41 green"}},
    {her: "tessaya", clip: "t-release2", say: "[expr:happy] All forty-one checks are green. [expr:attentive] Say yes and it goes.", after: "attentive", cues: [[2.4, {set: {p3: "tap to approve"}}]]},
    {wait: 500}, {you: "Yes, go.", clip: "u-yes"}, {set: {p3: "approved"}}, {wait: 900}, {on: "live", sound: "approval", eyes: "delighted"},
   ]},
  {id: "learning", n: "04", title: "Self-learning", kick: "Corrected once, right the next time", status: "evals", who: "alfred",
   note: "Each correction becomes a line in that job's playbook. The loop runs in our evals; in the app, it is coming.",
   board: `<div class="card book" data-r="learn"><small>Playbook · weekly spending</small><b>Lead with the total, then anything unusual. Nothing else.</b><em>Learned from your correction, week 1</em></div>
    <div class="card used" data-r="used"><small>Week 2</small><b>Playbook line used</b></div>`,
   steps: [
    {you: "Alfred, how's my spending looking this week?", clip: "u-spend1", at: "Week 1"},
    {her: "alfred", clip: "a-spend1", say: "[expr:focused] Twelve receipts this week, across four categories. Groceries came to one hundred and eighty pounds, a little above usual, largely owing to the", cut: 5.9},
    {you: "Too long, Alfred. Just the total and anything weird.", clip: "u-spend2"},
    {her: "alfred", clip: "a-spend2", say: "[expr:embarrassed] Understood.", after: "calm"},
    {on: "learn", sound: "approval"}, {wait: 1400},
    {you: "Alfred, this week?", clip: "u-spend3", at: "Week 2"}, {on: "used"},
    {her: "alfred", clip: "a-spend3", say: "[expr:proud] Four hundred and twelve pounds. [expr:skeptical] One oddity: the gym charged you twice. [nod] I'd query it.", after: "proud"},
   ]},
  {id: "proactive", n: "05", title: "Proactive", kick: "She speaks first", status: "coming", who: "freya",
   note: "Nobody asked. She noticed the hour, the green build and a promise due tomorrow. Coming.",
   board: `<div class="card clock" data-r="clock"><b>01:52</b><small>No one has said a word</small></div>
    <ul class="signals"><li data-r="s1">At the desk since 19:40</li><li data-r="s2">Build green, deploy at 08:00</li><li data-r="s3">Nothing needs you before 10:00</li><li data-r="s4">Review notes promised for Friday</li></ul>`,
   steps: [
    {on: "clock", eyes: "sleepy"}, {wait: 700}, {on: "s1"}, {wait: 450}, {on: "s2"}, {wait: 450}, {on: "s3"}, {wait: 700},
    {her: "freya", clip: "f-late1", say: "[expr:concerned] It's nearly two, and honestly, you're worrying me. [expr:calm] The build's green and nothing needs you before ten. I'll keep an eye on the deploy. [expr:sleepy] Go to bed.", after: "calm"},
    {on: "s4"}, {wait: 500},
    {her: "freya", clip: "f-late2", say: "[expr:curious] Oh, and you promised the review notes by Friday. That's tomorrow. [expr:playful] Want me to start them, or is that a morning job?", after: "attentive"},
   ]},
  {id: "emotion", n: "06", title: "Emotion", kick: "Feeling that moves with every word", status: "live", who: "tessaya",
   note: "The eyes have 44 moods and 33 gestures, the code the Tumble runs. Face and body follow the words as she says them, not a loop.",
   board: `<ol class="moods"><li data-mood="concerned">Concerned</li><li data-mood="thinking">Thinking</li><li data-mood="relieved">Relieved</li><li data-mood="happy">Happy</li></ol>`,
   steps: [
    {you: "Hey, did the deploy go out?", clip: "u-deploy", at: "Fri 21:30"},
    {her: "tessaya", clip: "t-deploy", say: "[expr:concerned] Not yet. It failed on the last step. [expr:thinking] Hang on. It's the flaky test again; [expr:relieved] your code's fine. The rerun's green. [expr:happy] We're live.", after: "happy"},
   ]},
 ];
 g.TS_STATUS = {live: "Live", evals: "In our evals", coming: "Coming"};

 g.TSScenes = async function (o) {
  const voice = o.voice || g.TSVoice({base: o.base});
  const rig = o.rig ? TCS.create(o.rig, {character: "selvedge", personality: TCS.PERSONAS.tessaya.traits, expression: "neutral", intensity: 1}) : null;
  const ctxs = (o.eyes || []).map((c) => c.getContext("2d"));
  let eyes = null;
  try {
   eyes = await g.TSEyes({wasm: o.base + "r1eyes-live.wasm", watch: o.eyesWatch,
    onDraw: (cv) => g.TSEyesBlit(ctxs, cv)});
   eyes.persona(1);
  } catch { if (o.status) o.status.textContent = "The eye renderer could not load in this browser."; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cue = (n, v = .5) => { const a = new Audio(`${o.base}sounds/${n}.mp3`); a.volume = v; a.play().catch(() => {}); };
  let token = 0, scene = null, human = null;
  // your side of the moment: a Gemini TTS clip; the words light up across its real length
  async function speak(clip, spans, t) {
   const a = human = new Audio(`${o.base}voice/${clip}.m4a`);
   await new Promise((r) => { a.addEventListener("loadedmetadata", r, {once: true}); a.addEventListener("error", r, {once: true}); });
   if (!live(t)) return;
   const total = spans.reduce((n, s) => n + s.textContent.length + 2, 0), dur = (a.duration || spans.length * .3) * 1000;
   const ended = new Promise((r) => { a.addEventListener("ended", r, {once: true}); a.addEventListener("pause", r, {once: true}); });
   if (await a.play().then(() => true, () => false)) {
    for (const s of spans) { if (!live(t)) return; s.classList.add("said"); await wait(dur * (s.textContent.length + 2) / total); }
    await ended;
   } else { if (o.status) o.status.textContent = "Tap the moment again to let the page play sound."; for (const s of spans) { s.classList.add("said"); await wait(70 + s.textContent.length * 14); } }
  }
  const btns = [];
  const live = (t) => t === token;
  const R = (k) => o.board.querySelectorAll(`[data-r~="${k}"]`);
  const S = (k) => o.board.querySelector(`[data-s="${k}"]`);
  function apply(st) {
   if (st.on) for (const k of [].concat(st.on)) R(k).forEach((e) => e.classList.add("on"));
   if (st.set) for (const [k, v] of Object.entries(st.set)) { const e = S(k); if (e) { e.textContent = v; e.classList.add("new"); setTimeout(() => e.classList.remove("new"), 700); } }
   if (st.sound) cue(st.sound, .45);
   if (st.eyes) { eyes && eyes.expr(st.eyes); rig && rig.setExpression(st.eyes, {brief: true}); }
  }
  function line(cls, who, text, at) {
   const p = document.createElement("p"); p.className = cls;
   p.innerHTML = `<small>${at ? `<time>${at}</time> · ` : ""}${who}</small><span class="w">${text}</span>`;
   o.log.appendChild(p); while (o.log.children.length > 4) o.log.firstElementChild.remove();
   return p.querySelector(".w");
  }
  async function you(st, t) {
   rig && rig.setExpression("attentive", {brief: true}); eyes && eyes.expr("attentive"); eyes && eyes.gaze(.25, .1, 1600);
   const w = line("you", "You", st.you.split(" ").map((x) => `<span>${x}</span>`).join(" "), st.at), spans = [...w.children];
   if (st.clip) await speak(st.clip, spans, t);
   else for (const s of spans) { if (!live(t)) return; s.classList.add("said"); await wait(70 + s.textContent.length * 14); }
   await wait(380);
  }
  async function her(st, t) {
   const W = g.TS_WHO[st.her];
   if (rig && TCS.PERSONAS[st.her]) rig.setPersonality(TCS.PERSONAS[st.her].traits);
   const w = line("her", W.name, "…");
   const timers = [];
   const p = voice.say({who: st.her, clip: st.clip, say: st.say, eyes: "attentive", after: st.after}, {rig, eyes,
    onBeat: (n) => o.board.querySelectorAll(`[data-mood]`).forEach((e) => { if (e.dataset.mood === n) e.classList.add("on"); }),
    onWord: (i) => [...w.children].forEach((s, k) => { s.classList.toggle("now", k === i); s.classList.toggle("said", k < i); }),
    onState: (s, ws) => {
     o.root.dataset.state = s; o.stop.hidden = !(s === "speaking" || s === "thinking" || s === "waking") && !scene;
     if (s === "speaking") {
      w.innerHTML = ws.map((x) => `<span>${x.w}</span>`).join(" ");
      for (const [at, c] of st.cues || []) timers.push(setTimeout(() => live(t) && apply(c), at * 1000));
      if (st.cut) timers.push(setTimeout(() => { if (live(t)) { voice.stop(); w.insertAdjacentHTML("beforeend", ` <em class="cut">(you cut in)</em>`); } }, st.cut * 1000));
     }
     if (s === "idle") w.querySelectorAll("span").forEach((x) => { x.classList.remove("now"); x.classList.add("said"); });
     if (s === "blocked" && o.status) o.status.textContent = "Tap the scene again to let the page play sound.";
    }});
   const r = await p; timers.forEach(clearTimeout);
   if (r === "stopped" && st.cut && live(t)) { await wait(250); return; }
   if (r !== "done") token++;
   await wait(260);
  }
  async function dictate(st, t) {
   const d = st.dictate, raw = o.board.querySelector("[data-dict]"), out = o.board.querySelector(".out");
   rig && rig.setExpression("attentive", {brief: true}); eyes && eyes.expr("attentive"); cue("wake");
   raw.innerHTML = d.words.map((x) => `<span>${x}</span>`).join(" ");
   const spans = [...raw.children];
   if (d.clip) await speak(d.clip, spans, t);
   else for (const s of spans) { if (!live(t)) return; s.classList.add("said"); await wait(150 + s.textContent.length * 26); }
   await wait(350); if (!live(t)) return;
   raw.parentElement.querySelector("small").textContent = "Let go · cleaning";
   eyes && eyes.expr("focused"); rig && rig.setExpression("focused", {brief: true});
   d.filler.forEach((i) => spans[i].classList.add("x")); await wait(160);
   d.fix.forEach((i) => spans[i].classList.add("fix"));
   R("field").forEach((e) => e.classList.add("on"));
   const t0 = performance.now(), n = d.clean.length;
   while (live(t)) { const k = Math.min(n, Math.round((performance.now() - t0) / d.ms * n)); out.textContent = d.clean.slice(0, k); if (k >= n) break; await new Promise(requestAnimationFrame); }
   if (!live(t)) return;
   S("clock").textContent = `${(d.ms / 1000).toFixed(2)} s after you let go`;
   raw.parentElement.querySelector("small").textContent = "Struck: fillers, and the part you took back";
   cue("finished", .4); eyes && eyes.expr("happy"); rig && rig.setExpression("happy", {brief: true});
  }
  async function play(sc) {
   const t = ++token; scene = sc; o.stop.hidden = false; human && human.pause(); voice.stop(); await wait(0);
   if (!live(t)) return;
   btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === sc.id)));
   o.board.innerHTML = sc.board; o.board.dataset.scene = sc.id; o.log.innerHTML = "";
   o.title && (o.title.textContent = `${sc.n} ${sc.title}`);
   o.note && (o.note.textContent = sc.note);
   o.status && (o.status.textContent = "");
   o.stop.hidden = false;
   if (eyes) eyes.persona(eyes.PERSONA[sc.who] ?? 1);
   if (rig) { if (rig.character !== g.TS_WHO[sc.who].ch) rig.setCharacter(g.TS_WHO[sc.who].ch); TCS.PERSONAS[sc.who] && rig.setPersonality(TCS.PERSONAS[sc.who].traits); }
   for (const st of sc.steps) {
    if (!live(t)) return;
    if (st.you) await you(st, t);
    else if (st.her) await her(st, t);
    else if (st.dictate) await dictate(st, t);
    else if (st.wait) await wait(st.wait);
    if (st.on || st.set || st.sound || st.eyes) live(t) && apply(st);
   }
   if (live(t)) { scene = null; o.stop.hidden = true; btns.forEach((b) => b.setAttribute("aria-pressed", "false")); o.root.dataset.state = "idle"; }
  }
  function stop() { token++; scene = null; human && human.pause(); voice.stop(); o.stop.hidden = true; btns.forEach((b) => b.setAttribute("aria-pressed", "false")); }
  for (const sc of g.TS_SCENES) {
   const b = document.createElement("button"); b.type = "button"; b.className = "scene"; b.dataset.id = sc.id; b.dataset.status = sc.status;
   b.setAttribute("aria-pressed", "false"); b.innerHTML = o.item(sc); btns.push(b); o.list.appendChild(b);
   b.onclick = () => play(sc);
  }
  o.stop.hidden = true; o.stop.onclick = stop;
  return {voice, eyes, rig, play, stop};
 };
})(window);
