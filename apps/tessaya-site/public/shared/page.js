/* The home page: the hero's woven mark, the cast, the six moments, the drop, the sandbox and the Tessel family.
 * Each section below the hero builds itself only as it comes near the screen. Paths are relative to this file. */
import * as THREE from "./three.module.min.js";
import {Loom} from "./loom.js";
import {Drop} from "./drop.js";
const $ = (s) => document.querySelector(s);
const BASE = new URL("./", import.meta.url).href;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches, narrow = matchMedia("(max-width:860px)").matches;

// light and dark (R1-A Loom's switch)
$("#theme").onclick = () => { const d = document.documentElement, dark = d.dataset.theme ? d.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; d.dataset.theme = dark ? "light" : "dark"; loom && loom.ring(); };

// each section below the hero builds itself (rigs, eye WASM, physics, WebGL) only as it comes near the screen
const near = (el, fn, rootMargin = "600px") => new IntersectionObserver(([e], io) => { if (e.isIntersecting) { io.disconnect(); Promise.resolve().then(fn).catch((err) => console.warn("section unavailable", err)); } }, {rootMargin}).observe(el);

// the six moments; one voice for the whole page, so only one of her speaks at a time
const voice = TSVoice({base: BASE});
let scenes = null, drop = null;
near($("#moments"), async () => { scenes = await TSScenes({base: BASE, voice, root: $("#moments"), list: $("#scenes"), eyes: [$("#eL"), $("#eR")], eyesWatch: $("#pair"), rig: $("#rig"),
 log: $("#log"), board: $("#board"), title: $("#stitle"), note: $("#note"), stop: $("#stop"), status: $("#status"),
 item: (sc) => `<span class="n">${sc.n}</span><b>${sc.title}</b><span class="st">${TS_STATUS[sc.status]}</span><span class="k">${sc.kick}</span>`}); });
$("#scenes").addEventListener("click", () => { if (innerWidth < 900) $("#stage").scrollIntoView({behavior: "smooth", block: "start"}); });

// the mark rings and the drop swells whenever any of her voices speaks
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const loom = Loom($("#warp"), {THREE, colors: () => ({ink: css("--ink"), dye: css("--dye")}), level: () => voice.level(), fit: .92, cx: .5, cy: .5,
 onFrame: (lv) => { $("#line").style.setProperty("--w", (62 + lv * 46).toFixed(1)); }});
near($("#drop"), () => { drop = Drop($("#drop"), {THREE, level: () => voice.level(), cx: .5, cy: .5, size: narrow ? .66 : .6,
 moods: {calm: ["#6e3a8c", "#b689cc"], listening: ["#1f4a52", "#5f9fa8"], happy: ["#9a6c10", "#e5b532"]}});
 drop.ring(); });
const say0 = voice.say;
voice.say = (a, h = {}) => say0(a, {...h, onState: (s, w) => { if (s === "speaking") { loom.ring(); drop && drop.ring(); } h.onState && h.onState(s, w); }});
if (!reduced) setTimeout(() => loom.pluck(.8), 400);

// hero: her name is the wake word
$("#callHer").onclick = () => { $("#heard").textContent = "Wake word heard. She answers."; voice.yes("tessaya", {eyes: scenes && scenes.eyes, onState: (s) => { if (s === "idle") $("#heard").textContent = "That is all it takes. Then say what you need."; }}); };
$("#hearHer").onclick = () => voice.say({who: "tessaya", clip: "t-name", say: "Say my name.", eyes: "happy", quick: true}, {eyes: scenes && scenes.eyes});

// the story: the drop listens, then turns gold while she answers
$("#sayIt").onclick = () => {
 $("#heard2").textContent = "Wake word heard."; drop && drop.mood("listening");
 voice.yes("tessaya", {eyes: scenes && scenes.eyes, onState: (s) => { if (s === "speaking") drop && drop.mood("happy", 2200); if (s === "idle") $("#heard2").textContent = "That is all it takes. Then say what you need."; }});
};

// the cast shelf: tap one and she answers to her name
const SHELF = ["freya", "alfred", "tessaya", "sebastian", "onyx"];
near($("#shelf"), () => { for (const who of SHELF) {
 const W = TS_WHO[who], b = document.createElement("button"); b.className = "char"; b.type = "button";
 if (!W.yes) b.dataset.soon = "";
 b.innerHTML = `<svg aria-hidden="true"></svg><span>${W.name}</span>`;
 b.setAttribute("aria-label", W.yes ? `${W.name}: hear her answer` : `${W.name}: no lines on this page yet`);
 const rig = TCS.create(b.querySelector("svg"), {character: W.ch, personality: (TCS.PERSONAS[who] || {}).traits || {}, expression: "neutral", intensity: .9, quiet: true});
 b.onclick = () => {
  if (!W.yes) { rig.react("poke"); $("#castNote").textContent = "Onyx has no lines on this page yet. For now he only goes thud."; return; }
  $("#castNote").textContent = `${W.name}, in the ${W.voice} voice.`; voice.yes(who, {rig});
 };
 $("#shelf").appendChild(b);
} });

