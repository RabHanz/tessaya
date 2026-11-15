/**
 * Her flight when he lets go: a fixed-step point at her feet, under gravity, bouncing on the edges she can stand on
 * (mascotDock.ts) and off the sides and top of the screens, sliding to a stop on a window top or a floor. Pure, so the
 * window loop runs it only while she moves and stops dead when she rests. DIP screen coordinates, seconds.
 */
import { seamAt, type DisplayArea, type Edge, type Rect } from "./mascotDock.ts";

export interface PhysicsProfile {
  /** Downward pull, px/s². */
  readonly gravity: number;
  /** Share of the falling speed kept by a bounce. */
  readonly bounce: number;
  /** Share of the sliding speed lost per second on an edge. */
  readonly friction: number;
  /** Share of the speed lost per second in the air. */
  readonly drag: number;
}

export const DEFAULT_PROFILE: PhysicsProfile = {
  gravity: 2600,
  bounce: 0.35,
  friction: 6,
  drag: 0.4,
};

/** Her own flight from her character's profile (bodies.js TCS.flightOf, read from her page); anything unreadable keeps the default. */
export const flightProfile = (raw: unknown): PhysicsProfile => {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof PhysicsProfile, lo: number, hi: number) => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, v))
      : DEFAULT_PROFILE[k];
  };
  return {
    gravity: pick("gravity", 1000, 5000),
    bounce: pick("bounce", 0, 0.9),
    friction: pick("friction", 0, 30),
    drag: pick("drag", 0, 2),
  };
};

export interface Flight {
  /** Her feet. */
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** The edge under her feet, or null in the air. */
  readonly on: Edge | null;
}

export type FlightEvent =
  | { readonly kind: "land"; readonly speed: number; readonly edge: Edge }
  | { readonly kind: "wall"; readonly speed: number };

export const STEP_S = 1 / 120;
/** A throw faster than this is capped: she crosses a screen in about a third of a second. */
export const MAX_THROW = 4000;
/** Slower than this along an edge, she has stopped. */
const REST_SPEED = 12;
/** A bounce slower than this sticks. */
const STICK_SPEED = 160;
/** How far a foot can sink below an edge in one step and still count as landing on it. */
const CATCH = 1;

const within = (e: Edge, x: number) => x >= e.x1 && x <= e.x2;

export const resting = (f: Flight): boolean => f.on !== null && Math.abs(f.vx) < REST_SPEED;

const inArea = (x: number, y: number, r: Rect) =>
  x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The screen she is in: the work area holding her middle, else the closest one. */
export const screenOf = (
  displays: ReadonlyArray<DisplayArea>,
  x: number,
  y: number,
): DisplayArea | undefined =>
  displays.find((d) => inArea(x, y, d.workArea)) ??
  displays.toSorted((a, b) => {
    const far = (r: Rect) =>
      Math.hypot(x - clampTo(x, r.x, r.x + r.width), y - clampTo(y, r.y, r.y + r.height));
    return far(a.workArea) - far(b.workArea);
  })[0];

/**
 * One fixed step. Events say what she hit, for a squish or a sound. Every side of her screen is a wall except where
 * another screen touches it (mascotDock.ts seamsOf): there she flies on into that screen, in its own DIP. Pass one
 * screen to keep a throw on it.
 */
