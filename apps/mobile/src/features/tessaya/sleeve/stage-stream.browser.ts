/**
 * Her estate in the Sleeve (M-158): the desk mascot's own rig and page script on the whole screen. She walks where he
 * taps, resizes to his pinch, goes where he carries her; his hand on her is read as the desk reads it, then sent on.
 * Nothing draws at rest: moves are CSS transitions and the rig idles itself.
 */
import { HUMAN_SENSE, MASCOT_SENSE, mergeSense, regionAt } from "@t3tools/tessaya-shared/bodySense";
import { readTouch } from "@t3tools/tessaya-shared/bodyMotion";
import { rigGestureOf, rigMoodOf } from "@t3tools/tessaya-shared/companion";
import { MASCOT_SCRIPT } from "@t3tools/tessaya-shared/mascotPage";
import {
  clampSpot,
  fingerSkin,
  pinchScale,
  PX_PER_CM,
  timerLeft,
  wanderSpot,
  type Spot,
  type StageCard,
} from "@t3tools/tessaya-shared/sleeveEstate";

import rig from "../../../../../web/public/companion/rig.js?raw";
import bodies from "../../../../../web/public/companion/bodies.js?raw";
import props from "../../../../../web/public/companion/props.js?raw";
import speech from "../../../../../web/public/companion/speech.js?raw";
import sounds from "../../../../../web/public/companion/sounds.js?raw";

interface Mascot {
  init(o: object): void;
  cue(c: object): void;
  speak(on: boolean): void;
  line(text: string): void;
  play(name: string): void;
  prop(name: string, on: boolean): void;
  use(name: string): void;
  react(kind: string, speed: number): void;
  press(a: number): void;
  release(): void;
  walk(ms: number, dir: number): void;
  look(gx: number, gy: number): void;
  impact(speed: number, landed: boolean): void;
  morph(dir: "in" | "out"): void;
  say(e: { mood?: string; gesture?: string; text?: string }): void;
  signature(): string | null;
  idleChoice(): "walk" | "funny" | "signature";
  humour(name?: string, can?: object): object | null;
}
declare global {
  interface Window {
    mascot?: Mascot;
    mascotIpc?: object;
  }
}

const tell = (data: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(data));
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.body.style.cssText =
  "margin:0;height:100%;overflow:hidden;background:transparent;user-select:none;-webkit-user-select:none;touch-action:none";
const her = document.createElement("div");
her.style.cssText = "position:absolute;left:0;top:0;will-change:transform";
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.id = "c";
// oxlint-disable-next-line t3code/no-untranslated-copy -- product name
svg.setAttribute("aria-label", "Tessaya");
svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
her.append(svg);
document.body.append(her);

// what she holds on her estate (REQ-25-167): a card beside her that goes where she goes, and the prop that means it
const card = document.createElement("div");
card.style.cssText =
  "position:absolute;left:0;top:0;max-width:46vw;padding:10px 14px;border-radius:16px;background:#F7F2E7;color:#1f1b1d;font:500 15px/1.3 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;will-change:transform";
