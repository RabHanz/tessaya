/**
 * The pill's bars by band: a 256-point FFT of each 20 ms microphone frame, folded into log-spaced
 * bands across the voice range, so each bar moves with its own part of his voice instead of all
 * of them with one level. Display only, and run only while the pill shows a live waveform.
 */
export const PILL_BANDS = 12;
const FFT_SIZE = 256;
const LOW_HZ = 120;
const HIGH_HZ = 5000;
/** A band's own peak falls by this per frame (half-life about 2.8 s at 50 frames a second). */
const PEAK_FALL = 0.995;
/** Below this a band is not adapted up to full height: a silent band stays short. */
const MIN_PEAK = 0.002;
/** Every bar keeps this share of the overall level, so a quiet band still shows he is talking. */
const BASE = 0.15;

const HANN = Float32Array.from(
  { length: FFT_SIZE },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
);
const COS = Float32Array.from({ length: FFT_SIZE / 2 }, (_, i) =>
  Math.cos((2 * Math.PI * i) / FFT_SIZE),
);
const SIN = Float32Array.from({ length: FFT_SIZE / 2 }, (_, i) =>
  Math.sin((2 * Math.PI * i) / FFT_SIZE),
);
const BITS = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let r = 0;
  for (let b = 1, v = i; b < FFT_SIZE; b <<= 1, v >>= 1) r = (r << 1) | (v & 1);
  return r;
});

/** Bin edges per band at a sample rate: log-spaced, at least one bin wide. */
const edgesFor = (rate: number, count: number): Uint16Array => {
  const hz = rate / FFT_SIZE;
  const edges = new Uint16Array(count + 1);
  for (let b = 0; b <= count; b += 1) {
    const f = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (b / count);
    edges[b] = Math.min(
      FFT_SIZE / 2,
      Math.max(b === 0 ? 1 : edges[b - 1]! + 1, Math.round(f / hz)),
    );
  }
  return edges;
};

const re = new Float32Array(FFT_SIZE);
const im = new Float32Array(FFT_SIZE);
const edgeCache = new Map<string, Uint16Array>();

/** RMS magnitude (0..1 of full scale) per band of the frame's last 256 samples. */
export const frameBands = (frame: Int16Array, rate = 16000, count = PILL_BANDS): Float32Array => {
  const key = `${rate}:${count}`;
  let edges = edgeCache.get(key);
  if (edges === undefined) edgeCache.set(key, (edges = edgesFor(rate, count)));
  const start = Math.max(0, frame.length - FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const j = BITS[i]!;
    re[j] = ((frame[start + i] ?? 0) / 32768) * HANN[i]!;
    im[j] = 0;
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let i = 0; i < FFT_SIZE; i += size) {
      for (let k = 0; k < half; k += 1) {
        const c = COS[k * step]!;
        const s = SIN[k * step]!;
        const a = i + k;
        const b = a + half;
        const tr = re[b]! * c + im[b]! * s;
        const ti = im[b]! * c - re[b]! * s;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  const out = new Float32Array(count);
  for (let band = 0; band < count; band += 1) {
    let power = 0;
    for (let k = edges[band]!; k < edges[band + 1]!; k += 1) power += re[k]! ** 2 + im[k]! ** 2;
    // Hann's coherent gain is 0.5, so a full-scale sine in one bin reads about 1.
    out[band] = Math.sqrt(power / (edges[band + 1]! - edges[band]!)) / (FFT_SIZE / 4);
  }
  return out;
};

/**
 * Per-band AGC under the overall one: each band over its own slowly falling peak, so his high
 * bands move as much as his low ones, all scaled by `gate`, the noise-gated level from
 * `createSpeechGain`. A gated frame (the room, a pause) is 0 everywhere and does not adapt the peaks.
 */
export const createBandGain = (count = PILL_BANDS) => {
  const peaks = new Float32Array(count).fill(MIN_PEAK);
  return (bands: Float32Array, gate: number): Float32Array => {
    const out = new Float32Array(count);
    if (gate <= 0) return out;
    for (let i = 0; i < count; i += 1) {
      const value = bands[i] ?? 0;
      peaks[i] = Math.max(value, peaks[i]! * PEAK_FALL, MIN_PEAK);
      out[i] = Math.min(1, gate * (BASE + (1 - BASE) * (value / peaks[i]!)));
    }
    return out;
  };
};
