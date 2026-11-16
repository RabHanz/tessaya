/** His clip for a voice clone, as plain PCM: read, checked, written back, and a clone's output stamped as synthetic. */

export interface Pcm {
  readonly rate: number;
  /** Mono, 16-bit. */
  readonly samples: Int16Array;
}

/** A 16-bit PCM WAV (any rate, mono or stereo, which is averaged); null for anything else. */
export const readWav = (bytes: Uint8Array): Pcm | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format: { channels: number; rate: number; bits: number; codec: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt " && size >= 16) {
      format = {
        codec: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (tag(at) === "data" && format !== null) {
      // 0xfffe is WAVE_FORMAT_EXTENSIBLE, which browsers and recorders write for plain PCM too.
      if ((format.codec !== 1 && format.codec !== 0xfffe) || format.bits !== 16) return null;
      if (format.channels < 1 || format.rate < 8_000) return null;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (2 * format.channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < format.channels; c++)
          sum += view.getInt16(body + 2 * (i * format.channels + c), true);
        samples[i] = Math.round(sum / format.channels);
      }
      return { rate: format.rate, samples };
    }
    at = body + size + (size % 2);
  }
  return null;
};

export const writeWav = ({ rate, samples }: Pcm): Uint8Array => {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  put(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  put(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return out;
};

const dbfs = (rms: number) => (rms <= 0 ? -120 : 20 * Math.log10(rms / 32768));

/** 20 ms frames' RMS, in dBFS. */
const frameLevels = ({ rate, samples }: Pcm): number[] => {
  const size = Math.max(1, Math.round(rate / 50));
  const levels: number[] = [];
  for (let at = 0; at + size <= samples.length; at += size) {
    let sum = 0;
    for (let i = at; i < at + size; i++) sum += samples[i]! * samples[i]!;
    levels.push(dbfs(Math.sqrt(sum / size)));
  }
  return levels;
};

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? -120;

export const CLONE_MIN_SECONDS = 5;
export const CLONE_MAX_SECONDS = 30;
/**
 * Speech over the room floor (loudest 5% of frames vs quietest 10%), before cleaning. Clone-quality lane, 16 Nov: refs at
 * 32 dB (cleaned or not) kept his voice, 25 and 20 drifted; his close wireless mic's clips sit at 36 to 49 (p10 to p90).
 */
export const CLONE_MIN_SNR_DB = 30;

/**
 * Why a clip cannot make a clone, in a sentence for him, or null when it can: 5 to 30 s, not clipped, loud enough,
 * speech clearly above the room's noise, and at least 3 s of it.
 */
export const cloneClipProblem = (pcm: Pcm): string | null => {
  const seconds = pcm.samples.length / pcm.rate;
  if (seconds < CLONE_MIN_SECONDS)
    return `The clip is ${seconds.toFixed(1)} s; it needs at least ${CLONE_MIN_SECONDS} seconds of the voice.`;
  if (seconds > CLONE_MAX_SECONDS) return `Keep the clip under ${CLONE_MAX_SECONDS} seconds.`;
  let clipped = 0;
  for (const s of pcm.samples) if (s >= 32_700 || s <= -32_700) clipped++;
  if (clipped / pcm.samples.length > 0.002)
    return "The clip is distorted (too loud). Record a little further from the mic.";
  const levels = frameLevels(pcm).toSorted((a, b) => a - b);
  // The loud end, so a clip that is mostly pauses is judged on its speech.
  const speech = percentile(levels, 0.95);
  const floor = percentile(levels, 0.1);
  if (speech < -42) return "The clip is too quiet. Speak closer to the mic.";
  // A clone copies the room too: a noisy reference comes back as static in every line.
  if (speech - floor < CLONE_MIN_SNR_DB)
    return "Too noisy: record somewhere quieter, with only one person speaking.";
  const spoken = levels.filter((level) => level > floor + 12).length * 0.02;
  if (spoken < 3) return "There are under 3 seconds of speech in it. Say a few full sentences.";
  return null;
};

/**
 * A clone's two clean steps: the reference before Pocket hears it, and every line it says. Swappable as a whole, so
 * the clone-quality lane's pipeline (denoise, de-ess, another engine) drops in for `BASIC_CLEAN`.
 */
export interface CloneClean {
  readonly reference: (pcm: Pcm) => Promise<Pcm>;
  readonly output: (pcm: Pcm) => Promise<Pcm>;
}

/** Leading and trailing silence off, keeping 150 ms: frames under the floor + 12 dB, as the speech count reads it. */
export const trimSilence = (pcm: Pcm): Pcm => {
  const levels = frameLevels(pcm);
  const floor = percentile(
    levels.toSorted((a, b) => a - b),
    0.1,
  );
  const first = levels.findIndex((level) => level > floor + 12);
  if (first === -1) return pcm;
  const last = levels.findLastIndex((level) => level > floor + 12);
  const frame = Math.round(pcm.rate / 50);
  const margin = Math.round(pcm.rate * 0.15);
  return {
    rate: pcm.rate,
    samples: pcm.samples.slice(
      Math.max(0, first * frame - margin),
      Math.min(pcm.samples.length, (last + 1) * frame + margin),
    ),
  };
};

/** A 2nd-order Butterworth high-pass: rumble and hum under the voice out. */
export const highPass = (pcm: Pcm, hz: number): Pcm => {
  const w = Math.tan((Math.PI * hz) / pcm.rate);
  const n = 1 / (1 + Math.SQRT2 * w + w * w);
  const [b0, b1, b2] = [n, -2 * n, n];
  const a1 = 2 * (w * w - 1) * n;
  const a2 = (1 - Math.SQRT2 * w + w * w) * n;
  const out = new Int16Array(pcm.samples.length);
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < out.length; i++) {
    const x = pcm.samples[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    [x2, x1, y2, y1] = [x1, x, y1, y];
    out[i] = Math.max(-32_768, Math.min(32_767, Math.round(y)));
  }
  return { rate: pcm.rate, samples: out };
};

/** Speech frames' RMS to `target` dBFS, never past a `ceiling` dBFS peak. */
export const normalise = (pcm: Pcm, target = -20, ceiling = -1): Pcm => {
  const size = Math.round(pcm.rate / 50);
  const levels = frameLevels(pcm);
  const floor = percentile(
    levels.toSorted((a, b) => a - b),
    0.1,
  );
  let sum = 0;
  let count = 0;
  let peak = 1;
  for (const [index, level] of levels.entries()) {
    if (level <= floor + 12) continue;
    for (let i = index * size; i < (index + 1) * size; i++) sum += pcm.samples[i]! ** 2;
    count += size;
  }
  for (const s of pcm.samples) peak = Math.max(peak, Math.abs(s));
  if (count === 0) return pcm;
  const gain = Math.min(
    (32_768 * 10 ** (target / 20)) / Math.sqrt(sum / count),
    (32_768 * 10 ** (ceiling / 20)) / peak,
  );
  return { rate: pcm.rate, samples: Int16Array.from(pcm.samples, (s) => Math.round(s * gain)) };
};

/** A 2nd-order Butterworth low-pass. */
export const lowPass = (pcm: Pcm, hz: number): Pcm => {
  const w = Math.tan((Math.PI * hz) / pcm.rate);
  const n = 1 / (1 + Math.SQRT2 * w + w * w);
  const [b0, b1, b2] = [w * w * n, 2 * w * w * n, w * w * n];
  const a1 = 2 * (w * w - 1) * n;
  const a2 = (1 - Math.SQRT2 * w + w * w) * n;
  const out = new Int16Array(pcm.samples.length);
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < out.length; i++) {
    const x = pcm.samples[i]!;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    [x2, x1, y2, y1] = [x1, x, y1, y];
    out[i] = Math.max(-32_768, Math.min(32_767, Math.round(y)));
  }
  return { rate: pcm.rate, samples: out };
};

/** Pauses over 0.5 s cut to 0.35 s: a clone copies long gaps as hesitation. Quiet = under the floor + 12 dB. */
export const shortenPauses = (pcm: Pcm): Pcm => {
  const levels = frameLevels(pcm);
  const floor = percentile(
    levels.toSorted((a, b) => a - b),
    0.1,
  );
  const frame = Math.round(pcm.rate / 50);
  const keep: Array<[number, number]> = [];
  let quietFrom = -1;
  let start = 0;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i]! <= floor + 12;
    if (quiet && quietFrom === -1) quietFrom = i;
    if (!quiet && quietFrom !== -1) {
      // 25 frames = 0.5 s; keep 17.5 frames of it, half on each side.
      if (i - quietFrom > 25 && quietFrom > 0 && i < levels.length) {
        keep.push([start, (quietFrom + 9) * frame]);
        start = (i - 9) * frame;
      }
      quietFrom = -1;
    }
  }
  keep.push([start, pcm.samples.length]);
  const out = new Int16Array(keep.reduce((n, [a, b]) => n + b - a, 0));
  let at = 0;
  for (const [a, b] of keep) {
    out.set(pcm.samples.subarray(a, b), at);
    at += b - a;
  }
  return { rate: pcm.rate, samples: out };
};

