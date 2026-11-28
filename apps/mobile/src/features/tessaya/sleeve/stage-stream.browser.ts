/**
 * Her estate in the Sleeve (M-158): the desk mascot's own rig and page script on the whole screen. She walks where he
 * taps, resizes to his pinch, goes where he carries her; his hand on her is read as the desk reads it, then sent on.
 * Nothing draws at rest: moves are CSS transitions and the rig idles itself.
 */
import { HUMAN_SENSE, MASCOT_SENSE, mergeSense, regionAt } from "@t3tools/tessaya-shared/bodySense";
import { readTouch } from "@t3tools/tessaya-shared/bodyMotion";
import { rigGestureOf, rigMoodOf } from "@t3tools/tessaya-shared/companion";
import { MASCOT_SCRIPT } from "@t3tools/tessaya-shared/mascotPage";
import { clampSpot, pinchScale, wanderSpot, type Spot } from "@t3tools/tessaya-shared/sleeveEstate";

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
const box = () => ({ w: innerWidth, h: innerHeight, bottom: inset });
let inset = 0;
let size = Math.min(innerWidth * 0.62, innerHeight * 0.42);
let spot: Spot = { x: innerWidth / 2, y: innerHeight * 0.38, scale: 1 };
const place = (next: Spot, ms: number) => {
  spot = clampSpot(next, size, box());
  her.style.transition =
    ms > 0 && !reduced ? `transform ${ms}ms cubic-bezier(.45,0,.25,1)` : "none";
  her.style.width = her.style.height = `${size}px`;
  her.style.transform = `translate(${spot.x - size / 2}px,${spot.y - size / 2}px) scale(${spot.scale})`;
};
place(spot, 0);
addEventListener("resize", () => {
  size = Math.min(innerWidth * 0.62, innerHeight * 0.42);
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
// CSS px in a centimetre on a phone (about 160 points to the inch)
const PX_PER_CM = 63;
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
  force: number;
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
    force: e.pressure || 0.5,
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
  p.force = Math.max(p.force, e.pressure || 0);
  if (pinchFrom !== null && presses.size === 2) {
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
    pointers: e.isPrimary ? Math.max(1, presses.size + 1) : 2,
    pressure: p.force,
  });
  mascot.react(felt.kind, felt.speed);
  tell({
    type: "touch",
    part: partAt(p.x0, p.y0),
    kind: felt.kind,
    pressure: felt.intensity,
    cmPerS: ms > 0 ? (p.travel / PX_PER_CM) * (1000 / ms) : 0,
    durationMs: Math.round(ms),
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
    place(spot, 300);
  } else if (m.type === "go" && typeof m["x"] === "number" && typeof m["y"] === "number")
    walkTo({ x: m["x"] * innerWidth, y: m["y"] * innerHeight });
  else if (m.type === "scale" && typeof m["scale"] === "number")
    place({ ...spot, scale: m["scale"] }, 400);
  else if (m.type === "morph" && (m["dir"] === "in" || m["dir"] === "out")) mascot.morph(m["dir"]);
};
// iOS posts to window, Android to document
window.addEventListener("message", (e) => onMessage(e.data));
document.addEventListener("message", (e) => onMessage((e as MessageEvent).data));
tell({ type: "ready" });
