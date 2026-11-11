/**
 * A room for testing echo handling without a speaker: speech-like audio, an echo path (delay, gain, reverberant tail) and
 * the mic mix. Deterministic. The real test is recordings through real speakers; this is the harness that measures the
 * detector's false barge-ins on its own voice and its recall of real interruptions (docs/baton/BARGE_IN.md).
 */
import { createEchoGuard } from "./echoGuard.ts";

export const RATE_16K = 16_000;
const FRAME = 320;

export const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4_294_967_296;
  };
};

/** Voiced and unvoiced stretches with a pitch contour, formants and syllable-rate energy, like speech to an adaptive filter. */
export const speechLike = (seconds: number, seed: number, pitchHz: number): Float32Array => {
  const rand = rng(seed);
  const n = Math.round(seconds * RATE_16K);
  const out = new Float32Array(n);
  let phase = 0;
  let syllable = 0;
  let formants = [700, 1200, 2600];
  let level = 0;
  let target = 0;
  let voiced = true;
  const y1 = [0, 0, 0];
  const y2 = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    if (i % Math.round(RATE_16K * 0.18) === 0) {
      syllable += 1;
      const pause = rand() < 0.14;
      target = pause ? 0 : 0.35 + rand() * 0.65;
      voiced = rand() < 0.78;
      formants = [350 + rand() * 600, 900 + rand() * 1100, 2200 + rand() * 900];
    }
    level += (target - level) * 0.002;
    const t = i / RATE_16K;
    const f0 = pitchHz * (1 + 0.12 * Math.sin(2 * Math.PI * 0.7 * t + syllable));
    phase += (2 * Math.PI * f0) / RATE_16K;
    const source = voiced ? Math.sign(Math.sin(phase)) * 0.6 + (rand() - 0.5) * 0.2 : (rand() - 0.5) * 1.2;
    let v = 0;
    for (let k = 0; k < 3; k += 1) {
      const a = Math.exp((-Math.PI * 120) / RATE_16K);
      const th = (2 * Math.PI * formants[k]!) / RATE_16K;
      const y = (1 - a) * source + 2 * a * Math.cos(th) * y1[k]! - a * a * y2[k]!;
      y2[k] = y1[k]!;
      y1[k] = y;
      v += y * (k === 0 ? 1 : 0.6);
    }
    out[i] = v * level;
  }
  // Normalise to a speaking level.
  let sum = 0;
  for (const v of out) sum += v * v;
  const scale = 0.12 / Math.sqrt(sum / n + 1e-9);
  for (let i = 0; i < n; i += 1) out[i] = out[i]! * scale;
  return out;
};

/** An impulse response: a direct path after `delayMs`, then a decaying noisy tail of about `rt60Ms`. */
export const room = (delayMs: number, rt60Ms: number, seed: number): Float32Array => {
  const rand = rng(seed);
  const delay = Math.round((delayMs * RATE_16K) / 1000);
  const tail = Math.round((rt60Ms * RATE_16K) / 1000);
  const ir = new Float32Array(delay + tail);
  ir[delay] = 1;
  for (let i = 1; i < tail; i += 1) ir[delay + i] = (rand() - 0.5) * 0.1 * Math.exp((-6.9 * i) / tail);
  return ir;
};

const convolve = (x: Float32Array, ir: Float32Array): Float32Array => {
  const out = new Float32Array(x.length);
  // Sparse enough to do directly: the IR is short.
  for (let k = 0; k < ir.length; k += 1) {
    const g = ir[k]!;
    if (g === 0) continue;
    for (let i = 0; i + k < x.length; i += 1) out[i + k] = out[i + k]! + g * x[i]!;
  }
  return out;
};

const toInt16 = (f: Float32Array, from: number): Int16Array => {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round((f[from + i] ?? 0) * 32768)));
  return out;
};

export interface Interruption {
  readonly atS: number;
  readonly seconds: number;
  /** His voice at the mic relative to the echo at the mic, in dB. */
  readonly overEchoDb: number;
  readonly pitchHz: number;
}

export interface EchoRun {
  /** Seconds at which the debounced detector said "someone is speaking over it", with the guard's readiness. */
  readonly detections: ReadonlyArray<number>;
  readonly readyAtS: number | null;
  readonly seconds: number;
}

/**
 * Plays `tts` through the room into a mic with `interruptions` mixed in, and returns when the guard heard someone over it.
 * `unknownDelayMs` is what the guard is not told: the output device and the air.
 */
export type VoiceSource = (seconds: number, seed: number, pitchHz: number) => Float32Array;

export type EchoScenario = Omit<Parameters<typeof runEcho>[0], "frames" | "trace"> & {
  /** Where his voice comes from (default: the synthetic speech-like signal). */
  readonly source?: VoiceSource;
};

