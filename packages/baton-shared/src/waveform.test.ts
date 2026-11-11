import { describe, expect, it } from "vite-plus/test";

import { waveEngine, type WaveCanvas } from "./waveform.ts";

const W = waveEngine();
const FRAME = 1 / 60;

/** Feeds `db` for `seconds` at 60 fps; returns the envelope after each frame. */
const feed = (level: ReturnType<typeof W.createLevel>, db: number, seconds: number) => {
  const out: number[] = [];
  for (let t = 0; t < seconds; t += FRAME) out.push(level.tick(db, FRAME));
  return out;
};

/** A canvas that records what was drawn. */
const recorder = () => {
  const calls: Array<{ op: string; args: number[]; fill: unknown }> = [];
  const g: WaveCanvas = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    beginPath: () => undefined,
    arc: (...args) => void calls.push({ op: "arc", args, fill: g.fillStyle }),
    ellipse: (...args) => void calls.push({ op: "ellipse", args, fill: g.fillStyle }),
    roundRect: (...args) => void calls.push({ op: "roundRect", args, fill: g.fillStyle }),
    fill: () => undefined,
    fillRect: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  };
  return { g, calls };
};
const COLOURS = {
  c1: [95, 179, 179],
  c2: [200, 120, 120],
  c3: [224, 112, 122],
  dark: true,
} as const;

describe("the waveform's level", () => {
  it("stays flat in a quiet room, and room noise creeping up never reads as speech", () => {
    const level = W.createLevel();
    expect(Math.max(...feed(level, -70, 3))).toBeLessThan(0.01);
    for (let db = -60; db < -50; db += 0.5 * FRAME * 2) level.tick(db, FRAME * 2);
    expect(level.state().env).toBeLessThan(0.02);
  });

  it("lifts ordinary speech to most of the height, never past 78%", () => {
    const level = W.createLevel();
    feed(level, -62, 2);
    const speech = feed(level, -25, 0.4);
    expect(speech.at(-1)).toBeGreaterThan(0.5);
    expect(Math.max(...speech)).toBeLessThanOrEqual(0.78);
  });

  it("rises in about 45 ms and falls in about 220 ms", () => {
    const level = W.createLevel();
    feed(level, -62, 2);
    const up = feed(level, -25, 0.6);
    const top = up.at(-1)!;
    const rise = up.findIndex((e) => e >= top / 2) * FRAME;
    const down = feed(level, -62, 1);
    const fall = down.findIndex((e) => e <= top / 2) * FRAME;
    expect(rise).toBeLessThan(0.08);
    expect(fall).toBeGreaterThan(0.1);
    expect(fall).toBeLessThan(0.3);
  });

  it("reads its history at fractional ages between samples, newest first, and the same input draws the same", () => {
    const a = W.createLevel();
    const b = W.createLevel();
    for (const level of [a, b]) {
      feed(level, -62, 1);
      feed(level, -25, 0.3);
      feed(level, -62, 0.3);
    }
    expect(a.at(0)).toBe(a.state().env);
    for (const age of [0.4, 1.5, 3.25, 9]) {
      const lo = Math.min(a.at(Math.floor(age)), a.at(Math.ceil(age)));
      const hi = Math.max(a.at(Math.floor(age)), a.at(Math.ceil(age)));
      expect(a.at(age)).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(a.at(age)).toBeLessThanOrEqual(hi + 1e-6);
      expect(b.at(age)).toBe(a.at(age));
    }
    // Falling now: the older the sample, the louder it was.
    expect(a.at(6)).toBeGreaterThan(a.at(1));
  });

  it("measures a frame's RMS in dBFS", () => {
    expect(
      W.frameDb(Int16Array.from({ length: 320 }, (_, i) => (i % 2 ? 32767 : -32767))),
    ).toBeCloseTo(0, 1);
    expect(W.frameDb(new Int16Array(320))).toBe(-100);
    expect(W.dbOf(0.1)).toBeCloseTo(-20, 5);
  });
});

describe("the waveform's renderers", () => {
  it("Bars: thin mirrored bars, a row of dots in silence, the centre tallest when he speaks", () => {
    const silent = recorder();
    W.bars(silent.g, 60, 16, () => 0, "dict", COLOURS);
    expect(silent.calls).toHaveLength(13);
    expect(silent.calls.every((c) => c.args[3] === 2)).toBe(true);
    const loud = recorder();
    W.bars(loud.g, 60, 16, () => 0.78, "dict", COLOURS);
    const heights = loud.calls.map((c) => c.args[3]!);
    expect(heights[6]).toBeCloseTo(0.78 * 16, 5);
    expect(heights[0]).toBeLessThan(heights[6]!);
    expect(heights[0]).toBe(heights[12]);
  });

  it("Beads: five to nine beads, the newest on the right", () => {
    const count = (w: number) => {
      const r = recorder();
      W.beads(r.g, w, 22, () => 0, "dict", COLOURS);
      return r.calls.filter((c) => c.op === "arc").length;
    };
    expect([count(30), count(64), count(200)]).toEqual([5, 6, 9]);
    const r = recorder();
    W.beads(r.g, 64, 22, (age) => (age === 0 ? 0.78 : 0), "dict", COLOURS);
    const ys = r.calls.filter((c) => c.op === "arc").map((c) => c.args[1]!);
    expect(Math.min(...ys)).toBe(ys.at(-1));
  });

  it("Mound: lit to its 12% floor in silence, higher in the middle when he speaks, the same every time", () => {
    const draw = (L: (age: number) => number) => {
      const r = recorder();
      W.mound(r.g, 64, 20, L, "dict", COLOURS, 1000);
      return r.calls;
    };
    const quiet = draw(() => 0);
    expect(Math.min(...quiet.map((c) => c.args[1]!))).toBeGreaterThan(20 - 1.5 - 3.4 * 2);
    const loud = draw(() => 0.7);
    const top = (calls: typeof loud, x: number) =>
      Math.min(...calls.filter((c) => Math.abs(c.args[0]! - x) < 1).map((c) => c.args[1]!));
    expect(top(loud, 32)).toBeLessThan(top(loud, 3));
    expect(draw(() => 0.7)).toEqual(loud);
  });
});
