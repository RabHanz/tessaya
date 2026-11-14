/**
 * Hears him talking over Tessaya: her exact playback is the reference, the room's echo path is learned per band in the
 * power domain (robust to a small speaker's distortion and to the device's own partial echo cancelling), and speech is
 * what rises well above the echo that playback predicts. A detector, not a cleaner. Timelines are 16 kHz sample indices.
 */
import type { EchoGuard } from "./echoGuard.ts";
import { spectrum512 } from "./fbank.ts";
import { speechLevel } from "./room/audio.ts";

const FFT = 512;
const HOP = 256; // 16 ms
const RING = 16_000 * 8;
const HISTORY = 64; // hops of reference bands kept for the delay search and the tail
/** The room's reverberation as a decay per hop: about 400 ms to fall 60 dB. */
const DECAY = 10 ** (-2.4 / 10);
const RATE_LEARN = 0.05;
/** Log band power over which her playback counts as sounding (about -70 dBFS). */
const REF_LIVE = Math.log(1e-4);
const WINDOW = 16; // 256 ms
const READY_HOPS = 60; // about a second of her
/** About -80 dBFS per band: a digitally silent mic is not a floor anything rises over. */
const NOISE_MIN = 1e-6;
/** Bands 150 Hz to 5 kHz, about a third of an octave each. */
const EDGES = [5, 7, 9, 11, 14, 17, 21, 26, 32, 39, 47, 57, 70, 85, 104, 127, 160];
const BANDS = EDGES.length - 1;
const HANN = Float64Array.from(
  { length: FFT },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT),
);

export interface TalkOverOptions {
  /** How far past the given alignment the echo may still arrive, in ms (the device's own latency). */
  readonly searchMs?: number;
  /** The echo is taken as this much louder than predicted (dB) before anything over it counts. */
  readonly marginDb?: number;
  /** Rise over the predicted echo and noise, across the bands, that counts for a hop (dB). */
  readonly riseDb?: number;
  /** Hops of the last WINDOW (16 ms each) that must rise before it is someone speaking. */
  readonly hold?: number;
}

export interface TalkOverVerdict {
  /** The room is learned: a "no" can be trusted. */
  readonly ready: boolean;
  /** Someone is speaking over her, held long enough to act on. */
  readonly speech: boolean;
  /** This hop's rise over the predicted echo (dB), for tuning. */
  readonly rise: number;
}

export interface TalkOver {
  /** What plays, and the mic sample index at which it starts to sound (before the device's own latency). */
  readonly reference: (pcm: Int16Array, atSample: number) => void;
  /** Mic audio whose first sample is mic sample `atSample`; one verdict per 16 ms hop completed. */
  readonly process: (mic: Int16Array, atSample: number) => ReadonlyArray<TalkOverVerdict>;
  readonly reset: () => void;
  readonly state: () => { readonly latencyMs: number; readonly learned: number };
}

const bandsOf = (spec: Float64Array, out: Float64Array) => {
  for (let b = 0; b < BANDS; b += 1) {
    let e = 0;
    for (let k = EDGES[b]!; k < EDGES[b + 1]!; k += 1) e += spec[k]!;
    out[b] = e / (EDGES[b + 1]! - EDGES[b]!);
  }
};

