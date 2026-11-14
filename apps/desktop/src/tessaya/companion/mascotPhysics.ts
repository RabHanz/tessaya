/**
 * Her flight when he lets go: a fixed-step point at her feet, under gravity, bouncing on the edges she can stand on
 * (mascotDock.ts) and off the sides and top of the screens, sliding to a stop on a window top or a floor. Pure, so the
 * window loop runs it only while she moves and stops dead when she rests. DIP screen coordinates, seconds.
 */
import type { DisplayArea, Edge } from "./mascotDock.ts";

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

/** One fixed step. Events say what she hit, for a squish or a sound. */
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
    // Off the end of a window top: she falls again.
    if (within(f.on, x)) return { flight: { ...f, x, vx, vy: 0 }, events };
    if (f.on.kind === "floor") {
      events.push({ kind: "wall", speed: Math.abs(vx) });
      return {
        flight: { ...f, x: Math.min(Math.max(x, f.on.x1), f.on.x2), vx: -vx * p.bounce },
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

  // The screen she is over keeps her in: its sides and its top turn her back.
  const screen =
    displays.find((d) => f.x >= d.workArea.x && f.x <= d.workArea.x + d.workArea.width) ??
    displays[0];
  if (screen !== undefined) {
    const w = screen.workArea;
    const left = w.x + half;
    const right = w.x + w.width - half;
    const leaving = (x < left && vx < 0) || (x > right && vx > 0);
    // Crossing into a neighbouring screen is allowed; only a side with no screen beyond turns her.
    const beyond = displays.some(
      (d) => d !== screen && x >= d.workArea.x && x <= d.workArea.x + d.workArea.width,
    );
    if (leaving && !beyond) {
      events.push({ kind: "wall", speed: Math.abs(vx) });
      x = Math.min(Math.max(x, left), right);
      vx = -vx * p.bounce;
    }
    if (y < w.y + half * 2 && vy < 0) {
      y = w.y + half * 2;
      vy = -vy * p.bounce;
    }
  }

  // Falling through an edge's line between this step and the last: she lands on the highest one.
  if (vy > 0) {
    const hit = edges
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

  // Below a floor (she fell past it in the gap between screens) or below every floor: a floor catches her.
  const floors = edges.filter((e) => e.kind === "floor");
  const under = floors.find((e) => within(e, x));
  if (
    under !== undefined ? y > under.y : floors.length > 0 && y > Math.max(...floors.map((e) => e.y))
  ) {
    const floor =
      under ??
      floors.toSorted(
        (a, b) => Math.abs((a.x1 + a.x2) / 2 - x) - Math.abs((b.x1 + b.x2) / 2 - x),
      )[0]!;
    return {
      flight: { x: Math.min(Math.max(x, floor.x1), floor.x2), y: floor.y, vx: 0, vy: 0, on: floor },
      events: [{ kind: "land", speed: vy, edge: floor }],
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
