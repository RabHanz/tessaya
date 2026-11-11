/** Detects speech over Tessaya's own voice: learns the room from the player's reference, subtracts the predicted echo, flags the residual. A detector, not a cleaner; silent until `ready`. */

const RATE = 8_000;
const TAPS = 768; // 96 ms of room
const BEFORE = 128; // taps before the estimated delay: 16 ms
const RING = RATE * 6;
const ENV_HOP = 80; // 10 ms envelope cells
const SEARCH_MS = 600;
const MU = 0.8;
/** Speech over the echo lifts the residual (relative to what is playing) to this many times its usual level. */
const Q_OVER = 6;
const EPS = 1e-6;

const REF_ACTIVE_RMS = 0.004;
const NEAR_END_FLOOR = 0.006;
const READY_ERLE_DB = 6;

export interface EchoVerdict {
  /** The room has been learned: a "no" from `nearEnd` can be trusted. */
  readonly ready: boolean;
  /** Something other than the echo is in this frame. */
  readonly nearEnd: boolean;
  /** How far the echo has been cut, in dB, as learned. */
  readonly erleDb: number;
  /** Residual over mic, and residual over the echo's usual residual (for tuning). */
  readonly ratio?: number;
  readonly over?: number;
}

export interface EchoGuard {
  /** What is about to play: mono 16-bit at 16 kHz, and the time it will sound. */
  readonly reference: (pcm: Int16Array, soundsAtMs: number) => void;
  /** One mic frame (16 kHz) heard at `atMs`. */
  readonly process: (mic: Int16Array, atMs: number) => EchoVerdict;
  /** Nothing is playing any more, or the output device changed: forget the room. */
  readonly reset: () => void;
  /** For tests and tuning. */
  readonly state: () => {
    readonly delayMs: number;
    readonly erleDb: number;
    readonly converged: boolean;
  };
}