export const createTalkOver = (options: TalkOverOptions = {}): TalkOver => {
  const searchHops = Math.round((options.searchMs ?? 200) / 16);
  const margin = 10 ** ((options.marginDb ?? 6) / 10);
  const riseDb = options.riseDb ?? 3;
  const need = options.hold ?? 8;
  const recent = new Uint8Array(WINDOW);

  const ref = new Float32Array(RING);
  let refEnd = -1; // one past the last reference sample written
  let refStart = 0;
  const mic = new Float32Array(RING);
  let micEnd = -1;
  let nextHop = -1; // mic sample index where the next hop's frame ends

  const refBands = Array.from({ length: HISTORY }, () => new Float64Array(BANDS));
  const micEnv = new Float64Array(HISTORY * 4);
  const refEnv = new Float64Array(HISTORY * 4);
  let hops = 0;
  let lag = -1;
  const gain = new Float64Array(BANDS);
  const held = new Float64Array(BANDS);
  let learned = 0;
  const noise = new Float64Array(BANDS).fill(1e-3);
  let sinceSearch = 0;
  const frame = new Float64Array(FFT);
  const y = new Float64Array(BANDS);

  const bandsAt = (buf: Float32Array, end: number, out: Float64Array) => {
    for (let i = 0; i < FFT; i += 1) {
      const at = end - FFT + i;
      frame[i] = buf[((at % RING) + RING) % RING]! * HANN[i]!;
    }
    bandsOf(spectrum512(frame), out);
  };
  const refActive = (end: number) => end > refStart && end - FFT < refEnd;

  const search = () => {
    // Band-summed log envelopes of mic and reference over the last ~3 s: the lag where they move together.
    const n = Math.min(hops, micEnv.length) - searchHops;
    if (n < 40) return;
    let best = -1;
    let bestScore = -Infinity;
    for (let d = 0; d <= searchHops; d += 1) {
      // Only where she was playing: his own turn (her silent) says nothing about where her echo lands.
      const live: number[] = [];
      for (let t = 0; t < n; t += 1)
        if (refEnv[(hops - 1 - t - d + micEnv.length * 4) % refEnv.length]! > REF_LIVE)
          live.push(t);
      if (live.length < 40) continue;
      let sm = 0;
      let sr = 0;
      for (const t of live) {
        sm += micEnv[(hops - 1 - t) % micEnv.length]!;
        sr += refEnv[(hops - 1 - t - d + micEnv.length * 4) % refEnv.length]!;
      }
      sm /= live.length;
      sr /= live.length;
      let cov = 0;
      let vm = 0;
      let vr = 0;
      for (const t of live) {
        const m = micEnv[(hops - 1 - t) % micEnv.length]! - sm;
        const r = refEnv[(hops - 1 - t - d + micEnv.length * 4) % refEnv.length]! - sr;
        cov += m * r;
        vm += m * m;
        vr += r * r;
      }
      const score = cov / Math.sqrt(vm * vr + 1e-12);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    if (bestScore > 0.3 && Math.max(0, best - 1) !== lag) {
      // One hop early: a frame of her that arrives before the predicted one would read as someone else.
      lag = Math.max(0, best - 1);
      gain.fill(0);
      learned = 0;
    }
  };

  const hop = (end: number): TalkOverVerdict => {
    bandsAt(mic, end, y);
    const xb = refBands[hops % HISTORY]!;
    if (refActive(end)) bandsAt(ref, end, xb);
    else xb.fill(0);
    let ys = 0;
    let xs = 0;
    for (let b = 0; b < BANDS; b += 1) {
      ys += y[b]!;
      xs += xb[b]!;
    }
    micEnv[hops % micEnv.length] = Math.log(ys + 1e-9);
    refEnv[hops % refEnv.length] = Math.log(xs + 1e-9);
    hops += 1;
    sinceSearch += 1;
    if (lag < 0 || (sinceSearch >= 30 && learned < 60)) {
      sinceSearch = 0;
      search();
    }

    // Predicted echo per band: what played (the louder of the two hops around the delay), held with the room's decay,
    // times the band's learned gain. A level model, not a filter, so a distorting speaker and a partial device AEC fit.
    const pe = new Float64Array(BANDS);
    let xActive = 0;
    if (lag >= 0) {
      const x0 = refBands[(hops - 1 - lag + HISTORY * 4) % HISTORY]!;
      const x1 = refBands[(hops - 2 - lag + HISTORY * 4) % HISTORY]!;
      for (let b = 0; b < BANDS; b += 1) {
        held[b] = Math.max(x0[b]!, x1[b]!, DECAY * held[b]!);
        pe[b] = gain[b]! * held[b]!;
        xActive += x0[b]!;
      }
    }
    // How far the mic rises over the echo playback predicts plus the room's noise, across the bands (dB).
    let ys2 = 0;
    let floor = 0;
    for (let b = 0; b < BANDS; b += 1) {
      ys2 += y[b]!;
      floor += margin * pe[b]! + 4 * noise[b]!;
    }
    const rise = 10 * Math.log10(ys2 / floor);
    const ready = learned >= READY_HOPS;
    recent[hops % WINDOW] = ready && rise >= riseDb ? 1 : 0;
    let count = 0;
    for (const r of recent) count += r;

    // Learn each band's gain from her alone (log domain, so loud and quiet moments weigh alike): always while new, then
    // only when nothing rises over the prediction.
    // Only while she is plainly sounding: a near-silent reference makes any voice look like a huge echo gain.
    if (lag >= 0 && Math.log(xActive + 1e-30) > REF_LIVE && (!ready || rise < riseDb)) {
      for (let b = 0; b < BANDS; b += 1) {
        if (held[b]! <= 0 || y[b]! < 4 * noise[b]!) continue;
        // Bounded: one hop moves a band's gain by at most 10%, so a word of his slipping through cannot lift the echo.
        const step = Math.max(
          -2,
          Math.min(2, Math.log(y[b]! / held[b]!) - Math.log(gain[b]! + 1e-30)),
        );
        gain[b] = gain[b] === 0 ? y[b]! / held[b]! : gain[b]! * Math.exp(RATE_LEARN * step);
      }
      learned += 1;
    }
    // The noise floor: a slow minimum of what the mic hears.
    for (let b = 0; b < BANDS; b += 1)
      noise[b] = Math.max(
        NOISE_MIN,
        y[b]! < noise[b]! ? 0.7 * noise[b]! + 0.3 * y[b]! : noise[b]! * 1.002,
      );
    return { ready, speech: count >= need, rise };
  };

  /** A new session's frames count from zero again: start the timeline over, keeping what was learned of the room. */
  const follow = (atSample: number) => {
    if (micEnd < 0 || (atSample >= micEnd - FFT && atSample <= micEnd + RING)) return;
    ref.fill(0);
    mic.fill(0);
    refEnd = -1;
    micEnd = -1;
    nextHop = -1;
    held.fill(0);
    recent.fill(0);
    for (const x of refBands) x.fill(0);
  };

  return {
    reference: (pcm, atSample) => {
      follow(atSample);
      if (refEnd < 0 || atSample - refEnd >= RING) refStart = atSample;
      else for (let i = refEnd; i < atSample; i += 1) ref[i % RING] = 0;
      for (let i = 0; i < pcm.length; i += 1) ref[(atSample + i) % RING] = pcm[i]! / 32768;
      refEnd = Math.max(refEnd, atSample + pcm.length);
    },
    process: (pcm, atSample) => {
      follow(atSample);
      for (let i = 0; i < pcm.length; i += 1) mic[(atSample + i) % RING] = pcm[i]! / 32768;
      micEnd = atSample + pcm.length;
      if (nextHop < 0) nextHop = atSample + FFT;
      const out: TalkOverVerdict[] = [];
      for (; nextHop <= micEnd; nextHop += HOP) out.push(hop(nextHop));
      return out;
    },
    reset: () => {
      follow(Number.NEGATIVE_INFINITY);
      lag = -1;
      gain.fill(0);
      learned = 0;
    },
    state: () => ({ latencyMs: lag * 16, learned }),
  };
};

/**
 * The desktop's shape for it (the player's chunks timed in ms, mic frames in ms): the same detector behind the
 * `EchoGuard` interface the voice core already drives. `nearEnd` is the held decision, so the core's own run counts on top.
 */
export const createTalkOverGuard = (options: TalkOverOptions = {}): EchoGuard => {
  const talk = createTalkOver({ searchMs: 600, ...options });
  let micAt = -1;
  let last: TalkOverVerdict = { ready: false, speech: false, rise: 0 };
  return {
    reference: (pcm, soundsAtMs) => talk.reference(pcm, Math.round(soundsAtMs * 16)),
    process: (mic, atMs) => {
      // `atMs` is when the frame ended; keep the sample timeline gapless between frames that arrive back to back.
      const at = Math.round(atMs * 16) - mic.length;
      micAt = micAt >= 0 && Math.abs(at - micAt) < 800 ? micAt : at;
      for (const v of talk.process(mic, micAt)) last = v;
      micAt += mic.length;
      return { ready: last.ready, nearEnd: last.ready && last.speech, erleDb: 0 };
    },
    reset: () => {
      talk.reset();
      micAt = -1;
    },
    state: () => ({
      delayMs: talk.state().latencyMs,
      erleDb: 0,
      converged: talk.state().learned >= READY_HOPS,
    }),
  };
};

/**
 * A voice over her must stand this far above the room's loud moments: a TV or music already playing is not him. In a
 * quiet room the floor decides; over a TV he raises his voice a little, as he would for a person.
 */
const OVER_ROOM_DB = 10;

/**
 * How loud the mic is now (its last 240 ms) against how loud the room has been (its loud moments in the 3 s before), so a
 * cut-in is a voice that rises out of the room, not a TV or music that was already on.
 */
export const createRoomLevel = (minDbfs: number, overRoomDb = OVER_ROOM_DB) => {
  const levels: number[] = [];
  let recent = new Int16Array(0);
  return {
    push: (pcm: Int16Array) => {
      let sum = 0;
      for (const v of pcm) sum += v * v;
      levels.push(10 * Math.log10(sum / Math.max(1, pcm.length) / 32768 ** 2 + 1e-12));
      if (levels.length > 55) levels.shift();
      const kept = recent.subarray(Math.max(0, recent.length - 3 * pcm.length));
      recent = new Int16Array(kept.length + pcm.length);
      recent.set(kept);
      recent.set(pcm, kept.length);
    },
    /** Loud enough to be someone talking to her, over the floor given and over the room as it has been. */
    rises: (floorDbfs = minDbfs): boolean => {
      const before = levels.slice(0, -5).sort((a, b) => a - b);
      // The room's loud moments, not its average: a TV's speech has pauses, and its peaks are what would pass.
      const room =
        before.length < 20 ? Number.NEGATIVE_INFINITY : before[Math.floor(before.length * 0.9)]!;
      return speechLevel(recent) >= Math.max(floorDbfs, room + overRoomDb);
    },
  };
};
