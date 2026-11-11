import { describe, expect, it } from "vite-plus/test";

import {
  pickScreen,
  sharedSpot,
  PLACES,
  cursorOverCapsule,
  defaultPosition,
  parseSpots,
  placePosition,
  positionOf,
  snapPosition,
  spotFrom,
  baseOf,
  createLowerHold,
  grownBounds,
  frostBounds,
} from "./pillPlacement.ts";

const size = { width: 420, height: 52 };
const hd = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };

describe("where the pill sits", () => {
  it("starts centred above the taskbar, or at the top", () => {
    const m = { top: 10, bottom: 44 };
    expect(defaultPosition(hd, size, "bottom", m)).toEqual({ x: 750, y: 944 });
    expect(defaultPosition(hd, size, "top", m)).toEqual({ x: 750, y: 10 });
  });
  it("keeps a dragged place as a fraction, so another resolution puts it in the same place", () => {
    const spot = spotFrom(hd, size, { x: 300, y: 500 });
    const there = positionOf({ x: 0, y: 0, width: 1280, height: 720 }, size, spot);
    expect(there.x).toBeGreaterThan(150);
    expect(there.x + size.width).toBeLessThanOrEqual(1280);
    expect(there.y + size.height).toBeLessThanOrEqual(720);
  });
  it("never leaves the work area, and follows a display that moved", () => {
    const off = spotFrom(hd, size, { x: 5000, y: -400 });
    expect(off).toEqual({ fx: 1, fy: 0 });
    expect(positionOf(second, size, off)).toEqual({ x: 1920 + 2560 - 420, y: 0 });
  });
  it("reads a saved file without trusting it", () => {
    expect(
      parseSpots({
        "1": { fx: 2, fy: -1 },
        "2": { fx: "a" },
        "3": null,
        "4": { fx: 0.5, fy: 0.5 },
      }),
    ).toEqual({
      "1": { fx: 1, fy: 0 },
      "4": { fx: 0.5, fy: 0.5 },
    });
    expect(parseSpots("nope")).toEqual({});
  });
});

describe("snapping a drag", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 420, height: 52 };
  const margins = { top: 10, bottom: 44 };
  const free = { bypass: false, margins };

  it("pulls onto a named place when near it, and names it", () => {
    const centre = placePosition(area, size, "centre", margins);
    expect(snapPosition(area, size, { x: centre.x + 25, y: centre.y - 18 }, free)).toEqual({
      ...centre,
      place: "centre",
    });
    const bottom = placePosition(area, size, "bottom", margins);
    expect(snapPosition(area, size, { x: bottom.x - 10, y: bottom.y + 9 }, free)).toMatchObject({
      y: bottom.y,
      place: "bottom",
    });
    expect(snapPosition(area, size, { x: 3, y: 4 }, free)).toMatchObject({ place: "top-left" });
  });

  it("steps onto a grid elsewhere, stays inside the work area, and leaves free placement to Alt or Shift", () => {
    const grid = snapPosition(area, size, { x: 400, y: 300 }, free);
    expect(grid.place).toBeNull();
    expect((grid.x / ((area.width - size.width) / 24)) % 1).toBeCloseTo(0, 5);
    expect(snapPosition(area, size, { x: 5000, y: -200 }, free)).toMatchObject({
      x: 1500,
      y: 10,
      place: "top-right",
    });
    expect(snapPosition(area, size, { x: 401, y: 303 }, { ...free, bypass: true })).toEqual({
      x: 401,
      y: 303,
      place: null,
    });
    expect(PLACES.map((p) => p.id)).toContain("centre");
  });
});

describe("dragging is free on both axes", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 420, height: 52 };
  const margins = { top: 10, bottom: 44 };
  const free = { bypass: false, margins };

  it("from bottom centre, a cursor 200 px up lands 200 px up, and one 400 px up goes on past the middle", () => {
    const bottom = placePosition(area, size, "bottom", margins);
    const up200 = snapPosition(area, size, { x: bottom.x, y: bottom.y - 200 }, free);
    expect(up200.place).toBeNull();
    expect(up200.y).toBeLessThan(bottom.y - 150);
    expect(up200.y).toBeGreaterThan(bottom.y - 250);
    const up500 = snapPosition(area, size, { x: bottom.x + 90, y: bottom.y - 500 }, free);
    expect(up500.y).toBeLessThan(bottom.y - 450);
    // Sideways moves too, with the row kept.
    const across = snapPosition(area, size, { x: bottom.x + 300, y: bottom.y }, free);
    expect(across.x).toBeGreaterThan(bottom.x + 250);
    expect(Math.abs(across.y - bottom.y)).toBeLessThan(25);
  });
});

describe("grabbing the pill", () => {
  // The laptop's 735x91 window at 1554,82 with the capsule drawn at x 302..434, y 26..67.
  const window = { x: 1554, y: 82, width: 735, height: 91 };
  const capsule = { x: 302, y: 26, width: 132, height: 41 };
  it("takes the mouse over the whole capsule and lets it through elsewhere", () => {
    expect(cursorOverCapsule({ x: 1922, y: 128 }, window, capsule)).toBe(true);
    expect(cursorOverCapsule({ x: 1860, y: 110 }, window, capsule)).toBe(true);
    expect(cursorOverCapsule({ x: 1554 + 100, y: 128 }, window, capsule)).toBe(false);
    expect(cursorOverCapsule({ x: 1922, y: 82 + 5 }, window, capsule)).toBe(false);
  });
});

