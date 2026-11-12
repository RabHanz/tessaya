import { describe, expect, it } from "vite-plus/test";

import {
  FOOT_SHARE,
  edgesFor,
  followFocus,
  followWindow,
  landing,
  standAt,
  wanderTo,
  type DisplayArea,
} from "./mascotDock.ts";

const SIZE = 150;
// Two screens side by side: 1920×1080 with a 48 px taskbar, and 1280×720 to its right with none.
const DISPLAYS: ReadonlyArray<DisplayArea> = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1032 },
  },
  {
    id: 2,
    bounds: { x: 1920, y: 0, width: 1280, height: 720 },
    workArea: { x: 1920, y: 0, width: 1280, height: 720 },
  },
];

describe("edgesFor", () => {
  it("offers the top of his window when there is room above it, and every screen's floor", () => {
    const edges = edgesFor({
      displays: DISPLAYS,
      window: { x: 200, y: 300, width: 900, height: 600 },
      size: SIZE,
    });
    expect(edges).toEqual([
      { kind: "window", x1: 200, x2: 1100, y: 300, display: 1 },
      { kind: "floor", x1: 0, x2: 1920, y: 1032, display: 1 },
      { kind: "floor", x1: 1920, x2: 3200, y: 720, display: 2 },
    ]);
  });

  it("skips a maximised window, one too narrow, and clips one hanging off its screen", () => {
    const maximised = edgesFor({
      displays: DISPLAYS,
      window: { x: 0, y: 0, width: 1920, height: 1032 },
      size: SIZE,
    });
    expect(maximised.every((e) => e.kind === "floor")).toBe(true);
    const narrow = edgesFor({
      displays: DISPLAYS,
      window: { x: 500, y: 400, width: 150, height: 300 },
      size: SIZE,
    });
    expect(narrow.every((e) => e.kind === "floor")).toBe(true);
    const off = edgesFor({
      displays: DISPLAYS,
      window: { x: 1500, y: 400, width: 600, height: 300 },
      size: SIZE,
    });
    expect(off[0]).toEqual({ kind: "window", x1: 1500, x2: 1920, y: 400, display: 1 });
  });
});

describe("landing", () => {
  const edges = edgesFor({
    displays: DISPLAYS,
    window: { x: 200, y: 300, width: 900, height: 600 },
    size: SIZE,
  });

  it("drops onto the first edge under her feet", () => {
    expect(landing(edges, 600, 100).kind).toBe("window");
    expect(landing(edges, 600, 400)).toMatchObject({ kind: "floor", display: 1 });
    expect(landing(edges, 1500, 100)).toMatchObject({ kind: "floor", display: 1 });
  });

  it("lands on the screen she was dropped on, and on the nearest screen when dropped between them", () => {
    expect(landing(edges, 2500, 100)).toMatchObject({ kind: "floor", display: 2 });
    expect(landing(edges, 2500, 900)).toMatchObject({ kind: "floor", display: 2 });
    expect(landing(edges, 4000, 100)).toMatchObject({ kind: "floor", display: 2 });
  });
});

describe("standAt", () => {
  const floor = { kind: "floor" as const, x1: 0, x2: 1920, y: 1032, display: 1 };

  it("puts her feet on the edge and keeps her on it", () => {
    expect(standAt(floor, 960, SIZE)).toEqual({ x: 885, y: Math.round(1032 - SIZE * FOOT_SHARE) });
    expect(standAt(floor, -500, SIZE).x).toBe(Math.round(SIZE * 0.25 - SIZE / 2));
    expect(standAt(floor, 99_999, SIZE).x).toBe(Math.round(1920 - SIZE * 0.25 - SIZE / 2));
  });

  it("sinks her when snoozed so only the top of her head shows", () => {
    expect(standAt(floor, 960, SIZE, true).y - standAt(floor, 960, SIZE).y).toBe(45);
  });
});

describe("wanderTo", () => {
  const edge = { kind: "window" as const, x1: 200, x2: 1100, y: 300, display: 1 };

  it("goes at least 80 px and stays on the edge", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const to = wanderTo(edge, 600, r)!;
      expect(Math.abs(to - 600)).toBeGreaterThanOrEqual(80);
      expect(to).toBeGreaterThanOrEqual(240);
      expect(to).toBeLessThanOrEqual(1060);
    }
  });

  it("stays put on an edge too short for a walk", () => {
    expect(wanderTo({ ...edge, x1: 500, x2: 700 }, 600, 0.5)).toBeNull();
  });
});

describe("followWindow", () => {
  const sitting = { kind: "window" as const, x1: 200, x2: 1100, y: 300, display: 1 };
  const floor = { kind: "floor" as const, x1: 0, x2: 1920, y: 1032, display: 1 };

  it("rides along when his window moves", () => {
    const moved = { ...sitting, x1: 300, x2: 1200, y: 250 };
    expect(followWindow(sitting, 600, [moved, floor])).toEqual({ edge: moved, x: 700 });
  });

  it("drops when the window closes or another one takes its place", () => {
    expect(followWindow(sitting, 600, [floor])).toBeNull();
    expect(followWindow(sitting, 600, [{ ...sitting, x1: 100, x2: 1500 }, floor])).toBeNull();
  });

  it("leaves her alone on a floor", () => {
    expect(followWindow(floor, 900, [floor])).toEqual({ edge: floor, x: 900 });
  });
});

describe("followFocus", () => {
  const floor = { kind: "floor" as const, x1: 0, x2: 1920, y: 1032, display: 1 };
  const top = { kind: "window" as const, x1: 200, x2: 1100, y: 300, display: 1 };
  const go = (
    current: typeof floor | typeof top,
    edges: ReadonlyArray<typeof floor | typeof top>,
    placed = false,
    still = false,
  ) => followFocus({ current, x: 1500, edges, placed, still });

  it("hops up onto the window he is in, unless he put her down himself or she keeps still", () => {
    expect(go(floor, [top, floor])).toEqual({ edge: top, x: 1040, how: "hop" });
    expect(go(floor, [top, floor], true).how).toBe("stay");
    expect(go(floor, [top, floor], false, true).how).toBe("stay");
  });

  it("rides her window, and moves to the next one or drops when it goes", () => {
    const moved = { ...top, x1: 260, x2: 1160 };
    expect(go(top, [moved, floor])).toMatchObject({ edge: moved, how: "ride" });
    expect(go(top, [top, floor]).how).toBe("stay");
    expect(go(top, [floor])).toMatchObject({ edge: floor, how: "drop" });
    const other = { ...top, x1: 100, x2: 700 };
    expect(go(top, [other, floor])).toMatchObject({ edge: other, how: "hop" });
    expect(go(top, [other, floor], false, true)).toMatchObject({ edge: floor, how: "drop" });
  });
});