const decimate = (pcm: Int16Array): Float32Array => {
  const out = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    const a = pcm[2 * i]! / 32768;
    const b = pcm[2 * i + 1]! / 32768;
    const c = pcm[2 * i + 2] === undefined ? b : pcm[2 * i + 2]! / 32768;
    out[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  return out;
};

export const createEchoGuard = (): EchoGuard => {
  // The reference as a timeline in 8 kHz samples: where a chunk sounds, not when it arrived.
  const line = new Float32Array(RING);
  let written: Array<{ s: number; e: number }> = [];
  const envRef = new Float32Array(RING / ENV_HOP);
  const envMic = new Float32Array(RING / ENV_HOP);

  let delay = -1; // in 8 kHz samples
  let w = new Float32Array(TAPS);
  let erle = 0;
  let qFast = 0;
  let qBase = 0;
  let sinceEstimate = 0;
  let converged = false;

  const at = (index: number): number => line[((index % RING) + RING) % RING]!;
  const covered = (index: number): boolean => written.some((s) => index >= s.s && index < s.e);

  const reference: EchoGuard["reference"] = (pcm, soundsAtMs) => {
    const x = decimate(pcm);
    const start = Math.round(soundsAtMs * (RATE / 1000));
    for (let i = 0; i < x.length; i += 1) line[(((start + i) % RING) + RING) % RING] = x[i]!;
    // Envelope cells of what will sound.
    for (let c = Math.floor(start / ENV_HOP); c * ENV_HOP < start + x.length; c += 1) {
      let sum = 0;
      let n = 0;
      for (
        let i = Math.max(c * ENV_HOP, start);
        i < Math.min((c + 1) * ENV_HOP, start + x.length);
        i += 1
      ) {
        sum += x[i - start]! ** 2;
        n += 1;
      }
      if (n > 0) envRef[((c % envRef.length) + envRef.length) % envRef.length] = Math.sqrt(sum / n);
    }
    written.push({ s: start, e: start + x.length });
    const floor = start - RING / 2;
    written = written.filter((s) => s.e > floor);
  };

  const estimateDelay = (end: number): void => {
    // Correlate the mic's and the reference's envelopes over the last 2 s for each delay up to 600 ms.
    const cells = 200;
    const endCell = Math.floor(end / ENV_HOP);
    let best = -1;
    let bestScore = 0;
    let sum = 0;
    let count = 0;
    for (let d = 0; d <= SEARCH_MS / 10; d += 1) {
      let score = 0;
      let norm = 1e-9;
      for (let c = 0; c < cells; c += 1) {
        const m = envMic[(((endCell - c) % envMic.length) + envMic.length) % envMic.length]!;
        const r = envRef[(((endCell - c - d) % envRef.length) + envRef.length) % envRef.length]!;
        score += m * r;
        norm += r * r;
      }
      score /= Math.sqrt(norm);
      sum += score;
      count += 1;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    if (best >= 0 && bestScore > 1.8 * (sum / count)) {
      const next = best * (RATE / 100);
      if (delay < 0 || Math.abs(next - delay) > 40) {
        delay = next;
        w = new Float32Array(TAPS);
        erle = 0;
        converged = false;
        qFast = 0;
        qBase = 0;
      }
    }
  };

  const process: EchoGuard["process"] = (mic16, atMs) => {
    const mic = decimate(mic16);
    const end = Math.round(atMs * (RATE / 1000));
    const start = end - mic.length;
    // The mic envelope, for the delay search.
    let micEnergy = 0;
    for (const v of mic) micEnergy += v * v;
    const micRms = Math.sqrt(micEnergy / Math.max(1, mic.length));
    for (let h = 0; h < mic.length; h += ENV_HOP) {
      let part = 0;
      for (let i = h; i < Math.min(mic.length, h + ENV_HOP); i += 1) part += mic[i]! * mic[i]!;
      const cell = Math.floor((start + h) / ENV_HOP);
      envMic[((cell % envMic.length) + envMic.length) % envMic.length] = Math.sqrt(part / ENV_HOP);
    }

    const playing = covered(start) || covered(end - 1) || covered(start - 400);
    if (!playing) {
      sinceEstimate = 0;
      return { ready: converged, nearEnd: false, erleDb: erle };
    }
    sinceEstimate += mic.length;
    if (sinceEstimate >= RATE / 2 && (delay < 0 || !converged)) {
      sinceEstimate = 0;
      estimateDelay(end);
    }
    if (delay < 0) return { ready: false, nearEnd: false, erleDb: 0 };

    // Predicted echo and what is left.
    const residual = new Float32Array(mic.length);
    let refEnergy = 0;
    for (let n = 0; n < mic.length; n += 1) {
      const base = start + n - delay + BEFORE;
      let y = 0;
      for (let k = 0; k < TAPS; k += 1) y += w[k]! * at(base - k);
      residual[n] = mic[n]! - y;
      const x = at(base);
      refEnergy += x * x;
    }
    let eEnergy = 0;
    for (const v of residual) eEnergy += v * v;
    const refRms = Math.sqrt(refEnergy / mic.length);
    const eRms = Math.sqrt(eEnergy / mic.length);
    if (refRms < REF_ACTIVE_RMS) return { ready: converged, nearEnd: false, erleDb: erle };

    const ratio = eRms / (micRms + EPS);
    // The residual relative to what is playing: speech over the echo is not related to the reference, so this jumps.
    const q = eEnergy / (refEnergy + 1e-4 * mic.length);
    qFast = qFast === 0 ? q : 0.6 * qFast + 0.4 * q;
    const overResidual = qBase > 0 ? qFast / qBase : 1;
    const nearEnd = converged && eRms > NEAR_END_FLOOR && overResidual > Q_OVER;

    // Learn only from echo: not while someone else is speaking, and always while the filter is still young.
    if (!nearEnd) {
      // Block normalised LMS over the frame.
      let power = 0;
      for (let k = 0; k < TAPS; k += 8) {
        const x = at(start - delay + BEFORE - k);
        power += x * x;
      }
      const norm = (power * 8 + TAPS * 1.5e-4) * mic.length;
      const grad = new Float32Array(TAPS);
      for (let n = 0; n < mic.length; n += 1) {
        const base = start + n - delay + BEFORE;
        const e = residual[n]!;
        for (let k = 0; k < TAPS; k += 1) grad[k]! += e * at(base - k);
      }
      for (let k = 0; k < TAPS; k += 1) w[k]! += (MU * grad[k]!) / norm;
      const cut = 10 * Math.log10((micEnergy + EPS) / (eEnergy + EPS));
      erle = 0.9 * erle + 0.1 * cut;
      qBase = qBase === 0 ? q : 0.97 * qBase + 0.03 * q;
      if (erle > READY_ERLE_DB) converged = true;
    }
    return { ready: converged, nearEnd, erleDb: erle, ratio, over: overResidual };
  };

  const reset = () => {
    written = [];
    line.fill(0);
    envRef.fill(0);
    envMic.fill(0);
    delay = -1;
    w = new Float32Array(TAPS);
    erle = 0;
    qFast = 0;
    qBase = 0;
    converged = false;
    sinceEstimate = 0;
  };

  const state = () => ({
    delayMs: delay < 0 ? -1 : delay / (RATE / 1000),
    erleDb: erle,
    converged,
  });
  return { reference, process, reset, state };
};