document.body.append(card);
let held: StageCard | null = null;
let heldProp: string | null = null;
let ticking = 0;
let leaving = 0;
const STAGE_MS = 2 * 60_000;
const RING_MS = 8_000;
function placeCard(ms: number) {
  if (held === null) return;
  const r = (size * spot.scale) / 2;
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  // by the hand she holds it in (her right, his left as he looks) where it fits, else her other side, else over her head
  const right = spot.x + r * 0.55;
  const left = spot.x - r * 0.55 - w;
  const beside = innerWidth - 8 - right >= w ? right : left >= 8 ? left : null;
  const x = beside ?? Math.min(innerWidth - w - 8, Math.max(8, spot.x - w / 2));
  const y = Math.max(
    8,
    Math.min(innerHeight - inset - h - 8, beside === null ? spot.y - r - h : spot.y - h / 2),
  );
  card.style.transition = `opacity .25s${ms > 0 && !reduced ? `, transform ${ms}ms cubic-bezier(.45,0,.25,1)` : ""}`;
  card.style.transform = `translate(${x}px,${y}px)`;
}
const holdProp = (next: string | null) => {
  if (heldProp === next) return;
  if (heldProp !== null) mascot.prop(heldProp, false);
  heldProp = next;
  if (next !== null) mascot.prop(next, true);
};
const line = (text: string, css: string) => {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = css;
  return d;
};
const drawCard = () => {
  if (held === null) return;
  const timer = held.endsAt !== null;
  card.replaceChildren(
    ...(held.title === "" ? [] : [line(held.title, "font-size:12px;opacity:.65;font-weight:600")]),
    ...(timer
      ? [
          line(
            timerLeft(held.endsAt!, Date.now()),
            "font:700 34px/1.1 system-ui;font-variant-numeric:tabular-nums",
          ),
        ]
      : held.lines.map((l) => line(l, "white-space:pre-wrap"))),
  );
};
const putAway = () => {
  clearInterval(ticking);
  clearTimeout(leaving);
  held = null;
  holdProp(null);
  card.style.opacity = "0";
  card.style.pointerEvents = "none";
};
const hold = (next: StageCard) => {
  putAway();
  held = next;
  drawCard();
  placeCard(0);
  card.style.opacity = "1";
  card.style.pointerEvents = "auto";
  holdProp(next.prop);
  if (next.gesture !== null) mascot.play(next.gesture);
  if (next.endsAt === null) {
    leaving = window.setTimeout(putAway, STAGE_MS);
    return;
  }
  // a timer counts down on the card once a second; at its end she rings it, then puts it away
  ticking = window.setInterval(() => {
    drawCard();
    if (held === null || Date.now() < held.endsAt!) return;
    clearInterval(ticking);
    holdProp("alarmclock");
    leaving = window.setTimeout(putAway, RING_MS);
  }, 1000);
};
// his hand on what she holds: a tap and she uses it; flicked away, she puts it away
let cardFrom: { readonly x: number; readonly y: number } | null = null;
card.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  cardFrom = { x: e.clientX, y: e.clientY };
});
card.addEventListener("pointerup", (e) => {
  e.stopPropagation();
  if (cardFrom === null) return;
  const moved = Math.hypot(e.clientX - cardFrom.x, e.clientY - cardFrom.y);
  cardFrom = null;
  if (moved > 60) putAway();
  else if (heldProp !== null) mascot.use(heldProp);
  else if (held?.gesture != null) mascot.play(held.gesture);
});

// the shared page script talks to its host through mascotIpc: here the host is the app
let levelOf: ((v: number, shape?: object) => void) | null = null;
window.mascotIpc = {
  onLevel: (f: (v: number, shape?: object) => void) => (levelOf = f),
  send: () => undefined,
};
// in the stage's own order; an inline script runs as it is added
for (const source of [rig, bodies, props, speech, sounds, MASCOT_SCRIPT]) {
  const script = document.createElement("script");
  script.textContent = source;
  document.head.append(script);
}
const mascot = window.mascot!;

// where she stands (her centre, in CSS px) and how big she is; the bottom inset keeps her above the app's panel
const box = () => ({ w: innerWidth, h: innerHeight, bottom: inset, right: insetRight });
let inset = 0;
let insetRight = 0;
// her size on this screen: on its side (the dock) she takes most of its height
const sizeFor = () =>
  innerWidth > innerHeight
    ? Math.min(innerWidth * 0.4, innerHeight * 0.7)
    : Math.min(innerWidth * 0.62, innerHeight * 0.42);
let size = sizeFor();
let spot: Spot = { x: innerWidth / 2, y: innerHeight * 0.38, scale: 1 };
const place = (next: Spot, ms: number) => {
  spot = clampSpot(next, size, box());
  her.style.transition =
    ms > 0 && !reduced ? `transform ${ms}ms cubic-bezier(.45,0,.25,1)` : "none";
  her.style.width = her.style.height = `${size}px`;
  her.style.transform = `translate(${spot.x - size / 2}px,${spot.y - size / 2}px) scale(${spot.scale})`;
  placeCard(ms);
};
place(spot, 0);
addEventListener("resize", () => {
  size = sizeFor();
  place(spot, 0);
});

/** She walks to a spot on her own feet: her walk cycle for as long as the move takes. */
const walkTo = (to: Pick<Spot, "x" | "y">) => {
  const dx = to.x - spot.x;
  const dist = Math.hypot(dx, to.y - spot.y);
  if (dist < 8) return;
  const ms = Math.min(4000, Math.max(500, dist * 4));
  mascot.walk(ms, Math.sign(dx) || 1);
  place({ ...spot, x: to.x, y: to.y }, ms);
};