export const stepFlight = (input: {
  readonly flight: Flight;
  readonly edges: ReadonlyArray<Edge>;
  readonly displays: ReadonlyArray<DisplayArea>;
  /** Half her body's width, so she turns at a wall before her body goes through it. */
  readonly half: number;
  readonly profile: PhysicsProfile;
}): { readonly flight: Flight; readonly events: ReadonlyArray<FlightEvent> } => {
  const { flight: f, edges, displays, half, profile: p } = input;
  const events: FlightEvent[] = [];
  const dt = STEP_S;

  if (f.on !== null) {
    const slow = Math.max(0, 1 - p.friction * dt);
    const vx = Math.abs(f.vx * slow) < REST_SPEED ? 0 : f.vx * slow;
    const x = f.x + vx * dt;
    if (within(f.on, x)) return { flight: { ...f, x, vx, vy: 0 }, events };
    // Off the end of a window top, or of a floor where a screen continues beside or below: she falls again.
    const screen = displays.find((d) => d.id === f.on!.display);
    const side = x < f.on.x1 ? "left" : "right";
    const w = screen?.workArea;
    const endsInside =
      w !== undefined && (side === "left" ? f.on.x1 > w.x + 1 : f.on.x2 < w.x + w.width - 1);
    const beside = screen !== undefined && seamAt(displays, screen, side, f.y - half) !== undefined;
    if (f.on.kind === "floor" && !endsInside && !beside) {
      events.push({ kind: "wall", speed: Math.abs(vx) });
      return {
        flight: { ...f, x: clampTo(x, f.on.x1, f.on.x2), vx: -vx * p.bounce },
        events,
      };
    }
    return { flight: { ...f, x, vx, on: null }, events };
  }

  const air = Math.max(0, 1 - p.drag * dt);
  let vx = f.vx * air;
  let vy = f.vy * air + p.gravity * dt;
  let x = f.x + vx * dt;
  let y = f.y + vy * dt;

  const home = screenOf(displays, f.x, f.y - half);
  if (home === undefined) return { flight: { x, y, vx, vy, on: null }, events };
  const w = home.workArea;
  const right = w.x + w.width;
  const bottom = w.y + w.height;
  const mid = clampTo(y - half, w.y, bottom - 1);
  // Walls: a side of her screen with no screen across it at her height turns her back.
  if (vx > 0 && x + half > right && seamAt(displays, home, "right", mid) === undefined) {
    events.push({ kind: "wall", speed: Math.abs(vx) });
    x = right - half;
    vx = -vx * p.bounce;
  } else if (vx < 0 && x - half < w.x && seamAt(displays, home, "left", mid) === undefined) {
    events.push({ kind: "wall", speed: Math.abs(vx) });
    x = w.x + half;
    vx = -vx * p.bounce;
  }
  if (
    vy < 0 &&
    y - half * 2 < w.y &&
    seamAt(displays, home, "top", clampTo(x, w.x, right - 1)) === undefined
  ) {
    y = w.y + half * 2;
    vy = -vy * p.bounce;
  }

  // Falling through an edge's line on her screen between this step and the last: she lands on the highest one.
  const mine = edges.filter((e) => e.display === home.id);
  if (vy > 0) {
    const hit = mine
      .filter((e) => within(e, x) && f.y <= e.y + CATCH && y >= e.y)
      .sort((a, b) => a.y - b.y)[0];
    if (hit !== undefined) {
      events.push({ kind: "land", speed: vy, edge: hit });
      const up = vy * p.bounce;
      return {
        flight:
          up < STICK_SPEED
            ? { x, y: hit.y, vx, vy: 0, on: hit }
            : { x, y: hit.y, vx, vy: -up, on: null },
        events,
      };
    }
  }

  // Her middle crossed into the screen across a seam: she carries on there, in its DIP.
  const cy = y - half;
  const side =
    x > right ? "right" : x < w.x ? "left" : cy < w.y ? "top" : cy > bottom ? "bottom" : null;
  if (side !== null) {
    const seam = seamAt(
      displays,
      home,
      side,
      side === "left" || side === "right"
        ? clampTo(cy, w.y, bottom - 1)
        : clampTo(x, w.x, right - 1),
    );
    if (seam !== undefined)
      return {
        flight: {
          x: x * seam.k,
          y: cy * seam.k + half,
          vx: vx * seam.k,
          vy: vy * seam.k,
          on: null,
        },
        events,
      };
  }

  // Below her screen's floor (a step past it, or a start beneath it): the floor catches her.
  const floors = mine.filter((e) => e.kind === "floor");
  const under = floors.find((e) => within(e, x));
  const open = seamAt(displays, home, "bottom", clampTo(x, w.x, right - 1)) !== undefined;
  if (under !== undefined ? y > under.y : !open && floors.length > 0 && y > bottom) {
    const floor =
      under ??
      floors.toSorted(
        (a, b) => Math.abs((a.x1 + a.x2) / 2 - x) - Math.abs((b.x1 + b.x2) / 2 - x),
      )[0]!;
    return {
      flight: { x: clampTo(x, floor.x1, floor.x2), y: floor.y, vx: 0, vy: 0, on: floor },
      events: [...events, { kind: "land", speed: vy, edge: floor }],
    };
  }
  return { flight: { x, y, vx, vy, on: null }, events };
};

/** His hand's speed over the last moments of a drag, px/s, capped: how hard she was thrown. */
export const throwVelocity = (
  samples: ReadonlyArray<{ readonly x: number; readonly y: number; readonly t: number }>,
  windowMs = 80,
): { readonly vx: number; readonly vy: number } => {
  const last = samples.at(-1);
  if (last === undefined) return { vx: 0, vy: 0 };
  const first = samples.find((s) => last.t - s.t <= windowMs) ?? last;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0 };
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  const k = speed > MAX_THROW ? MAX_THROW / speed : 1;
  return { vx: vx * k, vy: vy * k };
};

/** Another character standing still: her feet, and half her body's width and her height. */
export interface Standing {
  readonly x: number;
  readonly y: number;
  readonly half: number;
  readonly tall: number;
}

/**
 * Flying sideways into one who stands still (the sandbox's collide): she bounces back off and knocks the other along.
 * Equal weights, so `push` is the other's new speed. A flier above the other's head lands on it instead (an edge).
 * shortcut: equal masses, not bodies.js mass; pass masses in if a heavy Pebble should barely budge.
 */
export const bumpOf = (input: {
  readonly flight: Flight;
  readonly half: number;
  readonly tall: number;
  readonly bounce: number;
  readonly others: ReadonlyArray<Standing>;
}): { readonly index: number; readonly flight: Flight; readonly push: number } | null => {
  const { flight: f, half, tall } = input;
  if (Math.abs(f.vx) < REST_SPEED) return null;
  const index = input.others.findIndex(
    (o) =>
      Math.abs(o.x - f.x) < half + o.half &&
      Math.sign(o.x - f.x) === Math.sign(f.vx) &&
      f.y > o.y - o.tall * 0.6 &&
      f.y - tall < o.y,
  );
  if (index < 0) return null;
  const o = input.others[index]!;
  const e = Math.min(input.bounce + 0.25, 1);
  return {
    index,
    flight: { ...f, x: o.x - Math.sign(f.vx) * (half + o.half), vx: (f.vx * (1 - e)) / 2 },
    push: (f.vx * (1 + e)) / 2,
  };
};