/** The microphone signal for `tts` played through the room, with the interruptions mixed in. */
export const synthMic = (input: EchoScenario): Float32Array => {
  const echo = convolve(input.tts, room(input.unknownDelayMs, input.rt60Ms, input.seed));
  let eSum = 0;
  for (const v of echo) eSum += v * v;
  const echoGain = input.echoRms / Math.sqrt(eSum / echo.length + 1e-12);
  const rand = rng(input.seed ^ 0x9e3779b9);
  const mic = new Float32Array(input.tts.length);
  for (let i = 0; i < mic.length; i += 1) mic[i] = echo[i]! * echoGain + (rand() - 0.5) * 2 * input.noiseRms;
  for (const it of input.interruptions) {
    const speech = (input.source ?? speechLike)(it.seconds, input.seed + Math.round(it.atS * 100), it.pitchHz);
    let s = 0;
    for (const v of speech) s += v * v;
    const gain = (input.echoRms * 10 ** (it.overEchoDb / 20)) / Math.sqrt(s / speech.length + 1e-12);
    const from = Math.round(it.atS * RATE_16K);
    for (let i = 0; i < speech.length && from + i < mic.length; i += 1) mic[from + i] = mic[from + i]! + speech[i]! * gain;
  }
  return mic;
};

export const runEcho = (input: {
  readonly tts: Float32Array;
  readonly seed: number;
  readonly unknownDelayMs: number;
  readonly rt60Ms: number;
  readonly echoRms: number;
  readonly noiseRms: number;
  readonly interruptions: ReadonlyArray<Interruption>;
  /** Consecutive flagged frames that count as a detection (the core's debounce). */
  readonly frames?: number;
  readonly trace?: (atS: number, state: { delayMs: number; erleDb: number; converged: boolean; ratio: number; over: number; ne: boolean }) => void;
}): EchoRun => {
  const need = input.frames ?? 5;
  const guard = createEchoGuard();
  const mic = synthMic(input);
  const detections: number[] = [];
  let run = 0;
  let readyAt: number | null = null;
  for (let f = 0; (f + 1) * FRAME <= mic.length; f += 1) {
    const ms = (f + 1) * 20;
    // The player announces each chunk as it is about to sound.
    guard.reference(toInt16(input.tts, f * FRAME), f * 20);
    const verdict = guard.process(toInt16(mic, f * FRAME), ms);
    if (verdict.ready && readyAt === null) readyAt = ms / 1000;
    if (input.trace !== undefined && f % 5 === 0) input.trace(ms / 1000, { ...guard.state(), ratio: verdict.ratio ?? 0, over: verdict.over ?? 0, ne: verdict.nearEnd });
    run = verdict.nearEnd ? run + 1 : 0;
    // One detection per run of flagged frames, when it reaches the confirmation (as the core acts on it once and stops speaking).
    if (run === need) detections.push(ms / 1000);
  }
  return { detections, readyAtS: readyAt, seconds: mic.length / RATE_16K };
};

export interface GuardEvaluation {
  /** Barge-ins per 10 minutes of Tessaya speaking with nobody else there. */
  readonly falsePer10Min: number;
  /** Share of real interruptions detected within 300 ms of the 120 ms confirmation, by how loud he is over the echo (dB). */
  readonly recall: Readonly<Record<string, number>>;
  readonly secondsPlayed: number;
}

export type Room = readonly [delayMs: number, rt60Ms: number];

const ROOMS: ReadonlyArray<Room> = [
  [140, 250],
  [90, 400],
  [200, 180],
];

/** The measurement behind docs/baton/BARGE_IN.md: the same rooms and levels every run. */
export const evaluateGuard = async (
  input: {
    readonly seconds?: number;
    readonly levelsDb?: ReadonlyArray<number>;
    readonly rooms?: ReadonlyArray<Room>;
    /** How long after he starts a detection still counts (default: 300 ms and the 120 ms confirmation). */
    readonly windowS?: number;
    readonly source?: VoiceSource;
    readonly run?: (scenario: EchoScenario) => EchoRun | Promise<EchoRun>;
  } = {},
): Promise<GuardEvaluation> => {
  const seconds = input.seconds ?? 60;
  const rooms = input.rooms ?? ROOMS;
  const voice = input.source ?? speechLike;
  const withSource = input.source === undefined ? {} : { source: input.source };
  const runIt = input.run ?? ((scenario: EchoScenario) => runEcho({ ...scenario, frames: 6 }));
  let alarms = 0;
  let played = 0;
  for (const [i, [delay, rt60]] of rooms.entries()) {
    const tts = voice(seconds, 11 + i, 105 + i * 8);
    const run = await runIt({ tts, seed: 5 + i, unknownDelayMs: delay, rt60Ms: rt60, echoRms: 0.07, noiseRms: 0.003, interruptions: [], ...withSource });
    alarms += run.detections.length;
    played += run.seconds;
  }
  const recall: Record<string, number> = {};
  for (const db of input.levelsDb ?? [-6, 0, 6]) {
    let hit = 0;
    let total = 0;
    for (const [i, [delay, rt60]] of rooms.entries()) {
      const tts = voice(seconds, 11 + i, 105 + i * 8);
      const interruptions = Array.from({ length: Math.floor((seconds - 12) / 6.5) }, (_, k) => ({ atS: 8 + k * 6.5, seconds: 1.5, overEchoDb: db, pitchHz: 170 + k * 12 }));
      const run = await runIt({ tts, seed: 5 + i, unknownDelayMs: delay, rt60Ms: rt60, echoRms: 0.07, noiseRms: 0.003, interruptions, ...withSource });
      for (const it of interruptions) {
        total += 1;
        if (run.detections.some((t) => t >= it.atS && t <= it.atS + (input.windowS ?? 0.3 + 6 * 0.02))) hit += 1;
      }
    }
    recall[String(db)] = Math.round((hit / total) * 100) / 100;
  }
  return { falsePer10Min: Math.round((alarms / played) * 6_000) / 10, recall, secondsPlayed: played };
};
