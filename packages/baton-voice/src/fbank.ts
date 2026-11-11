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
const hamming = Float64Array.from(
  { length: FRAME },
  (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)),
);

/** Each mel bin's weights over the FFT bins it covers, as Kaldi's MelBanks builds them. */
const banks = (() => {
  const lo = mel(LOW_HZ);
  const delta = (mel(HIGH_HZ) - lo) / (BINS + 1);
  return Array.from({ length: BINS }, (_, m) => {
    const left = lo + m * delta;
    const centre = left + delta;
    const right = centre + delta;
    let first = -1;
    const weights: number[] = [];
    for (let k = 0; k < FFT / 2; k += 1) {
      const at = mel((k * RATE) / FFT);
      if (at > left && at < right) {
        if (first < 0) first = k;
        weights.push(
          at <= centre ? (at - left) / (centre - left) : (right - at) / (right - centre),
        );
      }
    }
    return { first, weights: Float64Array.from(weights) };
  });
})();

// The FFT's bit-reversal order and twiddle factors, worked out once.
const REVERSED = (() => {
  const out = new Uint16Array(FFT);
  for (let i = 1, j = 0; i < FFT; i += 1) {
    let bit = FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    out[i] = j;
  }
  return out;
})();
const COS = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / FFT));
const SIN = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / FFT));
const re = new Float64Array(FFT);
const im = new Float64Array(FFT);
const power = new Float64Array(FFT / 2);

/** Radix-2 FFT of a real frame into `power`, bins 0..FFT/2-1. */
const powerSpectrum = (frame: Float64Array): void => {
  for (let i = 0; i < FFT; i += 1) {
    re[REVERSED[i]!] = frame[i]!;
    im[i] = 0;
  }
  for (let size = 2; size <= FFT; size <<= 1) {
    const half = size >> 1;
    const stride = FFT / size;
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = COS[k * stride]!;
        const wi = SIN[k * stride]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  for (let k = 0; k < FFT / 2; k += 1) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
};

/**
 * 16 kHz PCM (int16 scale) to frames × 80 log mel energies, mean-subtracted per bin. Empty under one frame.
 * SenseVoice was trained on the same bank with a Hamming window and no mean subtraction (sherpa-onnx's front end).
 */
export const fbank = (
  pcm: Int16Array,
  options: { readonly window?: "povey" | "hamming"; readonly subtractMean?: boolean } = {},
): { readonly frames: number; readonly data: Float32Array } => {
  const taper = options.window === "hamming" ? hamming : povey;
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
    for (let i = 0; i < FRAME; i += 1) frame[i] = frame[i]! * taper[i]!;
    powerSpectrum(frame);
    for (let m = 0; m < BINS; m += 1) {
      const { first, weights } = banks[m]!;
      let e = 0;
      for (let k = 0; k < weights.length; k += 1) e += weights[k]! * power[first + k]!;
      data[f * BINS + m] = Math.log(Math.max(e, FLT_EPSILON));
    }
  }
  if (options.subtractMean === false) return { frames, data };
  for (let m = 0; m < BINS; m += 1) {
    let sum = 0;
    for (let f = 0; f < frames; f += 1) sum += data[f * BINS + m]!;
    const mean = frames === 0 ? 0 : sum / frames;
    for (let f = 0; f < frames; f += 1) data[f * BINS + m] = data[f * BINS + m]! - mean;
  }
  return { frames, data };
};