/** Sibilance down: 10 ms frames where the band over 5 kHz holds over half the energy lose up to 6 dB of that band. */
export const deEss = (pcm: Pcm): Pcm => {
  if (pcm.rate < 12_000) return pcm;
  // A Linkwitz-Riley split: the two bands sum back to the voice (phase only), so turning one down is a clean cut.
  const high = highPass(highPass(pcm, 5_000), 5_000).samples;
  const low = lowPass(lowPass(pcm, 5_000), 5_000).samples;
  const out = new Int16Array(pcm.samples.length);
  const size = Math.round(pcm.rate / 100);
  let cut = 0;
  for (let at = 0; at < out.length; at += size) {
    let all = 0;
    let hi = 0;
    for (let i = at; i < Math.min(out.length, at + size); i++) {
      all += pcm.samples[i]! ** 2;
      hi += high[i]! ** 2;
    }
    const share = all > 0 ? hi / all : 0;
    // Toward a cut of up to 0.5 (6 dB) in proportion to how far past half the band is, smoothed so it never clicks.
    const want = share > 0.5 ? Math.min(0.5, share - 0.5) : 0;
    for (let i = at; i < Math.min(out.length, at + size); i++) {
      cut += (want - cut) * 0.01;
      out[i] = Math.max(-32_768, Math.min(32_767, Math.round(low[i]! + (1 - cut) * high[i]!)));
    }
  }
  return { rate: pcm.rate, samples: out };
};

