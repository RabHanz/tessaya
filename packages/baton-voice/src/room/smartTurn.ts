/**
 * Pipecat Smart Turn v3 (BSD-2, an 8M Whisper-Tiny encoder with a classifier): from the sound alone, has he finished
 * his sentence? Its input is Whisper's log-mel front end over the last 8 s, as `WhisperFeatureExtractor(chunk_length=8)`
 * computes it with `do_normalize=True` and right padding (pipecat-ai/smart-turn inference.py).
 *
 * @module baton-voice/room/smartTurn
 */
import type * as Ort from "onnxruntime-node";

const RATE = 16_000;
const N_FFT = 400;
const HOP = 160;
const MELS = 80;
const SECONDS = 8;
const SAMPLES = SECONDS * RATE;
const FRAMES = SAMPLES / HOP;
const BINS = N_FFT / 2 + 1;

// Slaney's mel scale, as librosa.filters.mel(norm="slaney", htk=False) builds Whisper's bank.
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = 15;
const LOG_STEP = Math.log(6.4) / 27;
const hzToMel = (hz: number) =>
  hz < MIN_LOG_HZ ? (3 * hz) / 200 : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
const melToHz = (mel: number) =>
  mel < MIN_LOG_MEL ? (200 * mel) / 3 : MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL));

const FILTERS = (() => {
  const top = hzToMel(RATE / 2);
  const hz = Array.from({ length: MELS + 2 }, (_, i) => melToHz((top * i) / (MELS + 1)));
  const out = new Float64Array(MELS * BINS);
  for (let m = 0; m < MELS; m += 1) {
    const enorm = 2 / (hz[m + 2]! - hz[m]!);
    for (let k = 0; k < BINS; k += 1) {
      const f = (k * RATE) / N_FFT;
      const lower = (f - hz[m]!) / (hz[m + 1]! - hz[m]!);
      const upper = (hz[m + 2]! - f) / (hz[m + 2]! - hz[m + 1]!);
      out[m * BINS + k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return out;
})();

const HANN = Float64Array.from(
  { length: N_FFT },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT),
);
// The DFT as two [201, 400] tables, so each bin is one straight dot product.
const COS = Float64Array.from({ length: BINS * N_FFT }, (_, j) =>
  Math.cos((2 * Math.PI * ((Math.floor(j / N_FFT) * (j % N_FFT)) % N_FFT)) / N_FFT),
);
const SIN = Float64Array.from({ length: BINS * N_FFT }, (_, j) =>
  Math.sin((2 * Math.PI * ((Math.floor(j / N_FFT) * (j % N_FFT)) % N_FFT)) / N_FFT),
);

/** The last 8 s of 16 kHz PCM as Whisper's [80, 800] log-mel, normalised and right-padded like the reference. */
export const whisperFeatures = (pcm: Int16Array): Float32Array => {
  const clip = pcm.subarray(Math.max(0, pcm.length - SAMPLES));
  let mean = 0;
  for (const s of clip) mean += s;
  mean /= Math.max(1, clip.length);
  let variance = 0;
  for (const s of clip) variance += (s - mean) ** 2;
  variance /= Math.max(1, clip.length);
  // Normalising first makes the int16 scale irrelevant; padding stays 0 after it.
  const scale = 1 / Math.sqrt(variance / 32768 ** 2 + 1e-7) / 32768;
  const audio = new Float64Array(SAMPLES);
  for (let i = 0; i < clip.length; i += 1) audio[i] = (clip[i]! - mean) * scale;
  // center=True: reflect-pad n_fft/2 on both sides.
  const half = N_FFT / 2;
  const at = (i: number) => audio[i < 0 ? -i : i >= SAMPLES ? 2 * (SAMPLES - 1) - i : i]!;
  const logMel = new Float64Array(MELS * FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  let max = -Infinity;
  for (let t = 0; t < FRAMES; t += 1) {
    let silent = true;
    for (let i = 0; i < N_FFT; i += 1) {
      frame[i] = at(t * HOP + i - half) * HANN[i]!;
      if (frame[i] !== 0) silent = false;
    }
    // The padding past a short clip is all zeros: its power is zero, so skip the DFT.
    for (let k = 0; k < BINS; k += 1) {
      if (silent) {
        power[k] = 0;
        continue;
      }
      let re = 0;
      let im = 0;
      const row = k * N_FFT;
      for (let i = 0; i < N_FFT; i += 1) {
        re += frame[i]! * COS[row + i]!;
        im += frame[i]! * SIN[row + i]!;
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < MELS; m += 1) {
      let e = 0;
      for (let k = 0; k < BINS; k += 1) e += FILTERS[m * BINS + k]! * power[k]!;
      const v = Math.log10(Math.max(e, 1e-10));
      logMel[m * FRAMES + t] = v;
      if (v > max) max = v;
    }
  }
  const out = new Float32Array(MELS * FRAMES);
  for (let i = 0; i < out.length; i += 1) out[i] = (Math.max(logMel[i]!, max - 8) + 4) / 4;
  return out;
};

export interface SmartTurn {
  /** The probability that the turn is complete, from the utterance so far. */
  readonly complete: (pcm: Int16Array) => Promise<number>;
}

export const createSmartTurn = async (modelPath: string, threads = 1): Promise<SmartTurn> => {
  const ort: typeof Ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  return {
    complete: async (pcm) => {
      const out = await session.run({
        input_features: new ort.Tensor("float32", whisperFeatures(pcm), [1, MELS, FRAMES]),
      });
      const p = (out["logits"]!.data as Float32Array)[0];
      return p !== undefined && Number.isFinite(p) ? p : 0;
    },
  };
};
