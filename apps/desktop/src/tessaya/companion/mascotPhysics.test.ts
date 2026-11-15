import { describe, expect, it } from "vite-plus/test";

import { edgesFor, seamsOf, type DisplayArea } from "./mascotDock.ts";
import {
  DEFAULT_PROFILE,
  MAX_THROW,
  bumpOf,
  flightProfile,
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

const fly = (
  start: Flight,
  edges = edgesFor({ displays: HIS, window: null, size: 190 }),
  displays: ReadonlyArray<DisplayArea> = HIS,
) => {
  let flight = start;
  const events: FlightEvent[] = [];
  for (let i = 0; i < 120 * 20 && !resting(flight); i++) {
    const next = stepFlight({ flight, edges, displays, half: HALF, profile: DEFAULT_PROFILE });
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

const screen = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  o: { readonly taskbar?: number; readonly scaleFactor?: number } = {},
): DisplayArea => ({
  id,
  bounds: { x, y, width, height },
  workArea: { x, y, width, height: height - (o.taskbar ?? 0) },
  ...(o.scaleFactor === undefined ? {} : { scaleFactor: o.scaleFactor }),
});
const across = (displays: ReadonlyArray<DisplayArea>, start: Flight) =>
  fly(start, edgesFor({ displays, window: null, size: 190 }), displays).flight;

describe("one big desktop", () => {
  // His real screens: 175 % and 125 %. Windows' DIP rects leave a 878 px gap; physically they touch.
  const HIS_SCALED = [
    { ...HIS[0]!, scaleFactor: 1.75 },
    { ...HIS[1]!, scaleFactor: 1.25 },
  ];

  it("finds where mixed-scale screens touch in Windows' physical layout, and DIP-touching ones as they are", () => {
    const [seam] = seamsOf(HIS_SCALED, HIS_SCALED[0]!, "right");
    expect(seam?.to.id).toBe(2);
    expect(seam?.k).toBeCloseTo(1.4);
    expect(seam?.from).toBeCloseTo(134.3, 0);
    expect(seamsOf(HIS, HIS[0]!, "right")).toEqual([]);
    // A taskbar along the shared side is in the way.
    expect(seamsOf(HIS_SCALED, HIS_SCALED[0]!, "bottom")).toEqual([]);
    const mac = [screen(1, 0, 0, 1512, 982, { scaleFactor: 2 }), screen(2, 1512, -200, 2560, 1440)];
    expect(seamsOf(mac, mac[0]!, "right")[0]).toMatchObject({ k: 1, from: 0, until: 982 });
  });

  it("flies a throw across into the other screen, in its own DIP, and lands on its floor", () => {
    const end = across(HIS_SCALED, { x: 2000, y: 600, vx: 1600, vy: -300, on: null });
    expect(end.on?.display).toBe(2);
    expect(end.y).toBe(188 + 1488);
    // The same throw between screens whose DIP rects only look apart turns back at the side.
    expect(across(HIS, { x: 2000, y: 600, vx: 1600, vy: -300, on: null }).on?.display).toBe(1);
  });

  it("turns her back at the part of a side an offset screen does not cover", () => {
    const offset = [
      screen(1, 0, 0, 1920, 1080, { taskbar: 40 }),
      screen(2, 1920, 600, 1280, 1024, { taskbar: 40 }),
    ];
    const high = across(offset, { x: 1700, y: 250, vx: 2500, vy: 0, on: null });
    expect(high.on?.display).toBe(1);
    const low = across(offset, { x: 1700, y: 900, vx: 2500, vy: 0, on: null });
    expect(low.on?.display).toBe(2);
    expect(low.y).toBe(600 + 984);
  });

  it("drops her through a screen with another below it, but stops her on a floor with nothing beneath", () => {
    const stacked = [
      screen(1, 0, 0, 1920, 1080),
      screen(2, 960, 1080, 2560, 1440, { taskbar: 48 }),
    ];
    const floors = edgesFor({ displays: stacked, window: null, size: 190 }).filter(
      (e) => e.display === 1,
    );
    expect(floors.map((e) => [e.x1, e.x2])).toEqual([[0, 960]]);
    const through = across(stacked, { x: 1500, y: 300, vx: 0, vy: 0, on: null });
    expect(through.on?.display).toBe(2);
    expect(through.y).toBe(1080 + 1392);
    expect(across(stacked, { x: 400, y: 300, vx: 0, vy: 0, on: null })).toMatchObject({
      y: 1080,
      on: { display: 1 },
    });
    // Thrown up from the lower screen she rises into the upper one and comes back down.
    const up = across(stacked, { x: 1500, y: 2400, vx: 0, vy: -3500, on: null });
    expect(up.on?.display).toBe(2);
  });

  it("slides off the end of a floor onto the screen beside it when the floors meet", () => {
    const side = [screen(1, 0, 0, 1920, 1080), screen(2, 1920, 0, 1920, 1080)];
    const slid = fly(
      {
        x: 1700,
        y: 1080,
        vx: 2500,
        vy: 0,
        on: edgesFor({ displays: side, window: null, size: 190 })[0]!,
      },
      edgesFor({ displays: side, window: null, size: 190 }),
      side,
    ).flight;
    expect(slid.on?.display).toBe(2);
  });

  it("keeps a throw on one screen when given only that screen", () => {
    const only = [HIS_SCALED[0]!];
    const end = across(only, { x: 1800, y: 600, vx: 4000, vy: -1500, on: null });
    expect(end.on?.display).toBe(1);
    expect(end.x).toBeLessThanOrEqual(2194);
  });

  it("always ends on a floor inside a work area, whatever the throw, on every layout", () => {
    const layouts = [
      HIS_SCALED,
      [screen(1, 0, 0, 1920, 1080), screen(2, 960, 1080, 2560, 1440, { taskbar: 48 })],
      [screen(1, -1280, 200, 1280, 1024), screen(2, 0, 0, 1920, 1080, { taskbar: 40 })],
    ];
    let seed = 11;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const layout of layouts)
      for (let i = 0; i < 100; i++) {
        const from = layout[i % layout.length]!.workArea;
        const end = across(layout, {
          x: from.x + 100 + Math.abs(random()) * (from.width - 200),
          y: from.y + 300 + Math.abs(random()) * (from.height - 400),
          vx: random() * MAX_THROW,
          vy: random() * MAX_THROW,
          on: null,
        });
        expect(resting(end)).toBe(true);
        const d = layout.find((s) => s.id === end.on!.display)!.workArea;
        expect(end.y).toBe(d.y + d.height);
        expect(end.x).toBeGreaterThanOrEqual(d.x);
        expect(end.x).toBeLessThanOrEqual(d.x + d.width);
      }
  });
});

describe("flightProfile", () => {
  it("takes her character's flight, clamps wild values and keeps the default for anything unreadable", () => {
    expect(flightProfile({ gravity: 2840, bounce: 0.12, friction: 10, drag: 0.23 })).toEqual({
      gravity: 2840,
      bounce: 0.12,
      friction: 10,
      drag: 0.23,
    });
    expect(flightProfile({ gravity: 1e9, bounce: -1, friction: "x" })).toEqual({
      gravity: 5000,
      bounce: 0,
      friction: DEFAULT_PROFILE.friction,
      drag: DEFAULT_PROFILE.drag,
    });
    expect(flightProfile(null)).toEqual(DEFAULT_PROFILE);
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

describe("bumpOf", () => {
  const still = { x: 600, y: 1186, half: 50, tall: 90 };
  const sliding = (x: number, y: number, vx: number): Flight => ({ x, y, vx, vy: 0, on: null });
  const bump = (flight: Flight, others = [still]) =>
    bumpOf({ flight, half: 50, tall: 90, bounce: 0.35, others });

  it("flying sideways into one who stands still, she bounces back and knocks the other along", () => {
    const hit = bump(sliding(520, 1180, 1200));
    expect(hit?.index).toBe(0);
    expect(hit?.flight.x).toBe(500);
    expect(hit!.push).toBeGreaterThan(1200 / 2);
    expect(Math.abs(hit!.flight.vx)).toBeLessThan(hit!.push);
    expect(bump(sliding(680, 1180, -1200))?.push).toBeLessThan(0);
  });

  it("misses one behind her, one she passes high over (she lands on its head instead) and a slow nudge", () => {
    expect(bump(sliding(680, 1180, 1200))).toBeNull();
    expect(bump(sliding(560, 1186 - 80, 1200))).toBeNull();
    expect(bump(sliding(560, 1180, 5))).toBeNull();
    expect(bump(sliding(300, 1180, 1200))).toBeNull();
  });
});
