import { describe, expect, it } from "vite-plus/test";

import {
  clampSpot,
  fingerSkin,
  pinchScale,
  PX_PER_CM,
  readStageAsk,
  STAGE_SCALE,
  stageCard,
  timerLeft,
  wanderSpot,
} from "./sleeveEstate.ts";

const box = { w: 390, h: 844, bottom: 120 };

describe("her estate on a Sleeve", () => {
  it("keeps all of her on screen and above the app's panel, wherever she is sent", () => {
    expect(clampSpot({ x: -50, y: 2000, scale: 1 }, 200, box)).toEqual({
      x: 100,
      y: 624,
      scale: 1,
    });
    expect(clampSpot({ x: 195, y: 300, scale: 1 }, 200, box)).toEqual({ x: 195, y: 300, scale: 1 });
    // on its side, her words take the right of the screen: she keeps to the left of them
    const dock = { w: 844, h: 390, bottom: 0, right: 350 };
    expect(clampSpot({ x: 800, y: 200, scale: 1 }, 200, dock)).toEqual({
      x: 394,
      y: 200,
      scale: 1,
    });
  });

  it("grows and shrinks only within her bounds, and centres her when she is wider than the screen", () => {
    expect(clampSpot({ x: 0, y: 0, scale: 9 }, 200, box).scale).toBe(STAGE_SCALE.max);
    expect(clampSpot({ x: 0, y: 0, scale: 0 }, 200, box).scale).toBe(STAGE_SCALE.min);
    expect(clampSpot({ x: 0, y: 300, scale: 1.7 }, 300, box).x).toBe(195);
  });

  it("follows a pinch by the change in finger distance", () => {
    expect(pinchScale(1, 100, 150)).toBe(1.5);
    expect(pinchScale(1, 100, 10)).toBe(STAGE_SCALE.min);
    expect(pinchScale(1.2, 0, 50)).toBe(1.2);
  });

  it("strolls a short way and never off her screen", () => {
    const from = { x: 195, y: 300, scale: 1 };
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const to = wanderSpot(from, 200, box, () => r);
      expect(to.x).toBeGreaterThanOrEqual(100);
      expect(to.x).toBeLessThanOrEqual(290);
      expect(to.y).toBeLessThanOrEqual(624);
    }
  });

  it("reads his finger's contact and force only where the screen measures them", () => {
    // a broad press: a 2 cm by 1.5 cm ellipse
    expect(fingerSkin(2 * PX_PER_CM, 1.5 * PX_PER_CM, 0.8)).toEqual({
      areaCm2: 2.36,
      pressure: 0.8,
    });
    // no contact size and the browser's stand-in force: a fingertip, force unknown
    expect(fingerSkin(1, 1, 0.5)).toEqual({ areaCm2: 1.2, pressure: null });
    expect(fingerSkin(0, 0, 0)).toEqual({ areaCm2: 1.2, pressure: null });
  });
});

describe("what she calls up on her estate", () => {
  const here = {
    now: 1_000_000,
    dayEnd: 5_000_000,
    day: "Saturday",
    clock: (at: number) => `t${at}`,
  };
  const feed = {
    timers: [
      { title: "Pasta timer", endsAt: 1_300_000 },
      { title: "Tea timer", endsAt: 1_100_000 },
      { title: "Old timer", endsAt: 900_000 },
    ],
    upcoming: [
      { title: "Dentist", at: 2_000_000 },
      { title: "Tomorrow's call", at: 6_000_000 },
      { title: "Gone", at: 500_000 },
    ],
  };
  const card = (value: string, f = feed) => {
    const ask = readStageAsk(value);
    if (ask === null || ask.kind === "clear") return ask;
    return stageCard({ ...ask, kind: ask.kind }, f, here);
  };

  it("reads her brain's ask, and refuses one she cannot show", () => {
    expect(readStageAsk(" Note : buy milk")).toEqual({ kind: "note", text: "buy milk" });
    expect(readStageAsk("put away")).toEqual({ kind: "clear", text: "" });
    expect(readStageAsk("photo")).toBeNull();
  });

  it("holds his soonest running timer, or the one he named, counting down from Coming up", () => {
    expect(card("timer")).toMatchObject({
      title: "Tea timer",
      endsAt: 1_100_000,
      prop: "stopwatch",
    });
    expect(card("timer: pasta")).toMatchObject({ title: "Pasta timer", endsAt: 1_300_000 });
    expect(card("timer", { ...feed, timers: [] })).toBe("No timer is running: set one first.");
  });

  it("shows the rest of today only, on her clipboard", () => {
    expect(card("today")).toMatchObject({
      title: "Saturday",
      lines: ["t2000000  Dentist"],
      prop: "clipboard",
    });
  });

  it("takes what her tools read for the rest, with the prop that means it", () => {
    expect(card("weather: Light rain, 12°")).toMatchObject({
      prop: "umbrella",
      gesture: "pointAt",
    });
    expect(card("weather: Sunny spells")).toMatchObject({ prop: "sunglasses" });
    expect(card("weather: Overcast")).toMatchObject({ prop: null, lines: ["Overcast"] });
    expect(card("music: Clair de lune")).toMatchObject({ prop: "headphones" });
    expect(card("note")).toBe("Say what the note is.");
  });

  it("reads a timer's time left", () => {
    expect(timerLeft(65_400, 0)).toBe("1:06");
    expect(timerLeft(3_720_000, 0)).toBe("1:02:00");
    expect(timerLeft(0, 5)).toBe("0:00");
  });
});
