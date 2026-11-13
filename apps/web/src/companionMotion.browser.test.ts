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
    return {
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
      // the change itself (1.15 s): after it a sustained mood loop (a laugh, a sway) keeps its 30-a-second ceiling
      const seen = [before, ...m.frames(69)];
      // the body moves on an arc (anticipation, the move, a settle): it travels, and never jumps
      const lifts = seen.map((s) => s.lift - before.lift);
      const lift = motionOf(lifts);
      expect(lift.range).toBeGreaterThan(1);
      expect(lift.snaps).toBe(0);
      // anticipation: before the main move, the body first goes a little the other way
      const peak = lifts.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
      const lead = lifts.slice(0, lifts.indexOf(peak));
      expect(Math.max(0, ...lead.map((v) => -Math.sign(peak) * v))).toBeGreaterThan(0.4);
      // a change is a move of about a second, slow in and slow out (the motion bar): the face is not yet halfway at
      // 0.25 s, and still moving at 0.6 s
      // each eye's shape around its own centre, so the body's posture and squash do not count as the face changing
      const shape = (nums: ReadonlyArray<number>) => {
        const eye = (side: number) =>
          nums.slice(side * (nums.length / 2), (side + 1) * (nums.length / 2));
        return [0, 1].flatMap((side) => {
          const e = eye(side),
            xs = e.filter((_, k) => k % 2 === 0),
            ys = e.filter((_, k) => k % 2 === 1);
          const cx = xs.reduce((a, b) => a + b, 0) / xs.length,
            cy = ys.reduce((a, b) => a + b, 0) / ys.length;
          return e.map((v, k) => v - (k % 2 === 0 ? cx : cy));
        });
      };
      const start = shape(before.eyes);
      const faceAt = (i: number) =>
        shape(seen[i]!.eyes).reduce((a, v, k) => a + Math.abs(v - start[k]!), 0);
      const total = faceAt(69);
      expect(faceAt(15)).toBeLessThan(total * 0.5);
      expect(Math.abs(faceAt(36) - faceAt(33))).toBeGreaterThan(0);
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
