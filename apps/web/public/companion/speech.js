/* Body language from what she says. A light classifier reads the reply (and optional [tags]) and times gestures to
 * words; a syllable envelope stands in for her TTS amplitude and drives the mouth. Gestures land on phrases, the
 * mouth on syllables (TABY-BREAKDOWN §6). In the product the words' times come from the TTS engine's word marks. */
(function (g) {
 "use strict";
 const TCS = g.TCS;
 const W = (s) => new Set(s.split(" "));
 const AFFIRM = W("yes yeah yep yup exactly absolutely definitely correct indeed agreed"), SOFTYES = W("sure right okay ok done totally"),
  DENY = W("no nope not never don't can't won't isn't wasn't shouldn't hasn't haven't didn't doesn't nothing nobody nah"),
  UNSURE = W("maybe perhaps probably might guess possibly"),
  EXPLAIN = W("so because here's basically look first thing reason"),
  RECALL = W("remember yesterday earlier recall last"),
  SURPRISE = W("wow oh whoa really wait actually seriously"),
  INTENS = W("very really so super quite extremely");
 const MOODS = [
  [/\b(sorry|unfortunately|sadly|my fault|on me)\b/i, "concerned"],
  [/\b(missed|miss you|gone a while|lonely|without you)\b/i, "lonely"],
  [/\b(hmph|fine then)\b/i, "sulky"],
  [/\b(ugh|annoying|again\?!|third time)\b/i, "frustrated"],
  [/\b(on it|let's go|watch me)\b/i, "determined"],
  [/\b(haha|ha ha|lol)\b/i, "laughing"],
  [/\b(brilliant|amazing|yay|shipped|love it|fantastic|great news)\b/i, "happy"],
  [/\b(hmm|let me think)\b/i, "skeptical"],
  [/\banyway\b/i, "attentive"],
  [/\b(careful|warning|won't do that|without asking)\b/i, "determined"],
 ];
 // ── Lip sync: a light grapheme-to-phoneme pass turns each word into visemes (mouth shapes), timed across the word.
 // In production the TTS word timestamps (or a forced alignment of its audio) replace the estimated word times.
 const VIS = TCS.VISEMES = {
  rest: {label: "rest", mo: 0, mr: 0, mw: 0},
  mbp: {label: "M B P", mo: -.3, mr: 0, mw: -.08},
  fv: {label: "F V", mo: .1, mr: 0, mw: -.04, teeth: .9},
  th: {label: "TH", mo: .2, mr: 0, mw: 0, tongue: .8},
  l: {label: "L", mo: .32, mr: .1, mw: 0, tongue: .6},
  ee: {label: "EE", mo: .22, mr: 0, mw: .2, teeth: .6},
  aa: {label: "AA", mo: .72, mr: .1, mw: .06},
  uh: {label: "UH", mo: .42, mr: .2, mw: 0},
  oh: {label: "OH", mo: .55, mr: .85, mw: -.18},
  oo: {label: "OO", mo: .22, mr: 1, mw: -.38},
  sh: {label: "SH", mo: .22, mr: .55, mw: -.12, teeth: .6},
  er: {label: "R", mo: .25, mr: .45, mw: -.1},
  etc: {label: "S T D N K", mo: .18, mr: 0, mw: .04, teeth: .45},
 };
 const RULES = [["tion", ["sh", "uh", "etc"]], ["ough", ["oh"]], ["igh", ["aa", "ee"]], ["th", ["th"]], ["sh", ["sh"]], ["ch", ["sh"]], ["ph", ["fv"]], ["wh", ["oo"]], ["qu", ["etc", "oo"]],
  ["ck", ["etc"]], ["ng", ["etc"]], ["ee", ["ee"]], ["ea", ["ee"]], ["ie", ["ee"]], ["ey", ["ee"]], ["oo", ["oo"]], ["ew", ["oo"]], ["ue", ["oo"]], ["ou", ["aa", "oo"]], ["ow", ["aa", "oo"]],
  ["oi", ["oh", "ee"]], ["oy", ["oh", "ee"]], ["ai", ["aa", "ee"]], ["ay", ["aa", "ee"]], ["oa", ["oh"]], ["au", ["oh"]], ["aw", ["oh"]], ["er", ["er"]], ["ir", ["er"]], ["ur", ["er"]], ["or", ["oh", "er"]], ["ar", ["aa", "er"]]];
 const ONE = {a: "aa", e: "ee", i: "ee", o: "oh", u: "uh", y: "ee", b: "mbp", m: "mbp", p: "mbp", f: "fv", v: "fv", l: "l", r: "er", w: "oo", j: "sh", g: "etc", c: "etc", d: "etc", h: "uh", k: "etc", n: "etc", q: "etc", s: "etc", t: "etc", x: "etc", z: "etc"};
 TCS.g2v = function (word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, "").replace(/([^aeiou])\1+/g, "$1");
  if (w.length > 3) w = w.replace(/e$/, "");
  if (/^\d+$/.test(word)) w = "number";
  const out = [];
  for (let i = 0; i < w.length;) {
   const r = RULES.find(([g]) => w.startsWith(g, i));
   if (r) { out.push(...r[1]); i += r[0].length; } else { if (ONE[w[i]]) out.push(ONE[w[i]]); i++; }
  }
  return out.filter((v, i) => v !== out[i - 1]);
 };
 const sylls = (w) => Math.max(1, (w.toLowerCase().replace(/[^a-z]/g, "").replace(/e$/, "").match(/[aeiouy]+/g) || []).length);
 TCS.plan = function (text, o = {}) {
  const rate = o.rate || 1, toks = text.match(/\[[a-z:-]+\]|[^\s]+/gi) || [];
  const words = [], syl = [], events = [], display = [];
  let t = 0, phraseStart = 0, lastBody = -9, lastKind = {}, pendingTags = [], phraseHas = {};
  const body = (kind, at, amp = 1, word = -1, force = false) => {
   if (force && lastKind[kind] !== undefined && at - lastKind[kind] < .8) return;
   if (!force && at - lastBody < .5) return;
   if (!force && lastKind[kind] !== undefined && at - lastKind[kind] < 1.2) return;
   events.push({t: at, kind, amp, word}); lastBody = at; lastKind[kind] = at;
  };
  const next = (k, n = 1) => (toks[k + n] || "").toLowerCase().replace(/[^a-z']/g, "");
  let skip = -1;
  for (let k = 0; k < toks.length; k++) {
   const raw = toks[k];
   const tag = raw.match(/^\[([a-z:-]+)\]$/i);
   if (tag) { pendingTags.push(tag[1].toLowerCase()); continue; }
   const clean = raw.replace(/^[^\w']+|[^\w']+$/g, ""), lw = clean.toLowerCase(), i = words.length;
   const caps = clean.length > 1 && clean === clean.toUpperCase() && /[A-Z]/.test(clean), star = /^\*.*\*[.,!?]*$/.test(raw);
   const n = sylls(clean || "a"), stress = caps || star || /\d/.test(clean);
   const d = (.1 + n * .14) * (stress ? 1.2 : 1) / rate;
   words.push({w: raw.replace(/\*/g, ""), t, d, i, tags: []});
   for (let j = 0; j < n; j++) { const vow = (lw.match(/[aeiouy]+/g) || ["a"])[Math.min(j, (lw.match(/[aeiouy]+/g) || ["a"]).length - 1)]; syl.push({t: t + j * d / n, d: d / n * .92, a: (j === 0 ? 1 : .8) * (stress ? 1 : .85), round: /^[ou]/.test(vow) ? 1 : 0}); }
   // explicit tags win
   for (const tg of pendingTags) {
    const m = {nod: "nod", shake: "shake", shrug: "shrug", tilt: "question", lean: "explain", away: "recall", beat: "beat", brows: "surprise"}[tg];
    if (m) { body(m, t, 1, i, true); words[i].tags.push(m); }
    else if (tg.startsWith("expr:")) events.push({t, kind: "expr", name: tg.slice(5), word: i});
    else if (tg.startsWith("fx:")) events.push({t, kind: "fx", name: tg.slice(3), word: i});
    else if (tg.startsWith("prop:")) events.push({t, kind: "prop", name: tg.slice(5), word: i});
   }
   pendingTags = [];
   const first = t - phraseStart < .05, prev = words[i - 1] && words[i - 1].w.toLowerCase().replace(/[^a-z']/g, "");
   let kind = null, amp = 1;
   if (k === skip) { /* folded into the gesture before */ }
   else if (lw === "absolutely" && next(k) === "not") { kind = "shake"; amp = 1.25; skip = k + 1; }
   else if (lw === "not" && (next(k) === "sure" || next(k, 2) === "sure")) { kind = "shrug"; skip = next(k) === "sure" ? k + 1 : k + 2; }
   else if (DENY.has(lw) || /n't$/.test(lw)) { kind = "shake"; amp = lw === "no" || lw === "never" || lw === "nope" || prev === "absolutely" ? 1.15 : .7; }
   else if (AFFIRM.has(lw) || (SOFTYES.has(lw) && first)) { kind = "nod"; amp = lw === "absolutely" || lw === "exactly" ? 1.15 : 1; }
   else if (UNSURE.has(lw) || (lw === "sure" && prev === "not") || (lw === "think" && prev === "i" && !phraseHas.shrug)) kind = "shrug";
   else if (RECALL.has(lw) && (lw !== "last" || next(k) === "time")) kind = "recall";
   else if (SURPRISE.has(lw) && first) kind = "surprise";
   else if (EXPLAIN.has(lw) && (first || lw === "because" || lw === "here's")) kind = "explain";
   else if (stress || (prev && INTENS.has(prev) && clean.length > 3)) kind = "beat";
   if (kind && !(kind === "shrug" && phraseHas.shrug)) { const before = events.length; body(kind, t + (kind === "beat" ? .02 : 0), amp, i, kind === "nod" || kind === "shake"); if (events.length > before) { words[i].tags.push(kind); phraseHas[kind] = true; } }
   t += d;
   const punct = raw.match(/[.,;:!?…—-]+$/);
   if (/[?]/.test(raw)) { body("question", Math.max(phraseStart, t - .35), 1, i); if (events[events.length - 1] && events[events.length - 1].kind === "question" && events[events.length - 1].word === i) words[i].tags.push("question"); }
   if (punct) { const p = punct[0]; t += /…|\.\.\./.test(p) ? .6 : /[.!?]/.test(p) ? .42 : /[—-]/.test(p) ? .3 : .2; phraseStart = t; phraseHas = {}; }
   else t += .03;
  }
  // real word times (from the TTS or a forced alignment) replace the estimate; everything timed between words moves with them
  if (o.times && o.times.length === words.length) {
   const old = words.map((w) => [w.t, w.t + w.d]), nw = o.times;
   const map = (x) => { for (let i = 0; i < old.length; i++) { const [a, b] = old[i]; if (x <= b || i === old.length - 1) { if (x < a) { const pa = i ? old[i - 1][1] : 0, pn = i ? nw[i - 1][1] : 0; return pn + (x - pa) / Math.max(.001, a - pa) * (nw[i][0] - pn); } return nw[i][0] + (x - a) / Math.max(.001, b - a) * (nw[i][1] - nw[i][0]); } } return x; };
   for (const e of events) e.t = map(e.t);
   for (const y of syl) { const t0 = map(y.t), t1 = map(y.t + y.d); y.t = t0; y.d = Math.max(.04, t1 - t0); }
   words.forEach((w, i) => { w.t = nw[i][0]; w.d = Math.max(.05, nw[i][1] - nw[i][0]); });
   t = nw[nw.length - 1][1] + .15;
  }
  // feelings in the words set the face for the rest of the reply (the caller restores her mood afterwards)
  const joined = words.map((w) => w.w).join(" ");
  for (const [re, name] of MOODS) {
   const m = joined.match(re); if (!m) continue;
   let acc = 0, at = 0; for (const w of words) { if (acc >= m.index) { at = w.t; break; } acc += w.w.length + 1; }
   if (!events.some((e) => e.kind === "expr" && Math.abs(e.t - at) < .3)) events.push({t: Math.max(0, at - .1), kind: "expr", name, word: -1});
  }
  events.sort((a, b) => a.t - b.t);
  // visemes: each word's mouth shapes share its time, vowels a little longer; pauses close to rest
  const vis = [];
  for (const w of words) {
   const v = TCS.g2v(w.w); if (!v.length) continue;
   const wt = v.map((x) => /^(aa|ee|oh|oo|uh|er)$/.test(x) ? 1.6 : x === "mbp" ? .8 : 1), tot = wt.reduce((a, b) => a + b, 0);
   let c = w.t; v.forEach((x, i) => { const d = w.d * wt[i] / tot; vis.push({t: c, d, v: x, word: w.i}); c += d; });
   vis.push({t: c, d: .05, v: "rest", word: w.i});
  }
  return {words, syl, events, vis, end: t, text: words.map((w) => w.w).join(" ")};
 };

 // gesture → a plain label for the transcript
 TCS.GESTURE_LABEL = {nod: "nod", shake: "head shake", question: "tilt (question)", shrug: "shrug", explain: "lean in", recall: "look away", surprise: "brows up", beat: "beat"};

 TCS.SAMPLES = [
  {id: "done", label: "Affirming", text: "Yes, it's done. All FORTY tests pass, and the build is green."},
  {id: "no", label: "Denying", text: "No, don't push to main yet. The migration hasn't run."},
  {id: "unsure", label: "Unsure", text: "Hmm, maybe? I think it's the cache, but I'm not completely sure."},
  {id: "explain", label: "Explaining", text: "So here's the thing: the first job failed because the token expired."},
  {id: "recall", label: "Recalling", text: "Last time we tried this, it was the Wi-Fi. Remember?"},
  {id: "surprise", label: "Surprised", text: "Wait, really? It shipped already? That's brilliant!"},
  {id: "missed", label: "Missed you", text: "You were gone a while… I missed having you around. Anyway, three things need you."},
  {id: "sorry", label: "Owning a mistake", text: "I'm sorry, that one's on me. I've fixed it, and it won't happen again."},
  {id: "safety", label: "Firm on safety", text: "Absolutely not. That would delete your photos, and I won't do that without asking."},
  {id: "ugh", label: "Frustrated, then on it", text: "Ugh, the flaky test again. Third time today. Right, I'm on it."},
 ];
})(window);
