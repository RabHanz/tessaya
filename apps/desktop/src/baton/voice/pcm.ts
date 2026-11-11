/**
 * PCM plumbing: whatever the source gives (a 48 kHz stereo receiver, a WAV
 * file) becomes 16 kHz mono int16 in 20 ms frames.
 */
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from "./voiceTypes.ts";

/** Interleaved float samples in [-1, 1] → mono 16 kHz int16. */
export const toVoicePcm = (
  interleaved: Float32Array,
  channels: number,
  sampleRate: number,
): Int16Array => {
  const frames = Math.floor(interleaved.length / channels);
  const ratio = sampleRate / VOICE_SAMPLE_RATE;
  const outLength = Math.floor(frames / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    // Box-filter average over the source span: enough anti-aliasing for speech
    // at these ratios. shortcut: no polyphase filter, upgrade if STT accuracy suffers.
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let f = start; f < end; f++) {
      for (let c = 0; c < channels; c++) sum += interleaved[f * channels + c] ?? 0;
    }
    const v = sum / ((end - start) * channels);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
};

/** The sidecar's `pcm` line: 16-bit little-endian samples in base64. Copied, as a Buffer's offset may be unaligned. */
export const pcmOf = (b64: string): Int16Array => {
  const bytes = Buffer.from(b64, "base64");
  const out = new Int16Array(bytes.length >> 1);
  Buffer.from(out.buffer).set(bytes.subarray(0, out.length * 2));
  return out;
};

/** Accumulates arbitrary-length chunks and emits fixed 20 ms frames. */
export const makeFramer = (onFrame: (frame: Int16Array) => void) => {
  let pending = new Int16Array(0);
  return (chunk: Int16Array): void => {
    const joined = new Int16Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    let offset = 0;
    while (joined.length - offset >= VOICE_FRAME_SAMPLES) {
      onFrame(joined.slice(offset, offset + VOICE_FRAME_SAMPLES));
      offset += VOICE_FRAME_SAMPLES;
    }
    pending = joined.slice(offset);
  };
};

export interface WavAudio {
  readonly sampleRate: number;
  readonly channels: number;
  /** Interleaved, in [-1, 1]. */
  readonly samples: Float32Array;
}

/** PCM WAV (16-bit int or 32-bit float). Throws on anything else, by name. */
export const parseWav = (bytes: Uint8Array): WavAudio => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file.");
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      const end = Math.min(body + size, bytes.length);
      if (format === 1 && bits === 16) {
        const samples = new Float32Array((end - body) / 2);
        for (let i = 0; i < samples.length; i++)
          samples[i] = view.getInt16(body + i * 2, true) / 32768;
        return { sampleRate, channels, samples };
      }
      if (format === 3 && bits === 32) {
        const samples = new Float32Array((end - body) / 4);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(body + i * 4, true);
        return { sampleRate, channels, samples };
      }
      throw new Error(`Unsupported WAV encoding: format ${format}, ${bits}-bit.`);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk.");
};