describe("dragging the pill twice", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 735, height: 91 };
  const m = { top: 10, bottom: 44 };
  it("grabs where it now is, and a drag back up moves it again", () => {
    const start = { x: 592, y: 82 };
    const down = snapPosition(
      area,
      size,
      { x: start.x, y: start.y + 300 },
      { bypass: false, margins: m },
    );
    expect(down.y).toBeGreaterThan(start.y + 200);
    const capsule = { x: 302, y: 26, width: 132, height: 41 };
    expect(
      cursorOverCapsule(
        { x: down.x + 368, y: down.y + 46 },
        { ...size, x: down.x, y: down.y },
        capsule,
      ),
    ).toBe(true);
    const up = snapPosition(
      area,
      size,
      { x: down.x, y: down.y - 300 },
      { bypass: false, margins: m },
    );
    expect(up.y).toBeLessThan(down.y - 200);
  });
});

describe("which screen the pill shows on", () => {
  // A 1080p laptop at 150% (1280x720 in DIP) left of a 4K monitor at 200% (1920x1080 in DIP).
  const laptop = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 0, width: 1280, height: 672 },
  };
  const monitor = {
    id: 2,
    bounds: { x: 1280, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1280, y: 0, width: 1920, height: 1040 },
  };
  const screens = [laptop, monitor];

  it.each([
    // [what is known, the screen it picks]    // The target window, by where most of it is, over the cursor.
    [{ window: { x: 1000, y: 100, width: 900, height: 500 }, cursor: { x: 10, y: 10 } }, 2],
    [{ window: { x: 100, y: 100, width: 900, height: 500 }, cursor: { x: 2000, y: 10 } }, 1],
    [{ cursor: { x: 2000, y: 500 } }, 2],
    // Nothing known, or a window off every screen: the primary.
    [{}, 1],
    [{ window: { x: -5000, y: 0, width: 100, height: 100 } }, 1],
  ] as const)("%j -> screen %i", (at, id) => {
    expect(pickScreen(screens, laptop, at).id).toBe(id);
  });

  it("lands his saved place on whichever screen is active", () => {
    const spot = { fx: 1, fy: 0 };
    const size = { width: 300, height: 40 };
    expect(positionOf(laptop.workArea, size, spot)).toEqual({ x: 980, y: 0 });
    expect(positionOf(monitor.workArea, size, spot)).toEqual({ x: 2900, y: 0 });
  });

  it("keeps one place for every screen, taking an older per-screen one", () => {
    expect(sharedSpot({ any: { fx: 0.2, fy: 0.3 }, "7": { fx: 1, fy: 1 } })).toEqual({
      fx: 0.2,
      fy: 0.3,
    });
    expect(sharedSpot({ "7": { fx: 1, fy: 1 } })).toEqual({ fx: 1, fy: 1 });
    expect(sharedSpot({})).toBeUndefined();
  });
});

describe("the grown window and the cleanup's hold", () => {
  const base = { x: 750, y: 900, width: 420, height: 80 };
  it("grows upward from his spot, or downward when there is no room above, and the base never moves", () => {
    const up = grownBounds(base, 320, hd);
    expect(up).toEqual({ bounds: { x: 750, y: 660, width: 420, height: 320 }, down: false });
    expect(baseOf(up.bounds, 80, up.down)).toEqual(base);
    const top = { ...base, y: 10 };
    const down = grownBounds(top, 320, hd);
    expect(down).toEqual({ bounds: { x: 750, y: 10, width: 420, height: 320 }, down: true });
    expect(baseOf(down.bounds, 80, down.down)).toEqual(top);
    // A short screen: as tall as it has room for, never shorter than the pill.
    expect(grownBounds(top, 320, { ...hd, height: 200 }).bounds.height).toBe(190);
    expect(grownBounds(base, 80, hd)).toEqual({ bounds: base, down: false });
  });
  it("frosts the capsule inside the grown window, inset so the system corners stay hidden", () => {
    const grown = grownBounds({ x: 750, y: 960, width: 420, height: 80 }, 320, hd).bounds;
    expect(frostBounds(grown, { x: 98.4, y: 220.6, width: 224, height: 72 })).toEqual({
      x: 851,
      y: 944,
      width: 218,
      height: 66,
    });
    // Grown downward the capsule hangs from the top; the frost follows it, not the window.
    const down = grownBounds({ x: 750, y: 10, width: 420, height: 80 }, 320, hd).bounds;
    expect(frostBounds(down, { x: 148, y: 18, width: 124, height: 34 })?.y).toBe(31);
    expect(frostBounds(grown, { x: 190, y: 250, width: 36, height: 6 })).toBeNull();
  });
  it("defers a lower to the end of the cleanup, and drops it when the pill is raised again", () => {
    let now = 0;
    const timers: Array<{ at: number; run: () => void; on: boolean }> = [];
    let lowered = 0;
    const hold = createLowerHold({
      now: () => now,
      after: (ms, run) => {
        const t = { at: now + ms, run, on: true };
        timers.push(t);
        return () => (t.on = false);
      },
      lower: () => (lowered += 1),
    });
    const tick = (to: number) => {
      now = to;
      for (const t of timers.filter((t) => t.on && t.at <= to)) {
        t.on = false;
        t.run();
      }
    };
    expect(hold.defer()).toBe(false);
    hold.holdUntil(3000);
    expect(hold.defer()).toBe(true);
    tick(2999);
    expect(lowered).toBe(0);
    tick(3000);
    expect(lowered).toBe(1);
    hold.holdUntil(6000);
    hold.defer();
    hold.raised();
    tick(7000);
    expect(lowered).toBe(1);
    // A shorter hold from the page takes over the provisional one.
    hold.holdUntil(9000);
    hold.defer();
    hold.holdUntil(7500);
    tick(7500);
    expect(lowered).toBe(2);
  });
});
