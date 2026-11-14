import { describe, expect, it } from "vite-plus/test";

import { edgesFor, type DisplayArea } from "./mascotDock.ts";
import {
  DEFAULT_PROFILE,
  MAX_THROW,
  resting,
  stepFlight,
  throwVelocity,
  type Flight,
  type FlightEvent,
} from "./mascotPhysics.ts";

// His layout: a landscape screen with a 48 px taskbar, and a portrait one to its right, lower down.
const HIS: ReadonlyArray<DisplayArea> = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 2194, height: 1234 },
    workArea: { x: 0, y: 0, width: 2194, height: 1186 },
  },
  {
    id: 2,
    bounds: { x: 3072, y: 188, width: 864, height: 1536 },
    workArea: { x: 3072, y: 188, width: 864, height: 1488 },
  },
];
const HALF = 50;

const fly = (start: Flight, edges = edgesFor({ displays: HIS, window: null, size: 190 })) => {
  let flight = start;
  const events: FlightEvent[] = [];
  for (let i = 0; i < 120 * 20 && !resting(flight); i++) {
    const next = stepFlight({ flight, edges, displays: HIS, half: HALF, profile: DEFAULT_PROFILE });
    flight = next.flight;
    events.push(...next.events);
  }
  return { flight, events };
};

describe("stepFlight", () => {
  it("drops her onto the floor above the taskbar, bounces less each time, and rests", () => {
    const { flight, events } = fly({ x: 1000, y: 200, vx: 0, vy: 0, on: null });
    expect(resting(flight)).toBe(true);
    expect(flight.y).toBe(1186);
    const lands = events.filter((e) => e.kind === "land").map((e) => e.speed);
    expect(lands.length).toBeGreaterThan(1);
    for (let i = 1; i < lands.length; i++) expect(lands[i]!).toBeLessThan(lands[i - 1]!);
  });

  it("catches her on a window top she falls onto, slides her with friction, and lets her fall off its end", () => {
    const edges = edgesFor({
      displays: HIS,
      window: { x: 400, y: 600, width: 700, height: 400 },
      size: 190,
    });
    const caught = fly({ x: 600, y: 300, vx: 0, vy: 0, on: null }, edges);
    expect(caught.flight.on?.kind).toBe("window");
    expect(caught.flight.y).toBe(600);
    // Thrown hard along it, she runs off the end and lands on the floor.
    const slid = fly({ x: 900, y: 600, vx: 1500, vy: 0, on: edges[0]! }, edges);
    expect(slid.flight.on?.kind).toBe("floor");
    expect(slid.flight.y).toBe(1186);
  });

  it("turns back at a screen side with no screen beyond it, and never leaves the work area", () => {
    const { flight, events } = fly({ x: 200, y: 600, vx: -3000, vy: -500, on: null });
    expect(events.some((e) => e.kind === "wall")).toBe(true);
    expect(flight.x).toBeGreaterThanOrEqual(HALF);
    expect(flight.y).toBe(1186);
  });

  it("always ends on an edge inside a work area, whatever the throw", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 200; i++) {
      const start: Flight = {
        x: 100 + Math.abs(random()) * 3800,
        y: 300 + Math.abs(random()) * 800,
        vx: random() * MAX_THROW,
        vy: random() * MAX_THROW,
        on: null,
      };
      const { flight } = fly(start);
      expect(resting(flight)).toBe(true);
      const screen = HIS.find((d) => d.id === flight.on!.display)!;
      expect(flight.y).toBe(screen.workArea.y + screen.workArea.height);
      expect(flight.x).toBeGreaterThanOrEqual(screen.workArea.x);
      expect(flight.x).toBeLessThanOrEqual(screen.workArea.x + screen.workArea.width);
    }
  });
});

describe("throwVelocity", () => {
  it("reads his hand's speed over the last 80 ms and caps a wild flick", () => {
    expect(
      throwVelocity([
        { x: 0, y: 0, t: 0 },
        { x: 10, y: 0, t: 100 },
        { x: 30, y: -10, t: 140 },
        { x: 70, y: -30, t: 180 },
      ]),
    ).toEqual({ vx: 750, vy: -375 });
    const flick = throwVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 5000, y: 0, t: 16 },
    ]);
    expect(Math.hypot(flick.vx, flick.vy)).toBeCloseTo(MAX_THROW);
    expect(throwVelocity([{ x: 1, y: 1, t: 5 }])).toEqual({ vx: 0, vy: 0 });
  });
});