// her own quiet minutes, by her personality, only while nobody is talking to her and he is not holding her
let busy = false;
let quietTimer = 0;
const quietSoon = () => {
  clearTimeout(quietTimer);
  if (reduced) return;
  quietTimer = window.setTimeout(
    () => {
      if (!busy) {
        const pick = mascot.idleChoice();
        if (pick === "walk") walkTo(wanderSpot(spot, size, box(), Math.random));
        else if (pick === "funny") mascot.humour();
        else {
          const act = mascot.signature();
          if (act !== null) mascot.play(act);
        }
      }
      quietSoon();
    },
    45_000 + Math.random() * 75_000,
  );
};

// his hand: on her it is a touch (or a carry, or a pinch to resize her); on the empty screen a tap calls her there
const MAP = mergeSense([HUMAN_SENSE, MASCOT_SENSE], false);
interface Press {
  readonly id: number;
  readonly at: number;
  readonly x0: number;
  readonly y0: number;
  x: number;
  y: number;
  travel: number;
  reversals: number;
  lastDx: number;
  /** The most skin and the firmest force his finger gave over the whole touch (force null: none measured). */
  area: number;
  force: number | null;
  readonly onHer: boolean;
  carried: boolean;
}
const presses = new Map<number, Press>();
let pinchFrom: { readonly d: number; readonly scale: number } | null = null;
let tapsAt: number[] = [];
const onHerAt = (x: number, y: number) => {
  const r = her.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};