/**
 * The clone-quality lane's pipeline (tessaya-ops voice-clean prep-ref.sh / post-out.sh, 16 Nov). Reference: denoise
 * (DeepFilterNet 3 at a 30 dB limit), 70 Hz high-pass, low-pass under the source's Nyquist (the denoiser invents hiss
 * above it), long pauses shortened, ends trimmed, -20 dBFS. Lines: high-pass, de-ess, -16 dBFS with a -1.5 dBFS peak,
 * never denoised (a clean reference already gives silence between words; a second pass only adds artifacts).
 */
export const cloneClean = (denoise: (pcm: Pcm) => Promise<Pcm | null>): CloneClean => ({
  reference: async (pcm) => {
    const clean = (await denoise(pcm)) ?? pcm;
    const filtered = lowPass(highPass(clean, 70), Math.min(pcm.rate, clean.rate) * 0.47);
    return normalise(trimSilence(shortenPauses(filtered)));
  },
  output: async (pcm) => normalise(deEss(highPass(pcm, 70)), -16, -1.5),
});

/** Without a denoiser. */
export const BASIC_CLEAN: CloneClean = cloneClean(async () => null);

/** Pocket's silent failure (no cloning weights: peak about -51 dBFS, no error): anything this quiet is not speech. */
export const isNearSilence = (pcm: Pcm): boolean => {
  let peak = 0;
  for (const s of pcm.samples) peak = Math.max(peak, Math.abs(s));
  return dbfs(peak) < -35;
};

/** Linear resampling, for the speaker model's 16 kHz. */
export const resample = ({ rate, samples }: Pcm, to: number): Int16Array => {
  if (rate === to) return samples;
  const out = new Int16Array(Math.floor((samples.length * to) / rate));
  for (let i = 0; i < out.length; i++) {
    const at = (i * rate) / to;
    const left = Math.floor(at);
    const right = Math.min(samples.length - 1, left + 1);
    out[i] = Math.round(samples[left]! + (samples[right]! - samples[left]!) * (at - left));
  }
  return out;
};

/** A LIST/INFO chunk on the WAV, so a saved file still says it is synthetic speech. */
export const markSynthetic = (wav: Uint8Array): Uint8Array => {
  const text = "Synthetic speech: a cloned voice (Tessaya)\0";
  const comment = text.length % 2 === 0 ? text : `${text}\0`;
  const chunk = new Uint8Array(12 + 8 + comment.length);
  const view = new DataView(chunk.buffer);
  const put = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) chunk[at + i] = s.charCodeAt(i);
  };
  put(0, "LIST");
  view.setUint32(4, 4 + 8 + comment.length, true);
  put(8, "INFOICMT");
  view.setUint32(16, comment.length, true);
  put(20, comment);
  const out = new Uint8Array(wav.length + chunk.length);
  out.set(wav);
  out.set(chunk, wav.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
};
