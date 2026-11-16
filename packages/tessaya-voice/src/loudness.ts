/**
 * Loudness as ITU-R BS.1770 measures it (K-weighted, gated), so each voice can be brought to one level: Pocket's
 * voices differ by several dB, and on a small speaker across a room the quieter one is not heard (13 Nov: Alfred).
 */

/** Two biquads as pyloudnorm designs them for any rate: the head's high shelf, then the high pass. */
const kWeighting = (rate: number) => {
  const shelf = (() => {
    const a = 10 ** (4 / 40);
    const w = (2 * Math.PI * 1_500) / rate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const c = Math.cos(w);
    const s = 2 * Math.sqrt(a) * alpha;
    const a0 = a + 1 - (a - 1) * c + s;
    return {
      b: [
        a * (a + 1 + (a - 1) * c + s),
        -2 * a * (a - 1 + (a + 1) * c),
        a * (a + 1 + (a - 1) * c - s),
      ],
      a: [a0, 2 * (a - 1 - (a + 1) * c), a + 1 - (a - 1) * c - s],
    };
  })();
  const highPass = (() => {
    const w = (2 * Math.PI * 38) / rate;
    const alpha = Math.sin(w) / (2 * 0.5);
    const c = Math.cos(w);
    return { b: [(1 + c) / 2, -(1 + c), (1 + c) / 2], a: [1 + alpha, -2 * c, 1 - alpha] };
  })();
  return [shelf, highPass];
};

const filter = (x: Float64Array, f: { b: number[]; a: number[] }): Float64Array => {
  const [b0, b1, b2] = f.b.map((v) => v / f.a[0]!) as [number, number, number];
  const [, a1, a2] = f.a.map((v) => v / f.a[0]!) as [number, number, number];
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < x.length; n += 1) {
    const v = b0 * x[n]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[n]!;
    y2 = y1;
    y1 = v;
    y[n] = v;
  }
  return y;
};

/** Integrated loudness in LUFS (mono), or -Infinity for silence or a clip under 400 ms. */
export const integratedLufs = (pcm: Int16Array, rate: number): number => {
  let x: Float64Array = Float64Array.from(pcm, (v) => v / 32768);
  for (const f of kWeighting(rate)) x = filter(x, f);
  const block = Math.round(0.4 * rate);
  const hop = Math.round(0.1 * rate);
  const powers: number[] = [];
  for (let s = 0; s + block <= x.length; s += hop) {
    let sum = 0;
    for (let i = s; i < s + block; i += 1) sum += x[i]! * x[i]!;
    powers.push(sum / block);
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const gated = (floor: number) => powers.filter((p) => lufs(p) > floor);
  const absolute = gated(-70);
  if (absolute.length === 0) return Number.NEGATIVE_INFINITY;
  const mean = (ps: number[]) => ps.reduce((a, b) => a + b, 0) / ps.length;
  const relative = gated(lufs(mean(absolute)) - 10);
  return lufs(mean(relative.length === 0 ? absolute : relative));
};

/** The gain that brings `measured` to `target` LUFS, never more than `maxGain` (18 dB; Alfred needs 15) and 1 for silence. */
export const loudnessGain = (measured: number, target: number, maxGain = 8): number =>
  Number.isFinite(measured) ? Math.min(maxGain, 10 ** ((target - measured) / 20)) : 1;

const SIDE = 8;
/** Windowed-sinc taps for the points a quarter, half and three quarters past a sample: 4x oversampling, as BS.1770 finds true peaks. */
const BETWEEN = [0.25, 0.5, 0.75].map((f) =>
  Array.from({ length: 2 * SIDE }, (_, k) => {
    const x = k - (SIDE - 1) - f;
    return (Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos((Math.PI * x) / SIDE));
  }),
);

/**
 * `gain`, then a true-peak limiter at `ceilingDb` (−1 dBTP): the loudness boost (15 dB for Alfred) pushed her loudest
 * syllables to full scale (V-008). Instant attack on the peak between this sample and the next, 80 ms release. One per
 * stream, as it keeps its state across chunks; the output runs 8 samples late and the last 8 are dropped.
 */
export const gainLimiter = (gain: number, rate = 16_000, ceilingDb = -1) => {
  const ceiling = 32767 * 10 ** (ceilingDb / 20);
  const release = 1 - Math.exp(-1 / (0.08 * rate));
  const held = new Float64Array(2 * SIDE);
  let level = 1;
  return (pcm: Int16Array): Int16Array =>
    Int16Array.from(pcm, (v) => {
      held.copyWithin(0, 1);
      held[2 * SIDE - 1] = v * gain;
      const now = held[SIDE - 1]!;
      let peak = Math.abs(now);
      for (const taps of BETWEEN) {
        let y = 0;
        for (let k = 0; k < taps.length; k += 1) y += held[k]! * taps[k]!;
        peak = Math.max(peak, Math.abs(y));
      }
      const need = peak > ceiling ? ceiling / peak : 1;
      level = need < level ? need : level + (1 - level) * release;
      return Math.trunc(now * level);
    });
};
