import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../test/render";

interface Rig {
  setExpression: (name: string) => void;
  speak: (plan: object, hooks: { mouth: () => { open: number; shape: string } }) => void;
  motion: (vx: number, vy: number) => void;
  impact: (speed: number, landed?: boolean) => void;
  look: (gx: number | null, gy?: number) => void;
  signature: () => string;
  stats: { frames: number };
  destroy: () => void;
}
type Lch = [number, number, number];
interface Studio {
  util: {
    lch: (hex: string) => Lch;
    hexLch: (L: number, C: number, h: number) => string;
    mixLch: (hex: string, target: Lch, t: number) => string;
  };
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
const mount = (TCS: Studio, persona: string, character?: string, options: object = {}) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(svg);
  const P = TCS.PERSONAS[persona]!;
  const rig = TCS.create(svg, {
    character: character ?? P.character,
    personality: P.traits,
    quiet: true,
    expression: "neutral",
    ...options,
  });
  vi.advanceTimersByTime(3000);
  // What a viewer sees move: the body's lift, the brows' strength, and each eye's outline (its group's first path).
  const sample = () => {
    const w = svg.querySelector("g.w")?.getAttribute("transform") ?? "";
    const eyes = [...svg.querySelectorAll('[data-l="eye-base"]')].flatMap((g) =>
      (g.firstElementChild?.getAttribute("d")?.match(/-?\d+(\.\d+)?/g) ?? []).map(Number),
    );
    const base =
      svg.querySelector('radialGradient[id^="bg"] stop:nth-child(2)')?.getAttribute("stop-color") ??
      "#000000";
    const rim = svg.querySelector("g.bd > path")?.getAttribute("fill") ?? "#000000";
    return {
      // the mood's light on her rim (8-bit, as drawn), her body's own colour, and the mood's halo round her
      colour: [1, 3, 5].map((i) => parseInt(rim.slice(i, i + 2), 16)),
      rim,
      base,
      aura: [...svg.querySelectorAll('[fill^="url(#aw"]')].reduce(
        (a, e) => a + Number(e.getAttribute("opacity")),
        0,
      ),
      // her body's height on screen (her whole figure squashes and stretches)
      height: svg.querySelector("g.bd path")?.getBoundingClientRect().height ?? 0,
      lift: Number(/translate\(0 (-?[\d.]+)\)/.exec(w)?.[1] ?? 0),
      brow: Number(svg.querySelector('[data-l="brow"]')?.getAttribute("opacity") ?? 0),
      eyes,
    };
  };
  return {
    rig,
    svg,
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
      // the motion bar (14 Nov): the mood's colour moves on at least 40 of the 45 steps a 30-a-second film shows in its
      // first 1.5 s, and is halfway there between 0.45 and 0.7 s
      const away = seen.map((s) => Math.hypot(...s.colour.map((c, k) => c - before.colour[k]!)));
      const total = away.at(-1)!;
      expect(total).toBeGreaterThan(20);
      const film = away.filter((_, i) => i % 2 === 0).slice(0, 46);
      // a step shows a change when the mood's colour or the halo moved (the colour alone is 8-bit, so its slow ends round)
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

describe("the companion's mood colour", () => {
  it("mixes perceptually: no grey between two dyes, no invented hue, no clipped hue out of gamut", async () => {
    const { util } = await studio();
    const [weld, indigo] = [util.lch("#F2B33D"), util.lch("#3B5BA5")];
    // a round trip is exact to the 8-bit colour
    for (const hex of ["#f2b33d", "#3b5ba5", "#e8dcc4", "#1f7a82"])
      expect(util.hexLch(...util.lch(hex))).toBe(hex);
    // halfway between opposite dyes keeps their chroma (an RGB mix halves it)
    for (const t of [0.25, 0.5, 0.75])
      expect(util.lch(util.mixLch("#F2B33D", indigo, t))[1]).toBeGreaterThan(
        0.9 * Math.min(weld[1], indigo[1]),
      );
    // a near-neutral takes the dye's own hue, not a leftover one
    const grey = util.lch(util.mixLch("#808080", indigo, 0.3));
    expect(Math.abs(grey[2] - indigo[2])).toBeLessThan(20);
    // more chroma than sRGB holds keeps its hue and gives up chroma
    const out = util.lch(util.hexLch(0.7, 0.4, weld[2]));
    expect(Math.abs(out[2] - weld[2])).toBeLessThan(3);
  });

  it.each([["tessaya"], ["freya"]])(
    "%s keeps her own colour while the mood's light turns happy to sad without going grey",
    async (persona) => {
      const TCS = await studio();
      using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
      using _timers = fakeTimers();
      using m = mount(TCS, persona);
      const own = TCS.util.lch(m.sample().base);
      m.rig.setExpression("happy");
      m.frames(150);
      const happy = TCS.util.lch(m.sample().rim);
      m.rig.setExpression("sad");
      const seen = m
        .frames(130)
        .map((s) => ({ rim: TCS.util.lch(s.rim), base: TCS.util.lch(s.base) }));
      const sad = seen.at(-1)!.rim;
      // the light turns from gold to indigo
      expect(Math.abs(((sad[2] - happy[2] + 540) % 360) - 180)).toBeGreaterThan(120);
      // at full chroma all the way (today's RGB mix fell to a khaki grey halfway)
      expect(Math.min(...seen.map((s) => s.rim[1]))).toBeGreaterThan(
        0.7 * Math.min(happy[1], sad[1]),
      );
      // her body stays herself: never more than a light touch from her own colour
      for (const { base } of seen) expect(Math.abs(base[0] - own[0])).toBeLessThan(0.08);
    },
  );

  it.each([["drop"], ["mark"]])(
    "%s, whose body is the mood's dye, blends from one mood's colour to the next",
    async (character) => {
      const TCS = await studio();
      using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
      using _timers = fakeTimers();
      using m = mount(TCS, "tessaya", character);
      m.rig.setExpression("happy");
      m.frames(150);
      const start = m.sample().base;
      m.rig.setExpression("sad");
      const lab = (hex: string) => {
        const [L, C, h] = TCS.util.lch(hex);
        return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
      };
      const path = [start, ...m.frames(130).map((s) => s.base)].map(lab);
      const steps = path.slice(1).map((p, i) => Math.hypot(...p.map((v, k) => v - path[i]![k]!)));
      const total = steps.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0.15);
      // no switch: no single frame carries more than a tenth of the change
      expect(Math.max(...steps)).toBeLessThan(total * 0.1);
    },
  );
});

describe("the companion's body in a throw", () => {
  it("stretches as she falls, squashes on a hard landing and springs back, never snapping", async () => {
    const TCS = await studio();
    using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    using _timers = fakeTimers();
    using m = mount(TCS, "tessaya");
    const rest = m.sample().height;
    // falling at 1500 px/s, as the desktop reports her flight every frame
    m.rig.motion(0, 1500);
    const falling = m.frames(20).map((s) => s.height);
    m.rig.motion(0, 0);
    m.rig.impact(1800, true);
    const after = m.frames(60).map((s) => s.height);
    expect(Math.max(...falling)).toBeGreaterThan(rest * 1.03);
    // a hard landing squashes her whole figure visibly (at least 5% shorter), volume held
    expect(Math.min(...after.slice(0, 15))).toBeLessThan(rest * 0.95);
    const all = [rest, ...falling, ...after];
    expect(motionOf(all).snaps).toBe(0);
    // the squash and its recovery move on every frame of their first 0.4 s, and she is herself again by 1 s
    expect(after.slice(0, 24).every((h, i) => i === 0 || h !== after[i - 1])).toBe(true);
    expect(Math.abs(after.at(-1)! - rest)).toBeLessThan(rest * 0.02);
  });
});

describe("her character's own act", () => {
  it("is picked by the rig from her own set: Alfred's quirk first, his pocket watch last", async () => {
    const TCS = await studio();
    using _timers = fakeTimers();
    using m = mount(TCS, "alfred");
    {
      using _random = vi.spyOn(Math, "random").mockReturnValue(0);
      expect(m.rig.signature()).toBe("adjustTie");
    }
    using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(m.rig.signature()).toBe("pocketWatch");
  });
});

describe("each character's own body", () => {
  it("squashes as deep as it is soft, springs back without a snap, and is still at rest", async () => {
    const TCS = await studio();
    using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    using _timers = fakeTimers();
    const landing = (character: string) => {
      using m = mount(TCS, "tessaya", character);
      const rest = m.sample().height;
      m.rig.impact(2200, true);
      const after = m.frames(90).map((s) => s.height);
      m.frames(120);
      const still = m.frames(10).map((s) => s.height);
      return {
        depth: Math.min(...after) / rest,
        settled: Math.abs(after.at(-1)! - rest) / rest,
        snaps: motionOf([rest, ...after]).snaps,
        still: new Set(still).size,
      };
    };
    const drop = landing("drop");
    const thimble = landing("thimble");
    // liquid pancakes to about half; silver metal barely gives
    expect(drop.depth).toBeLessThan(0.7);
    expect(thimble.depth).toBeGreaterThan(0.8);
    expect(drop.depth).toBeLessThan(thimble.depth);
    for (const r of [drop, thimble]) {
      expect(r.snaps).toBe(0);
      expect(r.settled).toBeLessThan(0.02);
      expect(r.still).toBe(1);
    }
  });
});

describe("the companion at rest", () => {
  it("sleeps between her idle beats and draws them 30 a second, while his touch still runs at full rate", async () => {
    const TCS = await studio();
    using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    using _timers = fakeTimers();
    // as the desktop mascot makes her: idle life on, beats capped (mascotPage.ts)
    using m = mount(TCS, "tessaya", undefined, { quiet: false, beatFps: 30 });
    // a minute at rest, a second at a time: blinks every ~5 s and an idle act every ~22 s
    const perSecond = Array.from({ length: 60 }, () => {
      const before = m.rig.stats.frames;
      vi.advanceTimersByTime(1000);
      return m.rig.stats.frames - before;
    });
    // she has her idle life, never above 30 a second, and her loop stops between beats
    expect(perSecond.filter((n) => n > 20).length).toBeGreaterThan(0);
    expect(Math.max(...perSecond)).toBeLessThanOrEqual(31);
    expect(perSecond.filter((n) => n === 0).length).toBeGreaterThan(30);
    // whatever he does to her is drawn at the display's rate
    const before = m.rig.stats.frames;
    m.rig.look(0.8, 0);
    vi.advanceTimersByTime(500);
    expect(m.rig.stats.frames - before).toBeGreaterThan(25);
  });
});

describe("her mood at rest", () => {
  // every mood the spine gives her at rest (tessaya-shared affect.ts affectView): a sway fades, her mood's own acts are
  // beats at her idle cadence, and between them she draws nothing (release smoke, MA-017)
  it.each([
    "sleepy",
    "sulky",
    "lonely",
    "proud",
    "happy",
    "curious",
    "frustrated",
    "sad",
    "focused",
  ])("%s: never above 30 a second, still most of a minute", async (mood) => {
    const TCS = await studio();
    using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    using _timers = fakeTimers();
    using m = mount(TCS, "tessaya", undefined, { quiet: false, beatFps: 30, idleEvery: 2 });
    m.rig.setExpression(mood);
    vi.advanceTimersByTime(12_000);
    const perSecond = Array.from({ length: 60 }, () => {
      const before = m.rig.stats.frames;
      vi.advanceTimersByTime(1000);
      return m.rig.stats.frames - before;
    });
    expect(Math.max(...perSecond)).toBeLessThanOrEqual(31);
    expect(perSecond.filter((n) => n === 0).length).toBeGreaterThan(40);
  });
});

describe("her mouth on a hum", () => {
  it.each(["surprised", "sleepy", "thinking"])(
    "from %s, her lips are shut from the hum's first frame, and from the next sentence's first frame",
    async (face) => {
      const TCS = await studio();
      using _random = vi.spyOn(Math, "random").mockReturnValue(0.999);
      using _timers = fakeTimers();
      using m = mount(TCS, "tessaya");
      m.rig.setExpression(face);
      vi.advanceTimersByTime(3000);
      const open = () => m.svg.querySelector('[data-l="mouth-open"]') !== null;
      // a loud "Mmm": the jaw would open with the sound, the lips stay pressed
      const hum = { mouth: () => ({ open: 0.8, shape: "mbp" }) };
      const plan = { words: [], syl: [], events: [], vis: [], end: 1e9 };
      m.rig.speak(plan, hum);
      const first = Array.from({ length: 10 }, () => (vi.advanceTimersByTime(1000 / 60), open()));
      // the line's next sentence opens with a hum too ("Mmm. Mm hm.")
      m.rig.speak(plan, hum);
      const next = Array.from({ length: 10 }, () => (vi.advanceTimersByTime(1000 / 60), open()));
      expect(first).toEqual(Array(10).fill(false));
      expect(next).toEqual(Array(10).fill(false));
    },
  );
});
