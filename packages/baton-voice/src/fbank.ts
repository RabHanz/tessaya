/**
 * The speaker model's front end (VOICE-ID): Kaldi's 80-bin log mel filterbank at 16 kHz (25 ms frames every
 * 10 ms, Povey window, pre-emphasis 0.97, DC removed, no dither), then each bin's mean over the clip taken off.
 * CAM++ and WeSpeaker were trained on exactly this; without the mean subtraction other voices score as him.
 *
 * @module baton-voice/fbank
 */
const RATE = 16_000;
const FRAME = 400;
const SHIFT = 160;
const FFT = 512;
const BINS = 80;
const LOW_HZ = 20;
const HIGH_HZ = RATE / 2;
const PREEMPH = 0.97;
const FLT_EPSILON = 1.1920928955078125e-7;

const mel = (hz: number) => 1127 * Math.log(1 + hz / 700);

const povey = Float64Array.from(
  { length: FRAME },
  (_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))) ** 0.85,
);

/** Each mel bin's weights over the FFT bins 0..FFT/2-1, as Kaldi's MelBanks builds them. */
const banks = (() => {
  const lo = mel(LOW_HZ);
  const delta = (mel(HIGH_HZ) - lo) / (BINS + 1);
  return Array.from({ length: BINS }, (_, m) => {
    const left = lo + m * delta;
    const centre = left + delta;
    const right = centre + delta;
    const weights = new Float64Array(FFT / 2);
    for (let k = 0; k < FFT / 2; k += 1) {
      const at = mel((k * RATE) / FFT);
      if (at > left && at < right)
        weights[k] = at <= centre ? (at - left) / (centre - left) : (right - at) / (right - centre);
    }
    return weights;
  });
})();

/** In-place radix-2 FFT of a real frame; returns the power spectrum for bins 0..n/2-1. */
const powerSpectrum = (frame: Float64Array): Float64Array => {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k += 1) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  const out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k += 1) out[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return out;
};

/** 16 kHz PCM (int16 scale) to frames × 80 log mel energies, mean-subtracted per bin. Empty under one frame. */
export const fbank = (
  pcm: Int16Array,
): { readonly frames: number; readonly data: Float32Array } => {
  const frames = pcm.length < FRAME ? 0 : 1 + Math.floor((pcm.length - FRAME) / SHIFT);
  const data = new Float32Array(frames * BINS);
  const frame = new Float64Array(FFT);
  for (let f = 0; f < frames; f += 1) {
    frame.fill(0);
    let mean = 0;
    for (let i = 0; i < FRAME; i += 1) mean += pcm[f * SHIFT + i]!;
    mean /= FRAME;
    for (let i = 0; i < FRAME; i += 1) frame[i] = pcm[f * SHIFT + i]! - mean;
    for (let i = FRAME - 1; i > 0; i -= 1) frame[i] = frame[i]! - PREEMPH * frame[i - 1]!;
    frame[0] = frame[0]! - PREEMPH * frame[0]!;
    for (let i = 0; i < FRAME; i += 1) frame[i] = frame[i]! * povey[i]!;
    const power = powerSpectrum(frame);
    for (let m = 0; m < BINS; m += 1) {
      const w = banks[m]!;
      let e = 0;
      for (let k = 0; k < FFT / 2; k += 1) e += w[k]! * power[k]!;
      data[f * BINS + m] = Math.log(Math.max(e, FLT_EPSILON));
    }
  }
  for (let m = 0; m < BINS; m += 1) {
    let sum = 0;
    for (let f = 0; f < frames; f += 1) sum += data[f * BINS + m]!;
    const mean = frames === 0 ? 0 : sum / frames;
    for (let f = 0; f < frames; f += 1) data[f * BINS + m] = data[f * BINS + m]! - mean;
  }
  return { frames, data };
};
