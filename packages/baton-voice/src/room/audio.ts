/**
 * The room's PCM plumbing: Pocket speaks 24 kHz, the R1 plays 16 kHz, and frames go out in 60 ms publishes.
 *
 * @module baton-voice/room/audio
 */

/** The R1's downlink publish: 60 ms of 16 kHz mono s16, the size its WSS receive buffer was sized for (3.29.6). */
export const DOWN_FRAME_BYTES = 1920;

// A 48-tap windowed-sinc low-pass at 7.2 kHz on the 48 kHz grid, applied as 2x up then 3x down.
const TAPS = 48;
const FIR = (() => {
  const cutoff = 7_200 / 48_000;
  const h = Float64Array.from({ length: TAPS }, (_, i) => {
    const x = i - (TAPS - 1) / 2;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)));
  });
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map((v) => (v / sum) * 2);
})();

/** A streaming 24 kHz to 16 kHz converter; feed chunks in order, each call returns what is ready. */
export const createResampler24to16 = () => {
  // History of the 48 kHz zero-stuffed signal, and the phase of the next output on that grid.
  let history = new Float64Array(TAPS);
  let phase = 0;
  return (input: Int16Array): Int16Array => {
    const up = new Float64Array(TAPS + input.length * 2);
    up.set(history);
    for (let i = 0; i < input.length; i += 1) up[TAPS + 2 * i] = input[i]!;
    const out: number[] = [];
    let n = phase;
    for (; n + TAPS <= up.length; n += 3) {
      let acc = 0;
      for (let k = 0; k < TAPS; k += 1) acc += FIR[k]! * up[n + k]!;
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
    }
    phase = n - (up.length - TAPS);
    history = up.slice(up.length - TAPS);
    return Int16Array.from(out);
  };
};

/** Strips a streaming WAV header (Pocket writes 0xFFFFFFFF sizes) and yields whole s16 samples. */
export const createWavReader = () => {
  let header = Buffer.alloc(0);
  let body = false;
  let odd: number | null = null;
  return (chunk: Uint8Array): Int16Array => {
    let bytes = Buffer.from(chunk);
    if (!body) {
      header = Buffer.concat([header, bytes]);
      const at = header.indexOf("data");
      if (at < 0 || header.length < at + 8) return new Int16Array(0);
      body = true;
      bytes = header.subarray(at + 8);
    }
    if (odd !== null) bytes = Buffer.concat([Buffer.from([odd]), bytes]);
    odd = bytes.length % 2 === 1 ? bytes[bytes.length - 1]! : null;
    const whole = bytes.length - (odd === null ? 0 : 1);
    return fromBytes(bytes.subarray(0, whole));
  };
};

export const toBytes = (pcm: Int16Array): Buffer =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** A fresh, aligned copy: a pooled Buffer can sit at an odd offset, which an Int16Array view refuses. */
export const fromBytes = (bytes: Uint8Array): Int16Array =>
  new Int16Array(Uint8Array.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).buffer);

/** How loud speech is in a clip, in dBFS: the 90th percentile of its 30 ms frames (pauses do not pull it down). */
export const speechLevel = (pcm: Int16Array): number => {
  const n = 480;
  const levels: number[] = [];
  for (let s = 0; s + n <= pcm.length; s += n) {
    let sum = 0;
    for (let i = s; i < s + n; i += 1) sum += pcm[i]! * pcm[i]!;
    levels.push(Math.sqrt(sum / n));
  }
  if (levels.length === 0) return Number.NEGATIVE_INFINITY;
  const at = levels.toSorted((a, b) => a - b)[Math.floor(levels.length * 0.9)]!;
  return at <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(at / 32768);
};
