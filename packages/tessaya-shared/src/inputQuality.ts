/**
 * How his sound came in, the way a person on a call notices "you're breaking up" (Director, 18 Nov): one pass over a
 * turn's 16 kHz audio for level, floor, clipping, gaps and high-frequency share (a first difference, no FFT), judged
 * against his own usual. Every vessel that hears him uses it: the room loop per turn, the server per dictation.
 */
import type { InputQuality, InputVerdict } from "@t3tools/tessaya-contracts";

const FRAME = 320; // 20 ms at 16 kHz
const FULL = 32_440; // -0.08 dBFS
const db = (energy: number) => 10 * Math.log10(energy + 1e-12);

export interface InputBaseline {
  readonly speechDb: number;
  /** First-difference energy over signal energy on the loud frames, dB. */
  readonly brightDb: number;
}

/** His dev-kit room mic, 1,613 wake-capture clips of 17 Nov (medians; tessaya-ops handoffs/tumble-case-mic-2026-11-18). */
export const DEFAULT_BASELINE: InputBaseline = { speechDb: -46.8, brightDb: -13.0 };

export interface InputExtra {
  /** Audio the stream lost (missing frames), ms. */
  readonly missingMs?: number;
  /** Share of the turn her own voice was sounding over (0..1). */
  readonly herOverlap?: number;
  /** Recogniser word confidences (null where it gave none). */
  readonly confidences?: ReadonlyArray<number | null>;
}

/** The raw figures: `brightDb` absolute here, made relative to his baseline by `inputQualityOf`. */
export const measureInput = (pcm: Int16Array | Float32Array, extra: InputExtra = {}) => {
  const scale = pcm instanceof Float32Array ? 32_768 : 1;
  const n = Math.floor(pcm.length / FRAME);
  const energy = new Float64Array(n);
  const diff = new Float64Array(n);
  let clipped = 0;
  // Exact-zero frames between sounded ones; a gated mic's silence before or after him is not lost audio.
  let zeroFrames = 0;
  let zeroRun = 0;
  let prev = n > 0 ? pcm[0]! * scale : 0;
  for (let f = 0; f < n; f += 1) {
    let e = 0;
    let d = 0;
    let zero = true;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i += 1) {
      const x = pcm[i]! * scale;
      if (x >= FULL || x <= -FULL) clipped += 1;
      if (x !== 0) zero = false;
      e += x * x;
      d += (x - prev) * (x - prev);
      prev = x;
    }
    energy[f] = e / FRAME / 32_768 ** 2;
    diff[f] = d / FRAME / 32_768 ** 2;
    if (zero) zeroRun += 1;
    else {
      if (f > zeroRun) zeroFrames += zeroRun;
      zeroRun = 0;
    }
  }
  const sorted = energy.toSorted();
  const at = (q: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(q * n))]!);
  const loud = at(0.7);
  let le = 0;
  let ld = 0;
  for (let f = 0; f < n; f += 1)
    if (energy[f]! >= loud) {
      le += energy[f]!;
      ld += diff[f]!;
    }
  const scores = (extra.confidences ?? []).flatMap((p) => (p === null ? [] : [p]));
  return {
    speechDb: db(at(0.9)),
    floorDb: db(at(0.1)),
    brightDb: le === 0 ? 0 : db(ld) - db(le),
    clipped: pcm.length === 0 ? 0 : clipped / pcm.length,
    // A run of exact zeros inside a turn is audio the link never delivered.
    gapMs: (extra.missingMs ?? 0) + (zeroFrames * FRAME * 1000) / 16_000,
    herOverlap: extra.herOverlap ?? 0,
    asr: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length,
    seconds: pcm.length / 16_000,
  };
};

const r1 = (x: number) => Math.round(x * 10) / 10;

/** One turn's verdict and its plain cause, the worst problem first. */
export const inputQualityOf = (
  m: ReturnType<typeof measureInput>,
  baseline: InputBaseline = DEFAULT_BASELINE,
): InputQuality => {
  const bright = m.brightDb - baseline.brightDb;
  const snr = m.speechDb - m.floorDb;
  const unsure = m.asr !== null && m.asr < 0.5;
  const judged = ((): readonly [InputVerdict, string] => {
    if (m.gapMs >= 250 || (m.seconds > 0 && m.gapMs / 1000 / m.seconds >= 0.08))
      return ["breaking up", `${Math.round(m.gapMs)} ms of the audio never arrived`];
    if (m.herOverlap >= 0.5)
      return ["echo", `my own voice was playing over ${Math.round(m.herOverlap * 100)}% of it`];
    if (m.speechDb < baseline.speechDb - 15)
      return [
        "quiet",
        `the voice came in ${Math.round(baseline.speechDb - m.speechDb)} dB quieter than usual`,
      ];
    if (m.clipped >= 0.002) return ["noisy", "it was so loud the mic clipped"];
    if (snr < 8)
      return [
        "noisy",
        `background noise nearly as loud as the voice (${Math.round(snr)} dB apart)`,
      ];
    if (bright <= (unsure ? -4 : -6))
      return [
        "muffled",
        `the high frequencies are ${Math.round(-bright)} dB below usual, as if the mic is covered`,
      ];
    return ["good", ""];
  })();
  return {
    verdict: judged[0],
    cause: judged[1],
    speechDb: r1(m.speechDb),
    floorDb: r1(m.floorDb),
    brightDb: r1(bright),
    clipped: Math.round(m.clipped * 10_000) / 10_000,
    gapMs: Math.round(m.gapMs),
    herOverlap: Math.round(m.herOverlap * 100) / 100,
    asr: m.asr === null ? null : Math.round(m.asr * 100) / 100,
  };
};

/** One short line for her turn, only when the sound was not good: she may mention it the way a person would. */
export const inputLine = (q: InputQuality | undefined): string =>
  q === undefined || q.verdict === "good"
    ? ""
    : `Their sound this turn came in ${q.verdict} (${q.cause}), so these words may be misheard. Say so first, in a few words of your own (how they sound, and what may help). If the words do not make clear sense, ask them to say it again and do not answer or act on them.`;

const KEEP = 20;
const LEARN_AFTER = 5;

/**
 * Each speaker's usual, from their good turns: the median of the last 20, the default until 5 are in.
 * shortcut: kept in memory per process, so a restart starts from the default again; persist it if that proves slow.
 */
export const createInputBaselines = (fallback: InputBaseline = DEFAULT_BASELINE) => {
  const seen = new Map<string, Array<InputBaseline>>();
  const median = (xs: ReadonlyArray<number>) => xs.toSorted((a, b) => a - b)[xs.length >> 1]!;
  return {
    of: (who: string | null): InputBaseline => {
      const xs = who === null ? undefined : seen.get(who);
      return xs === undefined || xs.length < LEARN_AFTER
        ? fallback
        : {
            speechDb: median(xs.map((x) => x.speechDb)),
            brightDb: median(xs.map((x) => x.brightDb)),
          };
    },
    /** A verified turn of theirs that measured good teaches their usual. */
    learn: (who: string, m: ReturnType<typeof measureInput>) => {
      const xs = seen.get(who) ?? [];
      seen.set(who, [...xs, { speechDb: m.speechDb, brightDb: m.brightDb }].slice(-KEEP));
    },
  };
};