// the sandbox: the word is the ground, its cap height a shelf, the bin on the floor to the right
near($("#poke"), () => {
const pit = $("#pit"), word = $("#word"), hint = $("#hint"), HINT = hint.textContent;
const binEl = document.createElement("div"); binEl.className = "bin"; pit.appendChild(binEl);
binEl.innerHTML = `<svg viewBox="0 0 60 70" width="100%" height="100%"><path d="M5 9 L10 68 H50 L55 9 Z" fill="var(--ink)"/><ellipse cx="30" cy="9" rx="25" ry="5" fill="var(--dye)"/><path d="M20 22 V58 M30 24 V60 M40 22 V58" stroke="var(--paper)" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/></svg>`;
let flashT = 0;
const flash = (t) => { hint.textContent = t; hint.classList.add("flash"); clearTimeout(flashT); flashT = setTimeout(() => { hint.textContent = HINT; hint.classList.remove("flash"); }, 3200); };
const world = TSWorld(pit, {
 size: (w) => Math.min(150, Math.max(84, w / 7.5)),
 ledges: () => { const pr = pit.getBoundingClientRect(), r = word.getBoundingClientRect(); return [{x1: r.left - pr.left + r.width * .01, x2: r.right - pr.left - r.width * .01, y: r.top - pr.top + r.height * .03 + 3}]; },
 bin: (w, h, S) => { const tw = Math.max(44, S * .42), th = tw * 1.15, tx = w - tw - Math.max(8, w * .02); Object.assign(binEl.style, {left: tx + "px", top: h - th + "px", width: tw + "px", height: th + "px"}); return {x1: tx, x2: tx + tw, y: h - th}; },
 onTalk: (b) => { const who = Object.keys(TS_WHO).find((k) => TS_WHO[k].ch === b.id); if (!who || !TS_WHO[who].yes) return false; voice.yes(who, {rig: b.rig}); return true; },
 onFull: () => flash("That's eight, a full house. Take one out to bring in another."),
 onCount: (n) => { $("#count").textContent = `${n} of 8`; },
});
const toss = (id) => world.add(id, null, -world.S * .3, {vx: (Math.random() - .5) * 500});
const personas = Object.values(TS_WHO).map((w) => w.ch);
for (const w of Object.values(TS_WHO)) { const b = document.createElement("button"); b.className = "p"; b.textContent = "+ " + w.name; b.onclick = () => toss(w.ch); $("#cast-p").appendChild(b); }
for (const id of TS_BODIES.filter((i) => !personas.includes(i))) { const b = document.createElement("button"); b.textContent = "+ " + TS_NAME(id); b.onclick = () => toss(id); $("#cast-b").appendChild(b); }
document.querySelectorAll("[data-tool]").forEach((b) => b.onclick = () => { world.tool = b.dataset.tool; document.querySelectorAll("[data-tool]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); });
$("#clear").onclick = () => world.reset();
$("#pop").onclick = () => world.pop();
document.fonts.ready.then(() => world.layout && world.layout());
new IntersectionObserver(([e], io) => { if (e.isIntersecting) { io.disconnect(); world.drop(["selvedge", "felt", "tweed", "spool"]); } }, {threshold: .25}).observe(pit);
});

// the family: each device its own turntable, turned by hand; one eye renderer for Tuft and the Tumble, the app's rig on the phone
const spins = [];
// Tuft's eyes sit under domes that refract them: the live eyes hand over to the render within ~20 degrees of the front
// each turntable's front frame comes once the page is idle after load, so a fast scroll never meets an empty card; TSSpin waits for the rest
const idle = (fn) => addEventListener("load", () => (window.requestIdleCallback || setTimeout)(fn, {timeout: 2000}), {once: true});
const spin = (el, name, screens) => idle(() => TSSpin(el, {src: el.dataset.src, name, screens, fade: el.classList.contains("tuft") ? [.9, .97] : undefined}).then((s) => spins.push(s), (err) => console.warn("turntable unavailable", err)));
const scr = (el) => [...el.querySelectorAll(".spin-screens>div")];
spin($("#pair"), "Tuft", scr($("#pair")));
spin($("#spinTuft"), "Tuft", scr($("#spinTuft")));
spin($("#spinTumble"), "the Tumble", scr($("#spinTumble")));
spin($("#spinSleeve"), "the Sleeve", scr($("#spinSleeve")));
near($("#tessel"), async () => {
const fam = [[$("#fL"), $("#fR")], [$("#tL"), $("#tR")]].map((p) => p.map((c) => c.getContext("2d")));
const teyes = await TSEyes({wasm: BASE + "r1eyes-live.wasm", watch: $("#render"), onDraw: (c) => fam.forEach((x) => TSEyesBlit(x, c))});
teyes.persona(1); teyes.expr("happy");
const phone = TSScreen($("#phone"), {mood: "happy", label: "Happy"});
const front = () => spins.forEach((s) => s.front());
const press = (box, b) => box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
let group = "";
for (const [n, label, g] of TS_EYELIST.moods) {
 if (g !== group) { group = g; $("#moods").insertAdjacentHTML("beforeend", `<span class="g">${g}</span>`); }
 const b = document.createElement("button"); b.textContent = label; b.setAttribute("aria-pressed", String(n === "happy"));
 b.onclick = () => { teyes.expr(n); phone.mood(n, label); press($("#moods"), b); front(); };
 $("#moods").appendChild(b);
}
for (const n of TS_EYELIST.gestures) { const b = document.createElement("button"); b.textContent = n.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase()); b.onclick = () => { teyes.play(n); front(); }; $("#gestures").appendChild(b); }
for (const [k, i] of Object.entries(teyes.PERSONA)) { const b = document.createElement("button"); b.textContent = TS_WHO[k].name; b.setAttribute("aria-pressed", String(i === 1)); b.onclick = () => { teyes.persona(i); phone.who(TS_WHO[k].name, TS_WHO[k].ch); press($("#persona"), b); }; $("#persona").appendChild(b); }
}, "900px");
