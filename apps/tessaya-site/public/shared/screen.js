/* The phone's screen in the Sleeve: Tessaya herself, the app's mascot rig (rig.js, bodies.js), lit by her mood.
 * Sized in container units, so the same markup fills a 2000 px bake for the Blender render and the live overlay.
 * TSScreen(el, {mood}) → {rig, mood(name, label)} */
(function (g) {
 const css = `.ps{position:absolute;inset:0;container-type:size;overflow:hidden;border-radius:6.4cqh;
  background:radial-gradient(120cqh 90cqh at 50% 62%,#2b2036 0%,#16121c 55%,#0c0a10 100%);color:#efe9f4;font-family:Archivo,system-ui,sans-serif}
 .ps svg{position:absolute;left:50%;top:0;height:96cqh;width:96cqh;transform:translateX(-50%);overflow:visible}
 .ps .ps-top{position:absolute;left:6cqh;top:5cqh;font-size:6cqh;letter-spacing:.02em;font-weight:600;opacity:.82}
 .ps .ps-top i{font-style:normal;font-weight:400;opacity:.6;margin-left:1.6cqh}
 .ps .ps-say{position:absolute;right:6cqh;bottom:6cqh;margin:0;font-size:5.4cqh;padding:1.6cqh 3.4cqh;border-radius:99cqh;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 .3cqh rgba(255,255,255,.14)}`;
 g.TSScreen = function (el, o = {}) {
  if (!document.getElementById("ps-css")) { const s = document.createElement("style"); s.id = "ps-css"; s.textContent = css; document.head.appendChild(s); }
  el.innerHTML = `<div class="ps"><p class="ps-top">Tessaya</p><svg aria-hidden="true"></svg><p class="ps-say">${o.label || "Happy"}</p></div>`;
  const rig = g.TCS.create(el.querySelector("svg"), {character: "selvedge", personality: (g.TCS.PERSONAS.tessaya || {}).traits || {}, expression: o.mood || "happy", intensity: 1, quiet: true});
  const say = el.querySelector(".ps-say");
  return {rig, mood(n, label) { rig.setExpression(n); say.textContent = label || n; }, who(name, ch) { rig.setCharacter(ch); el.querySelector(".ps-top").textContent = name; }};
 };
})(window);
