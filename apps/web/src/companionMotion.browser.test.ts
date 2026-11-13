import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../test/render";

interface Rig {
  setExpression: (name: string) => void;
  destroy: () => void;
}
interface Studio {
  PERSONAS: Record<string, { character: string; traits: object }>;
  create: (svg: SVGElement, opts: object) => Rig;
}

/** The shipped companion scripts (public/companion), loaded once as the stage page loads them. */
const studio = async (): Promise<Studio> => {
  const g = window as unknown as { TCS?: Studio };
  if (g.TCS === undefined)
    for (const file of ["rig.js", "bodies.js", "props.js", "speech.js"])
      new Function(await (await fetch(`/companion/${file}`)).text())();
  return g.TCS!;
};

/** One persona's rig on a real SVG, stepped 60 times a second on the test's fake clock. */
const mount = (TCS: Studio, persona: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(svg);
  const P = TCS.PERSONAS[persona]!;
  const rig = TCS.create(svg, {
    character: P.character,
    personality: P.traits,
    quiet: true,
    expression: "neutral",
  });
  vi.advanceTimersByTime(3000);
  // What a viewer sees move: the body's lift, the brows' strength, and each eye's outline (its group's first path).
  const sample = () => {
    const w = svg.querySelector("g.w")?.getAttribute("transform") ?? "";
    const eyes = [...svg.querySelectorAll('[data-l="eye-base"]')].flatMap((g) =>
      (g.firstElementChild?.getAttribute("d")?.match(/-?\d+(\.\d+)?/g) ?? []).map(Number),
    );
    const tone =
      svg.querySelector('radialGradient[id^="bg"] stop:nth-child(2)')?.getAttribute("stop-color") ??
      "#000000";
    return {
      // the body's colour (8-bit, as drawn) and the mood aura's strength around her
      colour: [1, 3, 5].map((i) => parseInt(tone.slice(i, i + 2), 16)),
      aura: [...svg.querySelectorAll('[fill^="url(#aw"],[fill^="url(#ac"]')].reduce(
        (a, e) => a + Number(e.getAttribute("opacity")),
        0,
      ),
      lift: Number(/translate\(0 (-?[\d.]+)\)/.exec(w)?.[1] ?? 0),
      brow: Number(svg.querySelector('[data-l="brow"]')?.getAttribute("opacity") ?? 0),
      eyes,
    };
  };
  return {
    rig,
    sample,
    frames: (n: number) =>
      Array.from({ length: n }, () => (vi.advanceTimersByTime(1000 / 60), sample())),
    [Symbol.dispose]: () => {
      rig.destroy();
      svg.remove();
    },
  };
};

/**
 * How a value moves frame to frame. A snap is one step far larger than the frames either side of it (a cut, a swap, a
 * value set outright); a fast but continuous move has neighbours of a similar size. Steps of a pixel or so are motion
 * (the SVG rounds to 0.1 px), so they never count.
 */
const motionOf = (series: ReadonlyArray<number>) => {
  const range = Math.max(...series) - Math.min(...series);
  const steps = series.slice(1).map((v, i) => Math.abs(v - series[i]!));
  const snaps = steps.filter(
    (s, i) => s > 1.5 && s > 2.5 * Math.max(steps[i - 1] ?? 0, steps[i + 1] ?? 0, 0.4),
  ).length;
  return { range, snaps, first: steps[0]! <= 1 ? 0 : steps[0]! / range };
};

describe("the companion's changes of expression", () => {
  it.each([
    ["tessaya", "sad"],
    ["tessaya", "happy"],
    ["tessaya", "delighted"],
    ["alfred", "sad"],
    ["alfred", "laughing"],
  ])(
    "%s → %s is a continuous, choreographed move: no snap, a gentle start",
    async (persona, expression) => {
      const TCS = await studio();
      // Blinks come at a random 0.55 to 1.45 of a 3 to 5.5 s gap: held at the long end, none lands in the window
      // measured (3 to 3.6 s after she appears), so only the change of expression moves her face.
      using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
      using _timers = fakeTimers();
      using m = mount(TCS, persona);
      const before = m.sample();
      m.rig.setExpression(expression);
      // two seconds at 60 a second: the whole change, colour included
      const seen = [before, ...m.frames(120)];
      // the motion bar (14 Nov): the body's colour moves on at least 40 of the 45 steps a 30-a-second film shows in its
      // first 1.5 s, and is halfway there between 0.45 and 0.7 s
      const away = seen.map((s) => Math.hypot(...s.colour.map((c, k) => c - before.colour[k]!)));
      const total = away.at(-1)!;
      expect(total).toBeGreaterThan(20);
      const film = away.filter((_, i) => i % 2 === 0).slice(0, 46);
      // a step shows a change when the body's colour or the aura moved (the colour alone is 8-bit, so its slow ends round)
      const auras = seen
        .map((s) => s.aura)
        .filter((_, i) => i % 2 === 0)
        .slice(0, 46);
      expect(
        film.slice(1).filter((v, i) => v !== film[i] || auras[i + 1] !== auras[i]).length,
      ).toBeGreaterThanOrEqual(40);
      const half = away.findIndex((v) => v >= total / 2) / 60;
      expect(half).toBeGreaterThanOrEqual(0.45);
      expect(half).toBeLessThanOrEqual(0.7);
      // the pose moves softly: no frame jumps
      expect(motionOf(seen.map((s) => s.lift)).snaps).toBe(0);
      // the face arrives spread over the change: not yet halfway at 0.25 s
      const shape = (nums: ReadonlyArray<number>) =>
        [0, 1].flatMap((side) => {
          const e = nums.slice((side * nums.length) / 2, ((side + 1) * nums.length) / 2);
          const mean = (k: number) =>
            e.filter((_, i) => i % 2 === k).reduce((a, b) => a + b, 0) / (e.length / 2);
          return e.map((v, i) => v - mean(i % 2));
        });
      const start = shape(before.eyes);
      const faceAt = (i: number) =>
        shape(seen[i]!.eyes).reduce((a, v, k) => a + Math.abs(v - start[k]!), 0);
      expect(faceAt(15)).toBeLessThan(faceAt(120) * 0.5);
      for (const series of [
        seen.map((s) => s.brow),
        ...before.eyes.map((_, k) => seen.map((s) => s.eyes[k] ?? Number.NaN)),
      ]) {
        // an eye outline that changes its point count mid-change was swapped for another shape
        expect(series.some(Number.isNaN)).toBe(false);
        const { snaps, first } = motionOf(series);
        // the face eases in (its first frame moves little) and never snaps
        expect(first).toBeLessThan(0.1);
        expect(snaps).toBe(0);
      }
    },
  );
});
