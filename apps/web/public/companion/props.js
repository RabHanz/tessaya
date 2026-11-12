/* Props: each one means one real thing (EMOTION-SYSTEM.md §5.3). Held in a hand, worn, floating above her or placed in
 * front: never behind the body and never cut by the frame. Each enters, leaves faster than it came, and has a use
 * she acts out now and then: a sip, an adjustment, a tap. */
(function (g) {
 "use strict";
 const TCS = g.TCS, {clamp, lerp, f1, bell, ramp, ease, hold} = TCS.util;
 const PI = Math.PI, TAU = PI * 2;
 const IV = "#F7F2E7", INK = "#1f1b1d", GOLD = "#E8A75A", GOLDD = "#b9782c", MAD = "#D64550", MADD = "#8E1F2F", WOAD = "#2A8C96", WOADD = "#14505A",
  DAM = "#6a3a80", LEAF = "#5f9a5a", LEAFD = "#3d6b3a", WOOD = "#C99A68", WOODD = "#8b6239", STEEL = "#b8c0c8", STEELD = "#5f6871", SKY = "#9fd4f2", PAPER = "#fbf7ee", PAPERD = "#d8cfbd";
 const O = `stroke="${INK}" stroke-opacity=".55" stroke-width="1.8" stroke-linejoin="round"`;
 const shine = (x, y, w, h, r = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="#fff" opacity=".5" transform="rotate(${r} ${x} ${y})"/>`;
 const steam = (t, x, y) => [0, 1].map((i) => { const p = ((t * .7 + i * .5) % 1); return `<path d="M${x + i * 8} ${f1(y - p * 10)}q-4 -3.5 0 -7q4 -3.5 0 -7" stroke="#c9cdd3" stroke-width="2.4" fill="none" stroke-linecap="round" opacity="${f1(Math.sin(p * PI) * .8)}"/>`; }).join("");

 // ── Uses: what she does with a prop. fn(t 0..1) → {hands: {L,R: [spot, pose, dx, dy, r]}, d: face deltas, pr: prop rotate, pdy: prop lift} ──
 const USE = {
  // the sip: the cup rises on an eased path to her lips, tilts a little toward them while her head dips to meet it,
  // holds, then levels and comes down. The rim stays at the mouth; the wrist only tilts, it never spins.
  sip:    {dur: 2200, fn: (t) => { const up = ease(ramp(t, .05, .3)) * (1 - ease(ramp(t, .74, .95))), tip = ease(ramp(t, .3, .42)) * (1 - ease(ramp(t, .62, .74)));
   return {hands: {R: up > .01 ? ["sip", "grip", 0, 14 * (1 - up), -12 * tip] : ["hold", "grip"]}, d: {pitch: .1 * tip, sarc: .95 * ramp(tip, .5, 1), cheek: .4 * up, mc: .15 * up, mw: -.35 * up, mo: .25 * bell(t, .78, .95), mr: .8 * bell(t, .78, .95)}, using: up > .02}; }},
  peer:   {dur: 2200, fn: (t) => { const h = hold(t, .08, .25, .78, .95); return {hands: {R: ["eye", "grip", 2, 30 * h + 4 * (1 - h)]}, d: {lu: .35 * h, tongue: 1 * h, mo: 0, mx: .35 * h, mc: .2 * h, tilt: -4 * h}, lens: h}; }},
  adjust: {dur: 1100, fn: (t) => { const h = hold(t, .05, .3, .65, .9); return {hands: {R: ["bridge", "pushup", 0, 2 * bell(t, .35, .7)]}, d: {by: -3 * bell(t, .3, .7), bo: .5 * h, mc: .1 * h}, wornDy: -3 * bell(t, .35, .7)}; }},
  monocle: {dur: 1400, fn: (t) => { const h = hold(t, .05, .3, .7, .92); return {hands: h > .02 ? {R: ["monocleRim", "grip", 0, -3 * bell(t, .35, .65)]} : null, d: {bas: 1.3 * h, bo: h, by: -2 * h, mx: .15 * h, mc: .1 * h}, wornDy: -2.5 * bell(t, .35, .65)}; }},
  tap:    {dur: 1300, fn: (t) => ({d: {gx: -.45 * bell(t, 0, 1), gy: .45 * bell(t, 0, 1), mc: .15 * bell(t, 0, 1)}, pr: 6 * Math.sin(t * TAU * 4) * bell(t, .2, .8), pdy: -3 * Math.abs(Math.sin(t * TAU * 2)) * bell(t, .1, .9)})},
  tick:   {dur: 1500, fn: (t) => ({pr: 5 * Math.sin(t * TAU * 1.5) * bell(t, 0, 1), d: {gx: -.45 * bell(t, 0, 1), gy: .5 * bell(t, 0, 1), mx: .2 * bell(t, 0, 1), mc: .2 * ramp(t, .6, .9)}})},
  turn:   {dur: 1200, fn: (t) => ({pr: 45 * Math.abs(Math.sin(t * TAU * 1.5)) * bell(t, 0, 1), d: {gx: .4 * bell(t, 0, 1), gy: .4 * bell(t, 0, 1), la: .2 * bell(t, 0, 1), bo: .6 * bell(t, 0, 1), tongue: .8 * bell(t, .2, .8), mx: .3 * bell(t, .2, .8)}})},
  hammer: {dur: 1300, fn: (t) => ({pr: 40 * Math.max(0, Math.sin(t * TAU * 2.5)) * bell(t, 0, 1), d: {gx: .35 * bell(t, 0, 1), gy: .4 * bell(t, 0, 1), lu: .2 * bell(t, 0, 1)}})},
  ear:    {dur: 2600, fn: (t) => { const h = hold(t, .05, .2, .82, .95); return {hands: {R: ["ear", "grip", 0, 0, -8]}, d: {tilt: 9 * h, gx: .35 * h, gy: -.2 * h, mo: .25 * Math.abs(Math.sin(t * TAU * 4)) * h, mc: .2 * h}}; }},
  wave:   {dur: 1200, fn: (t) => ({hands: {R: ["up", "grip", 10, 30, 20 * Math.sin(t * TAU * 2.5)]}, d: {mc: .25 * bell(t, 0, 1), lift: -3 * bell(t, 0, 1)}})},
  stamp:  {dur: 1300, fn: (t) => { const up = ease(ramp(t, .05, .35)) * (1 - ease(ramp(t, .45, .55))); return {hands: {R: ["hold", "grip", -10, -28 * up + 6 * bell(t, .5, .62)]}, d: {lu: .25 * up, la: .3 * up, bo: up, ba: .4 * up, sy: -.06 * bell(t, .5, .65), mc: .4 * ramp(t, .6, .8)}, mark: ramp(t, .52, .58)}; }},
  click:  {dur: 900, fn: (t) => ({pr: 8 * bell(t, .3, .5), d: {wink: hold(t, .1, .2, .7, .9), mc: .3 * bell(t, 0, 1)}, flash: t > .4 && t < .5})},
  ring:   {dur: 1400, fn: (t) => ({pr: 14 * Math.sin(t * TAU * 9) * bell(t, 0, .9), pdy: -3 * bell(t, 0, 1), d: {eh: .12 * bell(t, 0, .5), bo: bell(t, 0, 1), by: -6 * bell(t, 0, 1)}})},
  twirl:  {dur: 1600, fn: (t) => ({pr: 10 * Math.sin(t * TAU * 2), d: {tilt: 4 * Math.sin(t * TAU), mc: .2 * bell(t, 0, 1)}})},
  paint:  {dur: 1500, fn: (t) => ({hands: {R: ["present", "grip", 8 * Math.sin(t * TAU * 2), -6 * Math.cos(t * TAU * 2), -20]}, d: {gx: .45 * bell(t, 0, 1), tongue: bell(t, .1, .9), mx: .3 * bell(t, .1, .9)}})},
  pour:   {dur: 1600, fn: (t) => ({pr: -35 * hold(t, .15, .35, .7, .9), pour: hold(t, .3, .4, .65, .75), d: {gx: .5 * bell(t, 0, 1), gy: .5 * bell(t, 0, 1), mc: .3 * bell(t, 0, 1)}})},
  curl:   {dur: 1600, fn: (t) => ({hands: {R: ["hold", "grip", 0, -22 * Math.max(0, Math.sin(t * TAU * 2))]}, d: {chev: .9 * hold(t, .1, .2, .8, .9), teeth: .7 * bell(t, .1, .9), mo: .2 * bell(t, .1, .9), flush: .3 * bell(t, 0, 1)}})},
  sweep:  {dur: 1600, fn: (t) => ({pr: 22 * Math.sin(t * TAU * 2), d: {gy: .55 * bell(t, 0, 1), mc: .2 * bell(t, 0, 1)}})},
  swoosh: {dur: 1100, fn: (t) => ({pr: 55 * ease(ramp(t, .2, .45)) * (1 - ramp(t, .75, 1)), d: {la: .4 * bell(t, 0, 1), bo: bell(t, 0, 1), ba: .5 * bell(t, 0, 1), mc: .2 * ramp(t, .5, .8)}})},
  dab:    {dur: 1600, fn: (t) => { const h = hold(t, .1, .3, .7, .9); return {hands: {R: ["eye", "grip", 8, 10, -10 + 8 * Math.sin(t * TAU * 3) * h]}, d: {wink: h * .9, wet: .6, mc: .1 * h}}; }},
  offer:  {dur: 1400, fn: (t) => { const h = hold(t, .1, .3, .75, .95); return {hands: {R: ["present", "grip", -4 * h, 26 * h]}, d: {blush: .6 * h, arc: .8 * h, mc: .4 * h}, ps: .12 * h}; }},
  munch:  {dur: 1500, fn: (t) => ({hands: {L: ["snack", "grip", 0, 3 * Math.sin(t * TAU * 3)]}, d: {mo: .25 * Math.abs(Math.sin(t * TAU * 3)), cheek: .4, puff: .5 * bell(t, .3, .9), arc: .7 * bell(t, .2, .9)}})},
  mash:   {dur: 1400, fn: (t) => ({pr: 4 * Math.sin(t * TAU * 6), d: {gy: .4, la: .3 * bell(t, 0, 1), tongue: bell(t, .1, .9), mx: .3 * bell(t, 0, 1), tilt: 5 * Math.sin(t * TAU)}})},
  swing:  {dur: 1300, fn: (t) => ({pr: 25 * Math.sin(t * TAU * 1.5) * bell(t, 0, 1), d: {mc: .3 * bell(t, 0, 1), lift: -3 * Math.abs(Math.sin(t * TAU * 1.5))}})},
  check:  {dur: 1500, fn: (t) => { const h = hold(t, .1, .25, .75, .9); return {hands: {R: ["present", "grip", -10 * h, -14 * h]}, d: {gx: .5 * h, gy: .3 * h, bo: .7 * h, bas: .8 * h, mr: .4 * h}}; }},
  jiggle: {dur: 1100, fn: (t) => ({pr: 7 * Math.sin(t * TAU * 4) * bell(t, 0, 1), d: {gy: .4 * bell(t, 0, 1), mc: .3 * bell(t, 0, 1), mr: .3 * bell(t, .2, .8)}})},
  shake:  {dur: 1100, fn: (t) => ({hands: {R: ["ear", "grip", 4, 12 + 4 * Math.sin(t * TAU * 6)]}, d: {tilt: 8 * bell(t, 0, 1), gx: .4 * bell(t, 0, 1), mr: .5 * bell(t, 0, 1)}})},
  bob:    {dur: 2000, fn: (t) => ({pr: 8 * Math.sin(t * TAU * 1.5), pdy: -4 * Math.sin(t * TAU), d: {gy: -.4 * bell(t, 0, 1), mc: .3 * bell(t, 0, 1)}})},
  flip:   {dur: 1200, fn: (t) => ({spin: 180 * ease(ramp(t, .2, .7)), d: {gx: .4 * bell(t, 0, 1), gy: .3 * bell(t, 0, 1)}})},
  raise:  {dur: 1600, fn: (t) => { const h = hold(t, .05, .25, .8, .95); return {hands: h > .05 ? {L: ["overhead", "grip", 0, 8 * (1 - h)], R: ["overhead", "grip", 0, 8 * (1 - h)]} : null, d: {arc: h, mo: .6 * h, mc: 1 * h, lift: -8 * h, glow: .4 * h}}; }},
  launch: {dur: 1800, fn: (t) => { const h = hold(t, .05, .2, .4, .5); return {hands: h > .05 ? {L: ["overhead", "grip"], R: ["overhead", "grip"]} : null, d: {star: hold(t, .5, .6, .85, 1), mo: .5 * bell(t, .45, 1), gy: -.8 * ramp(t, .4, .6), lift: -5 * h}, fly: ramp(t, .45, 1)}; }},
  listen: {dur: 2000, fn: (t) => ({hands: {R: ["cheek", "back", 16, -10]}, d: {arc: .8 * bell(t, .1, .9), pitch: .12 * Math.abs(Math.sin(t * TAU * 2)), mc: .3, tilt: 4 * Math.sin(t * TAU * 2)}, fx: "notes"})},
  knock:  {dur: 1100, fn: (t) => ({hands: {R: ["head", "fist", 0, -2 + 5 * Math.abs(Math.sin(t * TAU * 2))]}, d: {gy: -.6 * bell(t, 0, 1), mc: .3 * bell(t, 0, 1)}, wornDy: 2 * Math.abs(Math.sin(t * TAU * 2))})},
  slide:  {dur: 1500, fn: (t) => ({hands: {R: ["bridge", "pushup", 0, 10 * hold(t, .2, .35, .65, .8)]}, d: {gy: -.3 * bell(t, 0, 1), bas: bell(t, 0, 1), bo: bell(t, 0, 1), mx: .3 * bell(t, 0, 1), mc: .4 * bell(t, 0, 1)}, wornDy: 10 * hold(t, .2, .35, .65, .8)})},
  read:   {dur: 2000, fn: (t) => ({d: {gy: .5, gx: lerp(-.4, .4, (t * 3) % 1), lu: .1}})},
  type:   {dur: 2400, fn: (t) => ({hands: {L: ["keysL", "back", 0, -3 * Math.max(0, Math.sin(t * TAU * 7)), 10], R: ["keysR", "back", 0, -3 * Math.max(0, Math.sin(t * TAU * 7 + 1.7)), 10]}, d: {gy: .5, gx: .1 * Math.sin(t * TAU * 2), lu: .15, mx: .15}})},
  open:   {dur: 1600, fn: (t) => ({d: {star: hold(t, .4, .5, .85, 1), mo: .6 * ramp(t, .4, .5), mr: .8, lift: -6 * bell(t, .4, .9)}, lid: ease(ramp(t, .25, .5))})},
  grow:   {dur: 1500, fn: (t) => ({d: {gy: .5 * bell(t, 0, 1), arc: .8 * bell(t, .4, 1), mc: .4 * bell(t, 0, 1)}, grow: ease(ramp(t, .2, .8))})},
  ping:   {dur: 900, fn: (t) => ({ps: .25 * bell(t, 0, .5), d: {bo: bell(t, 0, 1), by: -8 * bell(t, 0, 1), eh: .1 * bell(t, 0, 1), gy: -.6 * bell(t, 0, 1)}})},
 };
 TCS.USES = USE;

 // ── The props. mount: R or L (a hand), both (two hands), head, face, float (above her) or front (placed before her) ──
 const P = TCS.PROPS = {};
 const add = (id, label, cat, when, mount, use, draw, o = {}) => P[id] = Object.assign({id, label, cat, when, mount, use, draw}, o);
 // held: drawn with the grip at the origin, the hand closes over it
 add("monocle", "Monocle", "Signature", "Alfred's own: reading, or a dry raised brow", "face", "monocle", null, {worn: "monocle"});
 add("coffee", "Coffee", "Daily", "The morning brief", "R", "sip", (k) => `<g transform="translate(-16 6)"><path d="M10 -18a8.5 8.5 0 0 1 0 17" fill="none" stroke="${INK}" stroke-opacity=".55" stroke-width="7"/><path d="M10 -18a8.5 8.5 0 0 1 0 17" fill="none" stroke="${IV}" stroke-width="4.5"/><path d="M-13 -24h23v26a6 6 0 0 1 -6 6h-11a6 6 0 0 1 -6 -6z" fill="${IV}" ${O}/><rect x="-13" y="-15" width="23" height="7" fill="${WOAD}"/>${shine(-10, -21, 3, 18)}${k.warm && !k.using ? steam(k.t, -7, -28) : ""}</g>`, {warm: true});
 add("tea", "Tea", "Daily", "The evening wind-down", "R", "sip", (k) => `<g transform="translate(-17 4)"><path d="M12 -11a6.5 6.5 0 0 1 0 11" fill="none" stroke="${INK}" stroke-opacity=".55" stroke-width="6"/><path d="M12 -11a6.5 6.5 0 0 1 0 11" fill="none" stroke="${PAPER}" stroke-width="3.6"/><path d="M-15 -14h28q0 18 -14 18q-14 0 -14 -18z" fill="${PAPER}" ${O}/><ellipse cx="-1" cy="-14" rx="14" ry="3" fill="#b07a3c"/><path d="M-12 -9q11 4 22 0" stroke="${MAD}" stroke-width="2" fill="none" opacity=".7"/>${k.warm && !k.using ? steam(k.t, -8, -18) : ""}</g>`, {warm: true});
 add("water", "Glass of water", "Daily", "Time to drink some water", "R", "sip", () => `<g transform="translate(-12 6)"><path d="M-11 -30h22l-3 34h-16z" fill="${SKY}" fill-opacity=".45" ${O}/><path d="M-10 -16h20l-2 20h-16z" fill="${SKY}"/><path d="M-10 -16q5 -3 10 0t10 0" fill="none" stroke="#fff" stroke-width="1.5"/>${shine(-7, -27, 2.5, 26)}</g>`);
 add("magnifier", "Magnifier", "Work", "Researching: a web search or a Sebastian job", "R", "peer", () => `<rect x="-3.5" y="-8" width="7" height="26" rx="3.5" fill="${WOODD}" ${O}/><circle cy="-30" r="20" fill="${SKY}" fill-opacity=".22" stroke="${GOLD}" stroke-width="5"/><circle cy="-30" r="20" fill="none" stroke="${INK}" stroke-opacity=".4" stroke-width="1"/><path d="M-11 -40q4 -6 11 -6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>`, {lens: {x: 0, y: -30, r: 18}, at: ["hold", "grip", 0, 14]});
 add("wrench", "Wrench", "Work", "Fixing: CI went red and a fix job runs", "R", "turn", () => `<g transform="rotate(-20)"><rect x="-4.5" y="-30" width="9" height="44" rx="4.5" fill="${STEEL}" ${O}/><path d="M-13 -38a14 14 0 1 0 26 0l-7 7h-12z" fill="${STEEL}" ${O}/>${shine(-2, -26, 2.5, 30)}</g>`);
 add("hammer", "Hammer", "Work", "Building: an agent is editing code", "R", "hammer", () => `<rect x="-3.5" y="-34" width="7" height="46" rx="3" fill="${WOOD}" ${O}/><rect x="-16" y="-44" width="32" height="13" rx="3" fill="${STEELD}" ${O}/>${shine(-13, -42, 20, 3)}`);
 add("pencil", "Pencil", "Work", "Drafting a message for you", "R", "paint", () => `<g transform="rotate(25)"><rect x="-4" y="-38" width="8" height="44" fill="${GOLD}" ${O}/><path d="M-4 6l4 10l4 -10z" fill="${PAPER}" ${O}/><path d="M-1.4 12.5l1.4 3.5l1.4 -3.5z" fill="${INK}"/><rect x="-4" y="-44" width="8" height="7" rx="2" fill="${MAD}" ${O}/></g>`);
 add("phone", "Phone", "People", "On a call, or texting someone for you", "R", "ear", () => `<g transform="translate(0 -12)"><rect x="-10" y="-32" width="20" height="36" rx="5" fill="${INK}"/><rect x="-8.5" y="-30.5" width="17" height="33" rx="4" fill="#3a3f4a"/><rect x="-6.5" y="-28.5" width="7" height="9" rx="2.5" fill="${INK}"/><circle cx="-4.6" cy="-26.4" r="1.5" fill="#6d7a8a"/><circle cx="-2" cy="-22.2" r="1.5" fill="#6d7a8a"/><circle cx="3" cy="-9" r="3" fill="none" stroke="#6d7a8a" stroke-width="1"/></g>`);
 add("envelope", "Envelope", "People", "A new email worth your time", "R", "wave", () => `<g transform="rotate(-8)"><rect x="-20" y="-30" width="40" height="27" rx="3" fill="${PAPER}" ${O}/><path d="M-20 -30l20 15l20 -15" fill="none" ${O}/><circle cx="0" cy="-15" r="4.5" fill="${MAD}"/></g>`);
 add("stamp", "Approval stamp", "Work", "Approved: something you OK'd went through", "R", "stamp", (k) => `<rect x="-5" y="-30" width="10" height="20" rx="4" fill="${WOOD}" ${O}/><circle cy="-33" r="8" fill="${WOOD}" ${O}/><rect x="-15" y="-11" width="30" height="10" rx="2" fill="${MADD}" ${O}/>`, {mark: true});
 add("stopwatch", "Stopwatch", "Time", "A deadline is close", "R", "click", () => `<rect x="-3" y="-44" width="6" height="7" fill="${STEELD}"/><circle cy="-24" r="16" fill="${IV}" stroke="${STEELD}" stroke-width="4"/><path d="M0 -24v-10M0 -24l7 5" stroke="${MAD}" stroke-width="2.4" stroke-linecap="round"/>`, {at: ["hold", "grip", 0, 14]});
 add("alarmclock", "Alarm clock", "Time", "Your alarm: time to get up", "R", "ring", () => `<circle cx="-12" cy="-40" r="7" fill="${GOLD}" ${O}/><circle cx="12" cy="-40" r="7" fill="${GOLD}" ${O}/><circle cy="-24" r="17" fill="${MAD}" ${O}/><circle cy="-24" r="12.5" fill="${IV}"/><path d="M0 -24v-8M0 -24h6" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><path d="M-12 -8l-4 6M12 -8l4 6" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`, {at: ["hold", "grip", 0, 20]});
 add("key", "Key", "Home", "The front door was unlocked", "R", "turn", () => `<circle cy="-30" r="11" fill="${GOLD}" ${O}/><circle cy="-30" r="4.5" fill="${GOLDD}"/><rect x="-3" y="-20" width="6" height="26" fill="${GOLD}" ${O}/><path d="M3 -2h6M3 3h4" stroke="${GOLD}" stroke-width="4"/>`);
 add("umbrella", "Umbrella", "Weather", "Rain in the forecast", "R", "twirl", (k) => { const B = k.B, F = k.F; if (!B) return ""; const hx = Math.max(B.hw * .86, F.ex + F.ew * .6 + 30), hy = Math.min(-8, Math.max(B.cy + B.h * .3, F.cy + F.mY + 18)), cx = -hx * .22 / 1.3, cy = (B.top - 30 - hy) / 1.3; // the shaft rises up her side, outside her face
  // held low at her side, the canopy opens over her head: the shaft is as long as this body needs
  return `<path d="M0 6L${f1(cx)} ${f1(cy + 2)}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/><path d="M0 6q0 7 -6 7" stroke="${INK}" stroke-width="3.2" fill="none" stroke-linecap="round"/><g transform="translate(${f1(cx)} ${f1(cy)})"><path d="M-48 2Q-46 -32 0 -32Q46 -32 48 2Q36 -6 24 2Q12 -6 0 2Q-12 -6 -24 2Q-36 -6 -48 2Z" fill="${WOAD}" ${O}/><path d="M-24 2Q-21 -26 0 -32Q21 -26 24 2" fill="#fff" opacity=".15"/><circle cy="-33" r="2.5" fill="${INK}"/></g>`; });
 add("flag", "Flag", "Wins", "A milestone reached", "R", "wave", (k) => `<rect x="-2" y="-62" width="4" height="70" rx="2" fill="${WOODD}"/><path d="M2 -60q14 ${f1(-4 + 4 * Math.sin(k.t * 6))} 28 0t28 0v22q-14 ${f1(-4 - 4 * Math.sin(k.t * 6))} -28 0t-28 0z" fill="${MAD}" ${O}/>`);
 add("camera", "Camera", "Work", "A screenshot or photo was saved", "R", "click", () => `<rect x="-22" y="-30" width="44" height="30" rx="6" fill="${INK}"/><rect x="-14" y="-36" width="12" height="8" rx="2" fill="${INK}"/><circle cy="-15" r="10" fill="${STEELD}" stroke="${STEEL}" stroke-width="3"/><circle cx="-3" cy="-18" r="3" fill="#fff" opacity=".7"/>`);
 add("microphone", "Microphone", "Voice", "Dictation is running", "R", "click", () => `<rect x="-3" y="-14" width="6" height="22" fill="${STEELD}"/><rect x="-9" y="-44" width="18" height="30" rx="9" fill="${STEEL}" ${O}/><path d="M-9 -34h18M-9 -27h18" stroke="${STEELD}" stroke-width="1.5"/>${shine(-6, -40, 2.5, 20)}`);
 add("paintbrush", "Paintbrush", "Work", "Design work in progress", "R", "paint", () => `<g transform="rotate(30)"><rect x="-3" y="-30" width="6" height="40" rx="3" fill="${WOOD}" ${O}/><rect x="-5" y="-38" width="10" height="9" fill="${STEEL}"/><path d="M-5 -38q5 -16 10 0z" fill="${DAM}"/></g>`);
 add("wateringcan", "Watering can", "Habits", "A habit or plant reminder", "R", "pour", (k) => `<path d="M-18 -30h26v28h-26z" fill="${LEAF}" ${O}/><path d="M8 -24l20 -14" stroke="${LEAF}" stroke-width="5" stroke-linecap="round"/><path d="M-18 -26q-10 6 0 16" stroke="${LEAFD}" stroke-width="3" fill="none"/>${k.pour ? [0, 1, 2].map((i) => `<circle cx="${30 + i * 3}" cy="${f1(-36 + ((k.t * 60 + i * 9) % 26))}" r="2" fill="${SKY}"/>`).join("") : ""}`, {at: ["hold", "grip", -6, 0]});
 add("dumbbell", "Dumbbell", "Habits", "Your workout reminder", "R", "curl", () => `<rect x="-20" y="-6" width="40" height="6" rx="3" fill="${STEELD}"/><rect x="-26" y="-14" width="10" height="22" rx="3" fill="${INK}"/><rect x="16" y="-14" width="10" height="22" rx="3" fill="${INK}"/>`);
 add("broom", "Broom", "Work", "A clean-up job: old branches, disk space", "R", "sweep", () => `<rect x="-2.5" y="-50" width="5" height="70" rx="2.5" fill="${WOOD}" ${O}/><path d="M-12 18h24l6 22h-36z" fill="${GOLD}" ${O}/><path d="M-8 24v14M0 24v15M8 24v14" stroke="${GOLDD}" stroke-width="1.5"/>`, {at: ["hold", "grip", -8, -10]});
 add("bugnet", "Bug net", "Work", "Hunting a flaky test", "R", "swoosh", () => `<rect x="-2.5" y="-34" width="5" height="44" rx="2.5" fill="${WOOD}"/><ellipse cy="-48" rx="16" ry="14" fill="${IV}" fill-opacity=".35" stroke="${INK}" stroke-opacity=".6" stroke-width="2.5"/><path d="M-12 -44q12 18 24 0" stroke="${INK}" stroke-opacity=".25" fill="none"/>`, {at: ["hold", "grip", 0, 20]});
 add("torch", "Torch", "Work", "Digging through logs", "R", "sweep", () => `<path d="M4 -34L60 -60L60 -8Z" fill="#FFE9A8" opacity=".35"/><rect x="-8" y="-40" width="16" height="44" rx="4" fill="${DAM}" ${O}/><rect x="-10" y="-46" width="20" height="9" rx="3" fill="${STEEL}" ${O}/>`);
 add("tissue", "Tissue", "Feelings", "After a sad moment, hers or yours", "R", "dab", () => `<path d="M-12 -20q4 -14 12 -10q8 -6 12 8q2 14 -12 14q-14 0 -12 -12z" fill="#ffffff" ${O}/><path d="M-4 -18q4 4 8 0" stroke="${PAPERD}" fill="none"/>`);
 add("heart", "Heart", "Feelings", "Affection (rare)", "R", "offer", () => `<path d="M0 6C-26 -8 -20 -34 0 -24C20 -34 26 -8 0 6Z" fill="${MAD}" ${O}/>${shine(-12, -24, 3, 9, -30)}`);
 add("popcorn", "Popcorn", "Leisure", "You're watching something, or on a break", "L", "munch", () => `<path d="M-14 -24h28l-4 28h-20z" fill="${PAPER}" ${O}/><path d="M-11 -24l2 28M-2 -24v28M7 -24l-1 28" stroke="${MAD}" stroke-width="3"/>${[-9, -2, 5, 11, -5, 3].map((x, i) => `<circle cx="${x}" cy="${-27 - (i > 3 ? 6 : 0)}" r="5.5" fill="#fff6d8" ${O}/>`).join("")}`);
 add("controller", "Game controller", "Leisure", "Break time", "both", "mash", () => `<path d="M-30 -10q0 -14 14 -14h32q14 0 14 14l4 12q2 10 -8 10q-6 0 -10 -8h-32q-4 8 -10 8q-10 0 -8 -10z" fill="${DAM}" ${O}/><rect x="-26" y="-27" width="14" height="5" rx="2.5" fill="#3c2148"/><rect x="12" y="-27" width="14" height="5" rx="2.5" fill="#3c2148"/><path d="M-12 -8h24" stroke="#3c2148" stroke-width="2" stroke-linecap="round"/><circle cx="0" cy="-15" r="2" fill="#3c2148"/>`);
 add("shoppingbag", "Shopping bag", "Errands", "An order was placed by the shop job", "R", "swing", () => `<path d="M-8 -6q0 -14 8 -14q8 0 8 14" stroke="${INK}" stroke-width="2.5" fill="none"/><path d="M-18 -4h36l3 40h-42z" fill="${GOLD}" ${O}/><path d="M-8 10l6 6l10 -12" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`, {at: ["hold", "grip", 0, -6]});
 add("thermometer", "Thermometer", "Home", "The heating changed", "R", "check", () => `<rect x="-6" y="-42" width="12" height="40" rx="6" fill="#fff" ${O}/><circle cy="0" r="9" fill="${MAD}" ${O}/><rect x="-2.5" y="-28" width="5" height="26" rx="2.5" fill="${MAD}"/><path d="M6 -36h5M6 -28h3M6 -20h5" stroke="${INK}" stroke-width="1.5"/>`);
 add("pillbox", "Pill box", "Health", "A medication reminder", "R", "shake", () => `<rect x="-20" y="-24" width="40" height="22" rx="5" fill="${IV}" ${O}/>${[-13, -4, 5, 14].map((x, i) => `<rect x="${x - 3}" y="-21" width="7" height="16" rx="2" fill="${[WOAD, GOLD, MAD, DAM][i]}" opacity=".85"/>`).join("")}`);
 add("balloon", "Balloon", "Wins", "A birthday or a celebration", "R", "bob", (k) => { const B = k.B, F = k.F; if (!B) return ""; const hy = Math.min(-8, Math.max(B.cy + B.h * .3, F.cy + F.mY + 18)), L = Math.max(60, (hy - (B.top - 10)) / 1.3); return `<path d="M0 0q${f1(6 * Math.sin(k.t * 2))} ${f1(-L / 2)} ${f1(8)} ${f1(-L)}" stroke="${INK}" stroke-width="1.5" fill="none"/><g transform="translate(${f1(8 + 2 * Math.sin(k.t * 2))} ${f1(-L - 22)})"><ellipse rx="20" ry="24" fill="${MAD}" ${O}/><path d="M-2 24l4 0l-2 4z" fill="${MAD}"/>${shine(-10, -14, 4, 12, -20)}</g>`; });
 add("hourglass", "Hourglass", "Time", "Waiting on your approval", "R", "flip", (k) => `<g transform="rotate(${f1(k.spin || 0)} 0 -22)"><rect x="-16" y="-48" width="32" height="6" rx="2" fill="${WOOD}" ${O}/><rect x="-16" y="-2" width="32" height="6" rx="2" fill="${WOOD}" ${O}/><path d="M-12 -42h24q0 14 -10 19q10 5 10 19h-24q0 -14 10 -19q-10 -5 -10 -19z" fill="${SKY}" fill-opacity=".35" ${O}/><path d="M-6 -36h12l-6 10z" fill="${GOLD}"/><path d="M-8 -5h16l-8 -6z" fill="${GOLD}"/></g>`, {at: ["hold", "grip", 0, 16]});
 add("bell", "Bell", "Time", "A gentle reminder", "R", "ring", () => `<rect x="-2" y="-46" width="4" height="8" fill="${WOODD}"/><path d="M-16 -8q0 -32 16 -32q16 0 16 32z" fill="${GOLD}" ${O}/><circle cy="-4" r="4.5" fill="${GOLDD}"/>${shine(-9, -32, 3, 16)}`);
 add("map", "Map", "Errands", "Travel or directions", "both", "read", () => `<path d="M-38 -34l25 -6l26 6l25 -6v40l-25 6l-26 -6l-25 6z" fill="${PAPERD}" ${O}/><path d="M-13 -40v40M13 -34v40" stroke="#b9ae98" stroke-width="1.4"/>`);
 add("timer", "Tomato timer", "Focus", "A focus session is running", "L", "tap", () => `<circle cy="-18" r="18" fill="${MAD}" ${O}/><path d="M-9 -36q9 -7 18 0q-9 4 -18 0z" fill="${LEAF}"/><path d="M0 -18v-9M0 -18l6 4" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>${shine(-12, -28, 3, 10, 30)}`);
 add("clipboard", "Clipboard", "Work", "Reading out what needs you", "L", "tick", () => `<g transform="rotate(-6)"><rect x="-20" y="-50" width="40" height="52" rx="5" fill="${WOODD}" ${O}/><rect x="-16" y="-46" width="32" height="44" rx="3" fill="${WOOD}" opacity=".5"/><rect x="-8" y="-54" width="16" height="9" rx="3" fill="${STEELD}"/></g>`, {at: ["hold", "grip", 0, 26]});
 add("book", "Book", "Work", "Reading the docs", "L", "read", () => `<g transform="translate(-10 0)"><path d="M-22 -42h40v42h-40z" fill="${WOAD}" ${O}/><rect x="-22" y="-42" width="6" height="42" fill="${WOADD}"/><rect x="-11" y="-34" width="22" height="9" rx="1.5" fill="${PAPER}" opacity=".85"/><path d="M-8 -30h16" stroke="${INK}" stroke-width="1.2" opacity=".5"/><path d="M18 -40v38" stroke="${PAPER}" stroke-width="2.4"/></g>`, {at: ["hold", "grip", 4, 26]});
 add("lock", "Lock", "Privacy", "A private memory store is open", "L", "click", () => `<path d="M-9 -26v-8a9 9 0 0 1 18 0v8" fill="none" stroke="${STEELD}" stroke-width="5"/><rect x="-15" y="-27" width="30" height="26" rx="6" fill="${GOLD}" ${O}/><circle cy="-16" r="3.5" fill="${INK}"/><rect x="-1.5" y="-16" width="3" height="7" fill="${INK}"/>`);
 add("shield", "Shield", "Privacy", "A security alert, or guarding something private", "L", "check", () => `<path d="M0 -50l24 8v18q0 22 -24 30q-24 -8 -24 -30v-18z" fill="${WOAD}" ${O}/><path d="M0 -42l16 5v13q0 15 -16 21z" fill="#fff" opacity=".2"/><path d="M-8 -22l6 6l10 -12" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
 // two hands: drawn between them
 add("trophy", "Trophy", "Wins", "A big win: a release shipped", "both", "raise", () => `<path d="M-18 -46h36v10q0 22 -18 24q-18 -2 -18 -24z" fill="${GOLD}" ${O}/><path d="M-18 -40q-12 0 -10 10q2 8 12 8M18 -40q12 0 10 10q-2 8 -12 8" stroke="${GOLD}" stroke-width="4" fill="none"/><rect x="-4" y="-12" width="8" height="10" fill="${GOLDD}"/><rect x="-14" y="-3" width="28" height="9" rx="2" fill="${WOODD}" ${O}/>${shine(-12, -43, 3, 18)}<path d="M0 -38l2.5 5l5 .8l-3.7 3.6l.9 5.2l-4.7 -2.5l-4.7 2.5l.9 -5.2l-3.7 -3.6l5 -.8z" fill="#fff6d0"/>`);
 add("rocket", "Rocket", "Work", "Deploying", "both", "launch", (k) => `<g transform="translate(${f1(150 * ease(k.fly || 0))} ${f1(14 - 170 * ease(k.fly || 0))}) rotate(${f1(35 * ease(Math.min(1, (k.fly || 0) * 3)))}) scale(.8)"><path d="M0 -62q14 14 14 40v16h-28v-16q0 -26 14 -40z" fill="${IV}" ${O}/><circle cy="-34" r="6" fill="${WOAD}" stroke="${INK}" stroke-opacity=".5"/><path d="M-14 -16l-8 12h8zM14 -16l8 12h-8z" fill="${MAD}" ${O}/>${k.fly ? `<path d="M-8 -4q8 ${f1(26 + 8 * Math.sin(k.t * 30))} 16 0z" fill="${GOLD}"/>` : ""}</g>`);
 add("gift", "Gift", "Wins", "A birthday, or a little reward", "both", "jiggle", () => `<rect x="-22" y="-36" width="44" height="34" rx="4" fill="${DAM}" ${O}/><rect x="-24" y="-42" width="48" height="10" rx="3" fill="${DAM}" ${O}/><rect x="-4" y="-42" width="8" height="40" fill="${GOLD}"/><path d="M0 -42q-14 -16 -16 -4q2 4 16 4q14 0 16 -4q-2 -12 -16 4z" fill="${GOLD}" ${O}/>`);
 add("parcel", "Parcel", "Errands", "A delivery arrived", "both", "open", (k) => `<rect x="-26" y="-38" width="52" height="38" rx="3" fill="${WOOD}" ${O}/><path d="M-26 -38l${f1(-8 * (k.lid || 0))} ${f1(-14 * (k.lid || 0))}h20zM26 -38l${f1(8 * (k.lid || 0))} ${f1(-14 * (k.lid || 0))}h-20z" fill="${WOODD}" ${O}/><rect x="-26" y="-28" width="52" height="6" fill="${PAPERD}" opacity=".8"/>${k.lid > .5 ? `<path d="M0 -40l4 -10l4 10z" fill="${GOLD}"/>` : ""}`);
 // worn on the head: anchored to the top of the silhouette, sized to the body
 add("headphones", "Headphones", "Voice", "Dictation, or she's listening to music", "head", "listen", null, {worn: "ears"});
 add("hardhat", "Hard hat", "Work", "An agent job is building", "head", "knock", () => `<path d="M-44 -6Q-44 -48 0 -48Q44 -48 44 -6Z" fill="${GOLD}" ${O}/><rect x="-56" y="-10" width="112" height="10" rx="5" fill="${GOLD}" ${O}/><rect x="-6" y="-48" width="12" height="40" rx="5" fill="${GOLDD}"/>${shine(-30, -36, 4, 18, 40)}`);
 add("nightcap", "Nightcap", "Sleep", "Quiet hours, at night", "head", null, (k) => `<path d="M-46 -2Q-40 -50 8 -50Q52 -46 ${f1(66 + 4 * Math.sin(k.t))} ${f1(-4 + 3 * Math.sin(k.t * 1.3))}Q52 -22 30 -22Q0 -22 -46 -2Z" fill="${DAM}" ${O}/><path d="M-50 0Q0 -24 46 -14" fill="none" stroke="${IV}" stroke-width="9" stroke-linecap="round"/><circle cx="${f1(68 + 4 * Math.sin(k.t))}" cy="${f1(0 + 3 * Math.sin(k.t * 1.3))}" r="8" fill="${IV}" ${O}/>`);
 add("partyhat", "Party hat", "Wins", "A big win: a release shipped", "head", null, () => `<g transform="translate(14 0) rotate(14)"><path d="M-22 0L0 -54L22 0Z" fill="${MAD}" ${O}/><circle cx="-6" cy="-16" r="3.5" fill="${GOLD}"/><circle cx="7" cy="-28" r="3.5" fill="${IV}"/><circle cx="4" cy="-8" r="3.5" fill="${IV}"/><circle cy="-56" r="6" fill="${GOLD}"/></g>`);
 add("chefhat", "Chef's hat", "Home", "A recipe or a cooking timer", "head", null, () => `<rect x="-26" y="-18" width="52" height="18" rx="3" fill="#fff" ${O}/><path d="M-26 -16q-14 -10 -6 -24q8 -10 18 -4q4 -14 16 -12q12 0 14 12q12 -6 18 6q6 14 -10 22z" fill="#fff" ${O}/>`);
 add("gradcap", "Graduation cap", "Learning", "A course or a lesson finished", "head", null, (k) => `<path d="M-24 -4v-12h48v12q-24 8 -48 0z" fill="${INK}"/><path d="M0 -34l44 12l-44 12l-44 -12z" fill="${INK}"/><path d="M28 -22v${f1(20 + Math.sin(k.t * 2) * 2)}" stroke="${GOLD}" stroke-width="2.5"/><circle cx="28" cy="${f1(-2 + Math.sin(k.t * 2) * 2)}" r="4" fill="${GOLD}"/>`);
 add("detective", "Detective hat", "Work", "Investigating a bug", "head", null, () => `<path d="M-46 -4q0 -40 46 -40q46 0 46 40z" fill="#8a6a4a" ${O}/><path d="M-46 -4q46 10 92 0" stroke="#6a4f35" stroke-width="5" fill="none"/><path d="M-36 -28q36 -14 72 0" stroke="#6a4f35" stroke-width="2" fill="none" stroke-dasharray="4 4"/><path d="M-6 -44q6 -10 12 0" fill="#6a4f35"/>`);
 add("beanie", "Beanie", "Weather", "Cold out today", "head", null, () => `<path d="M-46 -6Q-44 -52 0 -52Q44 -52 46 -6Z" fill="${WOAD}" ${O}/><rect x="-48" y="-14" width="96" height="16" rx="7" fill="${WOADD}" ${O}/><circle cy="-56" r="10" fill="${IV}" ${O}/>${[-30, -15, 0, 15, 30].map((x) => `<path d="M${x} -12v12" stroke="#fff" stroke-opacity=".25" stroke-width="2"/>`).join("")}`);
 add("crown", "Crown", "Wins", "You told her she did brilliantly (rare)", "head", null, () => `<path d="M-30 0v-26l15 12l15 -22l15 22l15 -12v26z" fill="${GOLD}" ${O}/><circle cx="0" cy="-12" r="4" fill="${MAD}"/><circle cx="-18" cy="-8" r="3" fill="${WOAD}"/><circle cx="18" cy="-8" r="3" fill="${WOAD}"/>${shine(-24, -18, 3, 12)}`);
 add("headset", "Headset", "People", "You're in a meeting", "head", null, null, {worn: "headset"});
 // on the face: drawn over her own eyes, so they turn with her head
 add("glasses", "Reading glasses", "Work", "Reading a page or a file you shared", "face", "adjust", null, {worn: "glasses"});
 add("sunglasses", "Sunglasses", "Weather", "A clear, sunny day", "face", "slide", null, {worn: "shades"});
 
 add("sleepmask", "Sleep mask", "Sleep", "Asleep, or about to be", "face", null, null, {worn: "mask"});
 add("bandage", "Plaster", "Feelings", "After a hurt moment, a plaster on her head", "face", null, null, {worn: "plaster"});
 // floating above her
 add("lightbulb", "Light bulb", "Ideas", "She has an idea to offer", "float", "ping", () => `<circle r="26" fill="#FFD86B" opacity=".25"/><path d="M0 -17a14 14 0 0 1 9 25v5h-18v-5a14 14 0 0 1 9 -25z" fill="#FFD86B" ${O}/><rect x="-8" y="13" width="16" height="8" rx="2" fill="${STEEL}" ${O}/><path d="M-32 -6h-7M32 -6h7M-23 -27l-5 -5M23 -27l5 -5" stroke="#FFD86B" stroke-width="3" stroke-linecap="round"/>`);
 add("raincloud", "Rain cloud", "Weather", "It's raining now", "float", null, (k) => `<path d="M-30 0q-14 0 -12 -14q2 -12 16 -10q4 -16 22 -14q16 2 18 16q14 -2 16 10q0 12 -14 12z" fill="#c6cfd9" ${O}/>${[-18, -4, 10, 22].map((x, i) => `<path d="M${x} ${f1(8 + ((k.t * 40 + i * 7) % 22))}l-2 6" stroke="${SKY}" stroke-width="2.6" stroke-linecap="round"/>`).join("")}`);
 add("sun", "Sun", "Weather", "A clear day ahead", "float", null, (k) => `<g transform="rotate(${f1(k.t * 12)})">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<rect x="-2.5" y="-30" width="5" height="9" rx="2.5" fill="${GOLD}" transform="rotate(${i * 45})"/>`).join("")}</g><circle r="16" fill="${GOLD}" ${O}/>${shine(-9, -8, 4, 7, -30)}`);
 add("snowflake", "Snowflake", "Weather", "Snow today", "float", null, (k) => `<g transform="rotate(${f1(k.t * 15)})" stroke="#bfe3f7" stroke-width="3.5" stroke-linecap="round">${[0, 60, 120].map((a) => `<path d="M0 -22v44M-6 -16l6 6l6 -6M-6 16l6 -6l6 6" transform="rotate(${a})" fill="none"/>`).join("")}</g>`);
 add("wifioff", "No Wi-Fi", "Device", "The connection dropped", "float", null, () => `<path d="M-24 -6a34 34 0 0 1 48 0M-15 3a21 21 0 0 1 30 0M-6 11a8 8 0 0 1 12 0" stroke="${STEELD}" stroke-width="4" fill="none" stroke-linecap="round"/><circle cy="19" r="3.5" fill="${STEELD}"/><path d="M-22 -18l44 44" stroke="${MAD}" stroke-width="4.5" stroke-linecap="round"/>`);
 add("batterylow", "Battery low", "Device", "The phone's battery is low", "float", null, (k) => `<rect x="-24" y="-12" width="44" height="24" rx="5" fill="${IV}" ${O}/><rect x="21" y="-5" width="5" height="10" rx="2" fill="${INK}" opacity=".6"/><rect x="-20" y="-8" width="9" height="16" rx="2" fill="${MAD}" opacity="${f1(.5 + .5 * Math.abs(Math.sin(k.t * 3)))}"/>`);
 add("notes", "Music", "Leisure", "Music is playing", "float", null, (k) => `<g transform="translate(0 ${f1(3 * Math.sin(k.t * 3))})"><path d="M-12 8v-28l20 -6v28" stroke="${DAM}" stroke-width="3.5" fill="none"/><ellipse cx="-16" cy="9" rx="6" ry="4.5" fill="${DAM}"/><ellipse cx="4" cy="3" rx="6" ry="4.5" fill="${DAM}"/></g>`);
 // placed in front of her, on the ground
 add("laptop", "Laptop", "Work", "She's working in your repo", "front", "type", () => `<path d="M-50 -2h100l-8 -8h-84z" fill="${STEEL}" ${O}/><rect x="-54" y="-3" width="108" height="6" rx="3" fill="${STEELD}"/><path d="M-40 -10l6 -46h68l6 46z" fill="${INK}"/><path d="M-34 -14l5 -37h58l5 37z" fill="${WOAD}"/><path d="M-26 -42h24M-26 -34h40M-26 -26h30" stroke="#bff3ef" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>`, {sit: 0});
 add("cake", "Birthday cake", "Wins", "It's a birthday", "front", null, (k) => `<rect x="-34" y="-26" width="68" height="26" rx="4" fill="#f6d8c4" ${O}/><path d="M-34 -18q8 8 17 0t17 0t17 0t17 0v-8h-68z" fill="${PAPER}"/>${[-16, 0, 16].map((x) => `<rect x="${x - 2}" y="-40" width="4" height="14" fill="${WOAD}"/><path d="M${x} -42q${f1(3 + Math.sin(k.t * 9 + x) * 1.5)} -6 0 -10q-3 4 0 10z" fill="${GOLD}"/>`).join("")}`, {sit: 0});
 add("plant", "Plant", "Habits", "A habit streak kept up", "front", "grow", (k) => { const gr = .55 + .45 * (k.grow ?? 1); return `<path d="M-16 -22h32l-4 22h-24z" fill="#c4704b" ${O}/><rect x="-18" y="-26" width="36" height="7" rx="2" fill="#a85a39" ${O}/><g transform="translate(0 -26) scale(${f1(gr)})"><path d="M0 0v-30" stroke="${LEAFD}" stroke-width="3"/><path d="M0 -14q-18 -2 -20 -16q16 0 20 16zM0 -24q16 -4 20 -18q-16 0 -20 18z" fill="${LEAF}" ${O}/></g>`; }, {sit: 0});
 add("books", "Stack of books", "Learning", "A reading list for your research", "front", null, () => `<rect x="-30" y="-14" width="60" height="14" rx="2" fill="${WOAD}" ${O}/><rect x="-26" y="-27" width="52" height="13" rx="2" fill="${MAD}" ${O}/><rect x="-32" y="-39" width="58" height="12" rx="2" fill="${GOLD}" ${O}/><path d="M-22 -8h36M-18 -21h30M-24 -33h32" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>`, {sit: 0});
 // How each prop is held: the hand shape, the grip point in the prop's own drawing (it sits exactly on the hand's
 // anchor), the allowed wrist rotation while not in use, its weight, and where it comes from and goes back to.
 // Two-handed props give a grip point per hand. Weight: heavy props hang lower, move slower and make her lean.
 // faces: which side points to her eyes. "her": a screen, a page, buttons face her, so the viewer sees the back.
 // "viewer": shown to you (a trophy raised, a gift offered). "up": upright and level (cups, glasses)
 const G = (shape, pt, rot = [-25, 25], weight = "light", from = "below", faces = "up") => ({shape, pt, rot, weight, from, faces});
 TCS.GRIPS = {
  coffee: G("grip", [-6, -3]), tea: G("pinch", [-2, -2]), water: G("grip", [-1, -6]),
  magnifier: G("grip", [0, 6], [-35, 35]), wrench: G("grip", [0, -4], [-60, 60]), hammer: G("grip", [0, 2], [-60, 60]),
  pencil: G("pinch", [2, -10], [-40, 40]), phone: G("grip", [0, -22], [-30, 30], "light", "pocket", "her"), envelope: G("pinch", [-18, -6]),
  stamp: G("grip", [0, -22], [-30, 30], "medium"), stopwatch: G("open", [0, -7], [-20, 20], "light", "pocket"), alarmclock: G("open", [0, -6], [-25, 25], "medium"),
  key: G("pinch", [0, -30], [-60, 60], "light", "pocket"), umbrella: G("grip", [0, 4], [-30, 30], "medium"), flag: G("grip", [0, 0], [-30, 30]),
  camera: G("grip", [16, -12], [-20, 20], "medium", "below", "viewer"), microphone: G("grip", [0, -2], [-30, 30]), paintbrush: G("pinch", [0, -6], [-40, 40]),
  wateringcan: G("grip", [-20, -16], [-45, 20], "medium"), dumbbell: G("fist", [0, -3], [-20, 20], "heavy"), broom: G("grip", [0, -10], [-35, 35], "medium"),
  bugnet: G("grip", [0, 0], [-60, 60]), torch: G("grip", [0, -18], [-45, 45]), tissue: G("pinch", [-11, -16], [-40, 40], "light", "pocket"),
  heart: G("open", [0, 4], [-15, 15], "light", "below", "viewer"), popcorn: G("open", [0, 2], [-15, 15]), shoppingbag: G("grip", [0, -14], [-20, 20], "medium"),
  thermometer: G("pinch", [0, -16], [-30, 30]), pillbox: G("open", [0, -2], [-25, 25], "light", "pocket"), balloon: G("pinch", [0, 0], [-30, 30]),
  hourglass: G("grip", [0, -24], [-180, 180]), bell: G("pinch", [0, -42], [-30, 30]), timer: G("open", [0, -2], [-20, 20]),
  clipboard: G("grip", [-16, -24], [-20, 20], "light", "below", "her"), book: G("back", [-10, -18], [-20, 20], "light", "below", "her"), lock: G("open", [0, -2], [-20, 20], "light", "pocket"),
  shield: G("grip", [0, -22], [-20, 20], "medium"),
  // two hands: a grip point for each
  trophy: {top: 58, shape: "grip", L: [-24, -32], R: [24, -32], weight: "heavy", from: "below", rot: [-10, 10], faces: "viewer"},
  gift: {top: 44, shape: "open", L: [-22, -4], R: [22, -4], weight: "medium", from: "below", rot: [-10, 10], faces: "viewer"},
  parcel: {top: 40, shape: "open", L: [-26, -2], R: [26, -2], weight: "heavy", from: "below", rot: [-10, 10]},
  controller: {top: 26, shape: "grip", L: [-28, -4], R: [28, -4], weight: "light", from: "below", rot: [-10, 10], faces: "her"},
  map: {top: 42, shape: "pinch", L: [-36, -16], R: [36, -16], weight: "light", from: "below", rot: [-10, 10], faces: "her"},
  rocket: {top: 30, shape: "grip", L: [-13, -18], R: [13, -18], weight: "light", from: "below", rot: [-10, 10]},
 };
 TCS.PROP_CATS = [...new Set(Object.values(P).map((p) => p.cat))];

 const SLOT = (p) => p.mount === "both" ? ["L", "R"] : p.mount === "front" && p.use === "type" ? ["L", "R"] : p.mount === "R" || p.mount === "L" ? [p.mount] : [];
 TCS.propConflicts = (a, b) => { const A = P[a], B = P[b]; if (A.mount === B.mount && !["R", "L"].includes(A.mount)) return true; const sa = SLOT(A), sb = SLOT(B); return sa.some((s) => sb.includes(s)) || (A.mount === "front" && B.mount === "front"); };

 // the face-worn props follow her eyes, so they foreshorten with every head turn
 function worn(kind, F, eyes, B, R, k, pal) {
  const [L, Rr] = eyes;
  const top = B.top, hw = B.hw, yawX = R.yaw * hw * .3;
  switch (kind) {
   case "glasses": case "shades": {
    const dy = k.wornDy || 0, s = kind === "shades";
    const lens = (e) => `<rect x="${f1(e.cx - e.W * .95)}" y="${f1(e.cy - e.H * .62 + dy)}" width="${f1(e.W * 1.9)}" height="${f1(e.H * 1.15)}" rx="${f1(e.W * .7)}" fill="${s ? "#1d2430" : "#ffffff"}" fill-opacity="${s ? .88 : .12}" stroke="${s ? INK : GOLDD}" stroke-width="3.5"/>`;
    return lens(L) + lens(Rr) + `<path d="M${f1(L.cx + L.W * .95)} ${f1(L.cy - L.H * .15 + dy)}Q${f1((L.cx + Rr.cx) / 2)} ${f1(L.cy - L.H * .35 + dy)} ${f1(Rr.cx - Rr.W * .95)} ${f1(Rr.cy - Rr.H * .15 + dy)}" stroke="${s ? INK : GOLDD}" stroke-width="3.2" fill="none"/>` + (s ? `<path d="M${f1(L.cx - L.W * .6)} ${f1(L.cy - L.H * .3 + dy)}l${f1(L.W * .5)} ${f1(L.H * .4)}M${f1(Rr.cx - Rr.W * .6)} ${f1(Rr.cy - Rr.H * .3 + dy)}l${f1(Rr.W * .5)} ${f1(Rr.H * .4)}" stroke="#fff" stroke-width="2.5" opacity=".55" stroke-linecap="round"/>` : "");
   }
   case "monocle": { const e = Rr, dy = k.wornDy || 0, r = e.H * .72, cx = e.cx, cy = e.cy + dy; return `<g data-l="monocle"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="#fff" fill-opacity=".1" stroke="${GOLDD}" stroke-width="4.5"/><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="none" stroke="${GOLD}" stroke-width="2.6"/><path d="M${f1(cx - r * .55)} ${f1(cy - r * .35)}q${f1(r * .25)} ${f1(-r * .35)} ${f1(r * .6)} ${f1(-r * .4)}" stroke="#fff" stroke-width="2" fill="none" opacity=".75" stroke-linecap="round"/><path d="M${f1(cx + r * .7)} ${f1(cy + r * .7)}q${f1(r * .6)} ${f1(r * 1.6)} ${f1(-r * .2)} ${f1(r * 3.2)}" stroke="${GOLD}" stroke-width="1.4" fill="none" stroke-dasharray="2.2 1.6"/></g>`; }
   case "mask": { const y = Math.min(L.cy, Rr.cy) - L.H * 1.05; return `<path d="M${f1(-hw * .78 + yawX)} ${f1(y + 4)}Q${f1(yawX)} ${f1(y - 6)} ${f1(hw * .78 + yawX)} ${f1(y + 4)}" stroke="${DAM}" stroke-width="3" fill="none"/><path d="M${f1(L.cx - L.W * 1.1)} ${f1(y - 8)}q${f1(L.W * 1.1)} -10 ${f1((Rr.cx - L.cx) / 2 + L.W * 1.1)} -2q${f1((Rr.cx - L.cx) / 2 + Rr.W * 1.1)} -8 ${f1((Rr.cx - L.cx) / 2 + Rr.W * 1.1)} 2v16q-${f1(Rr.W * 1.4)} 8 -${f1((Rr.cx - L.cx) / 2 + Rr.W * 1.1)} 0q-${f1(L.W * 1.4)} 8 -${f1((Rr.cx - L.cx) / 2 + L.W * 1.1)} 0z" fill="${DAM}" ${O}/><path d="M${f1(L.cx - L.W * .5)} ${f1(y + 2)}q${f1(L.W * .5)} 5 ${f1(L.W)} 0M${f1(Rr.cx - Rr.W * .5)} ${f1(y + 2)}q${f1(Rr.W * .5)} 5 ${f1(Rr.W)} 0" stroke="${IV}" stroke-width="2" fill="none"/>`; }
   case "plaster": { const x = Rr.cx + Rr.W * .3, y = Rr.cy - Rr.H * .9 - 8; return `<g transform="translate(${f1(x)} ${f1(y)}) rotate(-28)"><rect x="-18" y="-6" width="36" height="12" rx="6" fill="#f2c9a8" ${O}/><rect x="-6" y="-6" width="12" height="12" fill="#e7b48f"/><g fill="#c98f6c"><circle cx="-12" cy="0" r="1.2"/><circle cx="12" cy="0" r="1.2"/></g></g><g transform="translate(${f1(x)} ${f1(y)}) rotate(28)"><rect x="-18" y="-6" width="36" height="12" rx="6" fill="#f2c9a8" ${O}/></g>`; }
   case "ears": case "headset": {
    const y = (L.cy + Rr.cy) / 2 - 2, xl = -hw * .93 + yawX * .5, xr = hw * .93 + yawX * .5, cup = (x) => `<rect x="${f1(x - 11)}" y="${f1(y - 20)}" width="22" height="40" rx="10" fill="${kind === "ears" ? WOAD : INK}" ${O}/><rect x="${f1(x - 6)}" y="${f1(y - 14)}" width="5" height="22" rx="2.5" fill="#fff" opacity=".35"/>`;
    return `<path d="M${f1(xl)} ${f1(y - 12)}Q${f1(xl - 4)} ${f1(top - 16)} ${f1(yawX)} ${f1(top - 16)}Q${f1(xr + 4)} ${f1(top - 16)} ${f1(xr)} ${f1(y - 12)}" stroke="${kind === "ears" ? WOADD : INK}" stroke-width="7" fill="none" stroke-linecap="round"/>` + cup(xl) + cup(xr)
     + (kind === "headset" ? `<path d="M${f1(xl + 4)} ${f1(y + 14)}q4 ${f1(F.mY + 10)} ${f1(-xl * .6)} ${f1(F.mY + 16)}" stroke="${INK}" stroke-width="3" fill="none"/><circle cx="${f1(xl * .4)}" cy="${f1(y + F.mY + 30)}" r="5" fill="${INK}"/>` : "");
   }
  }
  return "";
 }

 /** Before the face is drawn: what the props do to the face and which hands they need. */
 TCS.propPre = function (props, now) {
  const d = {}, hands = {};
  for (const id in props) {
   const p = P[id], st = props[id];
   if (st.out) continue;
   const enter = ease(clamp((now - st.t0) / 380, 0, 1));
   const sl = SLOT(p);
   const at = p.at || (p.mount === "front" ? null : ["hold", "grip"]);
   const gs = (TCS.GRIPS[id] || {}).shape || "grip";
   for (const s of sl) if (at) hands[s] = [at[0], gs, at[2] || 0, at[3] || 0, at[4] || 0];
   if (p.mount === "both") { hands.L = ["both", gs]; hands.R = ["both", gs]; }
   if (st.use && USE[p.use]) {
    const u = (now - st.use) / USE[p.use].dur;
    if (u >= 0 && u < 1) {
     let r = USE[p.use].fn(u);
     if (r.flash && id !== "camera") r = Object.assign({}, r, {flash: false}); // only the camera flashes
     if (r.d) for (const k in r.d) d[k] = (d[k] || 0) + r.d[k];
     if (r.hands) for (const s in r.hands) if (r.hands[s]) hands[s] = r.hands[s];
     st.k = r;
    } else { st.k = null; if (u >= 1) st.use = 0; }
   }
  }
  return {d, hands};
 };

 /** After the face: worn and floating props, the placed ones in front, and what each hand is holding. */
 TCS.propDraw = function (props, now, B, F, R, eyes, pal) {
  let wornS = "", front = "", float = "", moving = false;
  const held = {L: "", R: ""};
  let floatN = 0;
  for (const id in props) {
   const p = P[id], st = props[id];
   const tin = clamp((now - st.t0) / 420, 0, 1), tout = st.out ? clamp((now - st.out) / 380, 0, 1) : 0;
   // overshoot on the way in, a quick shrink on the way out
   const sc = st.out ? 1 - ease(tout) : (tin < 1 ? 1 + 1.7 * Math.pow(tin - 1, 3) + .7 * Math.pow(tin - 1, 2) : 1);
   if (tin < 1 || st.out || st.use) moving = true;
   // ambient life (steam, a flapping flag, rain) runs for a few seconds after it arrives and while used, then holds still
   const live = now - st.t0 < 3500 || !!st.use;
   const k = Object.assign({t: live ? (now - st.t0) / 1000 : 3.5, warm: p.warm && live, B, F}, st.k || {});
   if (live && (p.warm || ["flag", "balloon", "raincloud", "sun", "snowflake", "batterylow", "notes", "cake", "nightcap", "gradcap"].includes(id))) k.anim = true;
   const pr = (k.pr || 0), ps = 1 + (k.ps || 0), pdy = k.pdy || 0;
   if (p.mount === "head") {
    const x = R.yaw * B.hw * .3, y = B.top + 6 + (k.wornDy || 0), s = clamp(B.hw / 92, .8, 1.15);
    wornS += p.worn ? worn(p.worn, F, eyes, B, R, k, pal) : `<g transform="translate(${f1(x)} ${f1(y - 16 * (1 - sc))}) rotate(${f1(R.yaw * -6)}) scale(${f1(s * sc)})" opacity="${f1(1 - tout)}">${p.draw(k)}</g>`;
   } else if (p.mount === "face") {
    if (F.noFace || (id === "monocle" && F.chained)) continue; // Alfred's monocle lives on his chain, drawn by his body // Mark has no eyes to wear glasses on
    wornS += `<g opacity="${f1(Math.min(1, sc) * (1 - tout))}" transform="translate(0 ${f1(-10 * (1 - Math.min(1, tin * 1.5)))})">${worn(p.worn, F, eyes, B, R, k, pal)}</g>`;
   } else if (p.mount === "float") {
    const x = (floatN++ % 2 ? -1 : 1) * B.hw * .62, y = B.top - 34 + pdy;
    float += `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(sc * ps)}) rotate(${f1(pr)})">${p.draw(k)}</g>`;
   } else if (p.mount === "front") {
    front += `<g transform="translate(0 ${f1(2 + 30 * (1 - Math.min(1, tin * 1.3)))}) scale(${f1(Math.min(1, sc + .2))})" opacity="${f1(1 - tout)}">${p.draw(k)}</g>`;
    if (p.use === "type" && !st.use && tin >= 1) st.use = now;
   } else {
    const s = p.mount === "both" ? "both" : p.mount;
    const mark = p.mark && k.mark ? `<rect x="-20" y="-6" width="40" height="14" rx="3" fill="none" stroke="${MADD}" stroke-width="2.5" opacity="${f1(k.mark)}"/><path d="M-10 1l4 4l9 -8" stroke="${MADD}" stroke-width="2.5" fill="none" opacity="${f1(k.mark)}"/>` : "";
    if (st.k) st.lastUse = now;
    held[s === "both" ? "both" : s] = {id, grip: TCS.GRIPS[id], enter: 1 - ease(Math.min(1, tin * 1.15)), exit: st.out ? ease(tout) : 0, use: st.k ? p.use : (now - (st.lastUse || -1e9) < 500 ? p.use + "-return" : ""), svg: `<g transform="translate(0 ${f1(pdy)}) rotate(${f1(pr)}) scale(${f1(ps)})">${p.draw(k)}</g>`, lens: p.lens && k.lens ? Object.assign({k: k.lens}, p.lens) : null, mark};
    if (k.flash) moving = true;
   }
   if (k.anim) moving = true;
  }
  return {worn: wornS, front, float, held, moving};
 };
})(window);
