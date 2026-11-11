/**
 * One spoken stream from a reply's pieces (`interjections.ts`): each text piece synthesised in turn, and each sound
 * spliced between them at a level matched to the speech before it, so a sigh is never louder than her voice. The output
 * is one streaming WAV (mono 16-bit, 24 kHz like Pocket and Gemini), the shape every player here already takes.
 */
import type { SpeechPiece } from "./interjections.ts";

export const SPLICE_RATE = 24_000;
/** Around a sound, so it does not run into the words. */
export const SPLICE_GAP_MS = 70;
/** When nothing has been said yet to match: a quiet speaking level. */
const DEFAULT_RMS = 0.06;

/** A WAV header whose sizes say "streaming" (as Pocket writes them). */
export const streamingWavHeader = (rate: number = SPLICE_RATE): Uint8Array => {
  const head = new Uint8Array(44);
  const view = new DataView(head.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) head[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 0xffffffff, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, 0xffffffff, true);
  return head;
};

export const silence = (ms: number, rate: number = SPLICE_RATE): Int16Array =>
  new Int16Array(Math.round((ms / 1000) * rate));

export const rmsOf = (pcm: Int16Array): number => {
  let sum = 0;
  for (const v of pcm) sum += (v / 32768) ** 2;
  return pcm.length === 0 ? 0 : Math.sqrt(sum / pcm.length);
};

/** A soft breath: low-passed noise under a rise-and-fall envelope, at the given RMS. Seeded, so tests repeat. */
export const breath = (
  ms: number,
  rms: number,
  rate: number = SPLICE_RATE,
  seed = 7,
): Int16Array => {
  const out = new Int16Array(Math.round((ms / 1000) * rate));
  let state = seed >>> 0;
  let low = 0;
  const raw = new Float32Array(out.length);
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    low += 0.18 * ((state / 0xffffffff) * 2 - 1 - low);
    raw[i] = low * Math.sin((Math.PI * i) / Math.max(1, out.length - 1)) ** 2;
  }
  let sum = 0;
  for (const v of raw) sum += v * v;
  const scale = raw.length === 0 || sum === 0 ? 0 : rms / Math.sqrt(sum / raw.length);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(raw[i]! * scale * 32768)));
  return out;
};

const scaled = (pcm: Int16Array, gain: number): Int16Array =>
  gain === 1 ? pcm : pcm.map((v) => Math.round(v * gain));

/** Linear resampling, for a piece that did not come at the stream's rate. */
const resample = (pcm: Int16Array, from: number, to: number): Int16Array => {
  if (from === to || pcm.length === 0) return pcm;
  const out = new Int16Array(Math.round((pcm.length * to) / from));
  for (let i = 0; i < out.length; i += 1) {
    const x = (i * from) / to;
    const j = Math.floor(x);
    const a = pcm[j] ?? 0;
    const b = pcm[Math.min(j + 1, pcm.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * (x - j));
  }
  return out;
};

const bytesOf = (pcm: Int16Array): Uint8Array =>
  new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** A whole WAV stream's samples and rate. The header is found however the chunks split it. */
const samplesOf = async (stream: AsyncIterable<Uint8Array>): Promise<Int16Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  let data = -1;
  for (let i = 12; i + 4 <= all.length; i += 1) {
    if (all[i] === 0x64 && all[i + 1] === 0x61 && all[i + 2] === 0x74 && all[i + 3] === 0x61) {
      data = i;
      break;
    }
  }
  if (data < 0 || all.length < 28) return new Int16Array(0);
  const rate = new DataView(all.buffer).getUint32(24, true);
  const start = data + 8;
  const count = Math.floor((all.length - start) / 2);
  const pcm = new Int16Array(count);
  const view = new DataView(all.buffer, start, count * 2);
  for (let i = 0; i < count; i += 1) pcm[i] = view.getInt16(i * 2, true);
  return resample(pcm, rate, SPLICE_RATE);
};

/**
 * The pieces as one stream. `say` synthesises one text in this voice (a WAV stream). A text piece starts playing as
 * soon as it is synthesised; a sound waits for the words before it, so its level can match them.
 */
export async function* spliceSpeech(
  pieces: ReadonlyArray<SpeechPiece>,
  say: (text: string) => AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield streamingWavHeader();
  let level = DEFAULT_RMS;
  for (const [i, piece] of pieces.entries()) {
    if (piece.kind === "text") {
      const pcm = await samplesOf(say(piece.text));
      if (pcm.length > 0) level = rmsOf(pcm) || level;
      yield bytesOf(pcm);
      continue;
    }
    const gap = silence(i === 0 ? 0 : SPLICE_GAP_MS);
    const sound = piece.sound;
    const body =
      sound.kind === "pause"
        ? silence(sound.ms)
        : sound.kind === "breath"
          ? breath(sound.ms, level * 0.3)
          : scaled(await samplesOf(say(sound.text)), sound.gain);
    yield bytesOf(gap);
    yield bytesOf(body);
    if (i < pieces.length - 1) yield bytesOf(silence(SPLICE_GAP_MS));
  }
}
