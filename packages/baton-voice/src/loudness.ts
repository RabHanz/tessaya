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

/** `pcm` times `gain`, with peaks above 85% of full scale bent softly under it rather than clipped. */
export const withGain = (pcm: Int16Array, gain: number): Int16Array => {
  if (gain === 1) return pcm;
  const knee = 0.85 * 32767;
  const room = 32767 - knee;
  return Int16Array.from(pcm, (v) => {
    const y = v * gain;
    const m = Math.abs(y);
    return Math.round(m <= knee ? y : Math.sign(y) * (knee + room * Math.tanh((m - knee) / room)));
  });
};
