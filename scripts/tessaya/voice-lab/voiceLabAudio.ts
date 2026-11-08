// @effect-diagnostics nodeBuiltinImport:off
/** WAV joins, file names and a pitch guess for the voice-lab scripts that save audio for a person to listen to. */
import { encodeWav } from "../../../packages/baton-voice/src/providers/speech.ts";
import { parseWav } from "../../../apps/desktop/src/baton/voice/pcm.ts";

/**
 * Spellings of her name to hear side by side. The aim is tess-AY-uh (tɛsˈeɪə, CMU "T EH0 S EY1 AH0"): the middle
 * syllable stressed and rhyming with "say", then a soft "uh". Pocket TTS reads text only (no phoneme input).
 */
export const TESSAYA_CANDIDATES = [
  "Tessaya",
  "Tess-ay-uh",
  "Tess AY uh",
  "Tessayuh",
  "Tess-say-uh",
  "Tesay-uh",
] as const;

/** "01-Tessaya.wav", "03-Tess-AY-uh.wav": numbered as listed, safe on every file system. */
export const candidateFile = (index: number, candidate: string): string =>
  `${String(index + 1).padStart(2, "0")}-${candidate.replace(/[^\p{L}\p{N}-]+/gu, "-")}.wav`;

/** Mono 16-bit samples at the file's own rate. */
const monoOf = (bytes: Uint8Array): { readonly pcm: Int16Array; readonly sampleRate: number } => {
  const wav = parseWav(bytes);
  const frames = Math.floor(wav.samples.length / wav.channels);
  const pcm = new Int16Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c += 1) sum += wav.samples[f * wav.channels + c] ?? 0;
    pcm[f] = Math.max(-32768, Math.min(32767, Math.round((sum / wav.channels) * 32767)));
  }
  return { pcm, sampleRate: wav.sampleRate };
};

/** The clips one after another, with a short quiet between, at the first clip's rate (Pocket's are all 24 kHz). */
export const joinWavs = (clips: ReadonlyArray<Uint8Array>, gapMs = 400): Buffer => {
  const parts = clips.map(monoOf);
  const sampleRate = parts[0]?.sampleRate ?? 24_000;
  const gap = Math.round((sampleRate * gapMs) / 1000);
  const out = new Int16Array(parts.reduce((n, p) => n + p.pcm.length + gap, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part.pcm, at);
    at += part.pcm.length + gap;
  }
  return encodeWav(out, sampleRate);
};

/**
 * Median pitch of the voiced 40 ms frames, by autocorrelation over 60-400 Hz; null with too little voiced audio.
 * shortcut: one plain estimate per frame, enough to tell a typical male from a typical female voice, not prosody.
 */
export const medianPitchHz = (pcm: Int16Array, sampleRate: number): number | null => {
  const size = Math.round(sampleRate * 0.04);
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.ceil(sampleRate / 60);
  const pitches: number[] = [];
  for (let start = 0; start + size + maxLag <= pcm.length; start += size) {
    let energy = 0;
    for (let i = 0; i < size; i += 1) energy += (pcm[start + i] ?? 0) ** 2;
    if (energy / size < 500 ** 2) continue;
    const sums: number[] = [];
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let sum = 0;
      for (let i = 0; i < size; i += 1) sum += (pcm[start + i] ?? 0) * (pcm[start + i + lag] ?? 0);
      sums.push(sum);
    }
    const best = Math.max(...sums);
    // The shortest lag nearly as good as the best: a multiple of the period scores about as well (octave errors).
    let at = sums.findIndex((sum) => sum >= best * 0.9);
    while (at >= 0 && at + 1 < sums.length && (sums[at + 1] ?? 0) > (sums[at] ?? 0)) at += 1;
    const bestLag = at < 0 ? 0 : minLag + at;
    if (bestLag > 0 && best / energy > 0.5) pitches.push(sampleRate / bestLag);
  }
  if (pitches.length < 5) return null;
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] ?? null;
};

/** A guess for the card, from the median pitch: typical speaking voices sit near 85-155 Hz and 165-255 Hz. */
export const voiceKind = (hz: number | null): "male" | "female" | "unknown" =>
  hz === null ? "unknown" : hz < 155 ? "male" : hz > 175 ? "female" : "unknown";

export const pitchOfWav = (bytes: Uint8Array): number | null => {
  const { pcm, sampleRate } = monoOf(bytes);
  return medianPitchHz(pcm, sampleRate);
};