const partAt = (x: number, y: number) => {
  const r = her.getBoundingClientRect();
  const u = Math.max(-1, Math.min(1, (x - r.left - r.width / 2) / (r.width / 2)));
  const v = Math.max(0, Math.min(1, (y - r.top) / r.height));
  return regionAt(MAP, u, v) ?? "middle";
};
const twoApart = () => {
  const [a, b] = [...presses.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};

addEventListener("pointerdown", (e) => {
  const onHer = onHerAt(e.clientX, e.clientY);
  const skin = fingerSkin(e.width, e.height, e.pressure);
  presses.set(e.pointerId, {
    id: e.pointerId,
    at: performance.now(),
    x0: e.clientX,
    y0: e.clientY,
    x: e.clientX,
    y: e.clientY,
    travel: 0,
    reversals: 0,
    lastDx: 0,
    area: skin.areaCm2,
    force: skin.pressure,
    onHer,
    carried: false,
  });
  if (presses.size === 2) pinchFrom = { d: twoApart(), scale: spot.scale };
  if (onHer) {
    busy = true;
    mascot.press(0.5);
  }
});
addEventListener("pointermove", (e) => {
  const p = presses.get(e.pointerId);
  if (p === undefined) return;
  const dx = e.clientX - p.x;
  if (dx !== 0 && p.lastDx !== 0 && Math.sign(dx) !== Math.sign(p.lastDx)) p.reversals++;
  if (dx !== 0) p.lastDx = dx;
  p.travel += Math.hypot(dx, e.clientY - p.y);
  p.x = e.clientX;
  p.y = e.clientY;
  const skin = fingerSkin(e.width, e.height, e.pressure);
  p.area = Math.max(p.area, skin.areaCm2);
  if (skin.pressure !== null) p.force = Math.max(p.force ?? 0, skin.pressure);
  if (pinchFrom !== null && presses.size === 2 && Math.abs(twoApart() - pinchFrom.d) >= 20) {
    place({ ...spot, scale: pinchScale(pinchFrom.scale, pinchFrom.d, twoApart()) }, 0);
    return;
  }
  // held on her and moved well away from where he took her: he is carrying her
  if (p.onHer && (p.carried || Math.hypot(p.x - p.x0, p.y - p.y0) > 24)) {
    if (!p.carried) mascot.release();
    p.carried = true;
    mascot.look(Math.sign(dx), 0);
    place({ ...spot, x: p.x, y: p.y }, 0);
  }
});
const end = (e: PointerEvent) => {
  const p = presses.get(e.pointerId);
  if (p === undefined) return;
  // two fingers on her that stayed the same distance apart held her between them: a squeeze, not a resize
  const squeezed =
    pinchFrom !== null && presses.size === 2 && Math.abs(twoApart() - pinchFrom.d) < 20 && p.onHer;
  presses.delete(e.pointerId);
  if (presses.size < 2) pinchFrom = null;
  const ms = performance.now() - p.at;
  if (!p.onHer) {
    if (p.travel < 12 && ms < 400) walkTo({ x: p.x, y: p.y });
    return;
  }
  busy = presses.size > 0;
  mascot.release();
  if (p.carried) {
    // set down where he let go: a little landing by how fast his hand was moving
    const speed = Math.min(1, p.travel / Math.max(1, ms) / 3);
    mascot.impact(speed, true);
    tell({
      type: "touch",
      part: partAt(p.x, p.y),
      kind: "carry",
      pressure: 0.5,
      cmPerS: 0,
      durationMs: Math.round(ms),
    });
    quietSoon();
    return;
  }
  const now = performance.now();
  tapsAt = [...tapsAt.filter((t) => now - t < 700), now];
  const felt = readTouch({
    ms,
    travelPx: p.travel,
    reversals: p.reversals,
    taps: tapsAt.length,
    pointers: squeezed ? 2 : 1,
    ...(p.force === null ? {} : { pressure: p.force }),
  });
  mascot.react(felt.kind, felt.speed);
  tell({
    type: "touch",
    part: partAt(p.x0, p.y0),
    kind: felt.kind,
    pressure: p.force ?? felt.intensity,
    cmPerS: ms > 0 ? (p.travel / PX_PER_CM) * (1000 / ms) : 0,
    durationMs: Math.round(ms),
    areaCm2: p.area,
  });
  quietSoon();
};
addEventListener("pointerup", end);
addEventListener("pointercancel", end);

// the app's cues: the body page's (mood, gesture) as her rig draws them, and her speech
interface Incoming {
  readonly type: string;
  readonly [k: string]: unknown;
}
const onMessage = (raw: unknown) => {
  let m: Incoming;
  try {
    m = JSON.parse(String(raw)) as Incoming;
  } catch {
    return;
  }
  if (m.type === "persona" && typeof m["id"] === "string") {
    mascot.init({ persona: m["id"], quiet: false, calm: true, reduced, hands: "arms" });
    quietSoon();
  } else if (m.type === "cue") {
    const c = m["cue"] as { kind?: string; mood?: string; gesture?: string; intensity?: number };
    if (c.kind === "mood" && typeof c.mood === "string")
      mascot.cue({ expression: rigMoodOf(c.mood), intensity: c.intensity });
    else if (c.kind === "gesture" && typeof c.gesture === "string")
      mascot.play(rigGestureOf(c.gesture));
  } else if (m.type === "moment") mascot.cue(m["cue"] as object);
  else if (m.type === "speak") {
    busy = m["on"] === true;
    if (typeof m["line"] === "string") mascot.line(m["line"]);
    mascot.speak(m["on"] === true);
    if (!busy) quietSoon();
  } else if (m.type === "level" && typeof m["v"] === "number") levelOf?.(m["v"]);
  else if (m.type === "inset" && typeof m["bottom"] === "number") {
    inset = m["bottom"] * innerHeight;
    insetRight = typeof m["right"] === "number" ? m["right"] * innerWidth : 0;
    place(spot, 300);
  } else if (m.type === "go" && typeof m["x"] === "number" && typeof m["y"] === "number")
    walkTo({ x: m["x"] * innerWidth, y: m["y"] * innerHeight });
  else if (m.type === "scale" && typeof m["scale"] === "number")
    place({ ...spot, scale: m["scale"] }, 400);
  else if (m.type === "morph" && (m["dir"] === "in" || m["dir"] === "out")) {
    if (m["dir"] === "out") putAway();
    mascot.morph(m["dir"]);
  } else if (m.type === "stage") {
    const next = m["card"] as StageCard | null;
    if (next === null) putAway();
    else hold(next);
  }
};
// iOS posts to window, Android to document
window.addEventListener("message", (e) => onMessage(e.data));
document.addEventListener("message", (e) => onMessage((e as MessageEvent).data));
tell({ type: "ready" });
