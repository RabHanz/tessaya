/**
 * Her mouth shapes from what she says, timed by the sound she plays: the reply's text gives the sequence of visemes
 * (which shape, in which order) and a forced alignment against the audio's loudness and hiss gives when. A loudness
 * classifier alone flaps open and shut on every syllable; the text knows where the lips really close (M, B, P), where
 * the teeth meet the lip (F, V) and where they round (O, OO, W). Names match the Character Studio's TCS.VISEMES.
 */

export type Viseme =
  | "rest"
  | "mbp"
  | "fv"
  | "th"
  | "l"
  | "ee"
  | "aa"
  | "uh"
  | "oh"
  | "oo"
  | "sh"
  | "er"
  | "etc";

/** How a sound looks to the aligner: vowel-like (loud, voiced), nasal hum, lip or tongue closure, hiss, other consonant, pause. */
type Kind = "V" | "N" | "B" | "F" | "C" | "P";

export interface SpeechUnit {
  readonly viseme: Viseme;
  readonly kind: Kind;
  /** A pause the audio may not have, and what leaving it out costs: nothing between words, a lot at a full stop. */
  readonly skip?: number;
}

const RULES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [Viseme, Kind]>]> = [
  [
    "tion",
    [
      ["sh", "F"],
      ["uh", "V"],
      ["etc", "N"],
    ],
  ],
  ["ough", [["oh", "V"]]],
  ["augh", [["oh", "V"]]],
  [
    "igh",
    [
      ["aa", "V"],
      ["ee", "V"],
    ],
  ],
  ["eigh", [["ee", "V"]]],
  ["th", [["th", "F"]]],
  ["sh", [["sh", "F"]]],
  ["ch", [["sh", "F"]]],
  ["ph", [["fv", "F"]]],
  ["wh", [["oo", "V"]]],
  ["wr", [["er", "V"]]],
  ["kn", [["etc", "N"]]],
  [
    "qu",
    [
      ["etc", "C"],
      ["oo", "V"],
    ],
  ],
  ["ck", [["etc", "C"]]],
  ["ng", [["etc", "N"]]],
  ["gh", []],
  ["ee", [["ee", "V"]]],
  ["ea", [["ee", "V"]]],
  ["ie", [["ee", "V"]]],
  ["ey", [["ee", "V"]]],
  ["oo", [["oo", "V"]]],
  ["ew", [["oo", "V"]]],
  ["ue", [["oo", "V"]]],
  [
    "ou",
    [
      ["aa", "V"],
      ["oo", "V"],
    ],
  ],
  [
    "ow",
    [
      ["oh", "V"],
      ["oo", "V"],
    ],
  ],
  [
    "oi",
    [
      ["oh", "V"],
      ["ee", "V"],
    ],
  ],
  [
    "oy",
    [
      ["oh", "V"],
      ["ee", "V"],
    ],
  ],
  [
    "ai",
    [
      ["aa", "V"],
      ["ee", "V"],
    ],
  ],
  [
    "ay",
    [
      ["aa", "V"],
      ["ee", "V"],
    ],
  ],
  ["oa", [["oh", "V"]]],
  ["au", [["oh", "V"]]],
  ["aw", [["oh", "V"]]],
  ["er", [["er", "V"]]],
  ["ir", [["er", "V"]]],
  ["ur", [["er", "V"]]],
  [
    "or",
    [
      ["oh", "V"],
      ["er", "V"],
    ],
  ],
  [
    "ar",
    [
      ["aa", "V"],
      ["er", "V"],
    ],
  ],
];

const ONE: Readonly<Record<string, readonly [Viseme, Kind]>> = {
  a: ["aa", "V"],
  e: ["ee", "V"],
  i: ["ee", "V"],
  o: ["oh", "V"],
  u: ["uh", "V"],
  y: ["ee", "V"],
  b: ["mbp", "B"],
  m: ["mbp", "N"],
  p: ["mbp", "B"],
  f: ["fv", "F"],
  v: ["fv", "F"],
  l: ["l", "C"],
  r: ["er", "V"],
  w: ["oo", "V"],
  j: ["sh", "F"],
  g: ["etc", "C"],
  c: ["etc", "C"],
  d: ["etc", "C"],
  k: ["etc", "C"],
  t: ["etc", "C"],
  n: ["etc", "N"],
  q: ["etc", "C"],
  s: ["etc", "F"],
  x: ["etc", "F"],
  z: ["etc", "F"],
};

const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** One word's visemes, from its spelling (a light letter-to-sound pass; English only). */
export const wordUnits = (word: string): SpeechUnit[] => {
  let w = word
    .toLowerCase()
    .replace(/\d/g, (d) => NUMBERS[Number(d)]!)
    .replace(/[^a-z]/g, "")
    .replace(/([^aeiou])\1+/g, "$1");
  // a silent e after one vowel and one consonant (make, these), not after a vowel pair (maybe)
  w = w.replace(/(^|[^aeiouy])([aeiou][^aeiouy])e$/, "$1$2").replace(/mb$/, "m");
  const out: SpeechUnit[] = [];
  for (let i = 0; i < w.length;) {
    // a soft c is an s, and an h after a consonant or at the start only breathes into the next vowel
    if (w[i] === "c" && /[eiy]/.test(w[i + 1] ?? "")) {
      out.push({ viseme: "etc", kind: "F" });
      i++;
      continue;
    }
    if (w[i] === "h") {
      i++;
      continue;
    }
    const rule = RULES.find(([g]) => w.startsWith(g, i));
    if (rule !== undefined) {
      for (const [viseme, kind] of rule[1]) out.push({ viseme, kind });
      i += rule[0].length;
    } else {
      const one = ONE[w[i]!];
      if (one !== undefined) out.push({ viseme: one[0], kind: one[1] });
      i++;
    }
  }
  return out.filter(
    (u, i) => i === 0 || u.viseme !== out[i - 1]!.viseme || u.kind !== out[i - 1]!.kind,
  );
};

/** A sentence's visemes in order, with a pause the audio may have between words and a likely one at punctuation. */
export const speechUnits = (text: string): SpeechUnit[] => {
  const out: SpeechUnit[] = [{ viseme: "rest", kind: "P", skip: 0 }];
  for (const token of text.match(/[^\s]+/g) ?? []) {
    const units = wordUnits(token);
    if (units.length === 0) continue;
    const skip = /[.!?…;:]["')\]]*$/.test(token) ? 8 : /[,—–-]["')\]]*$/.test(token) ? 3 : 0;
    out.push(...units, { viseme: "rest", kind: "P", skip });
  }
  return out;
};

/** The aligner reads the sound in frames this long. */
export const ALIGN_HOP_MS = 10;

export interface SoundFrame {
  readonly rms: number;
  readonly zcr: number;
}

/** 16-bit mono samples in ALIGN_HOP_MS frames: loudness and how often the wave crosses zero (hiss). */
export const soundFrames = (samples: Int16Array, rate: number): SoundFrame[] => {
  const step = Math.max(1, Math.round((rate * ALIGN_HOP_MS) / 1000));
  const frames: SoundFrame[] = [];
  for (let at = 0; at + step <= samples.length; at += step) {
    let sum = 0;
    let crossings = 0;
    for (let i = at; i < at + step; i++) {
      const v = samples[i]! / 32768;
      sum += v * v;
      if (i > at && samples[i]! >= 0 !== samples[i - 1]! >= 0) crossings++;
    }
    frames.push({ rms: Math.sqrt(sum / step), zcr: crossings / step });
  }
  return frames;
};

const KINDS: ReadonlyArray<Kind> = ["V", "N", "B", "F", "C", "P"];

/** What each kind costs on a frame: loudness `en` (0 silent, 1 the loudest near it) and hiss `z`. Lower is likelier. */
const emission = (kind: Kind, en: number, z: number): number => {
  const hiss = Math.min(1, z / 0.25);
  // a hum (m, n) has its energy low down: it crosses zero less often than an open vowel
  const hum = Math.min(1, Math.max(0, (0.04 - z) / 0.02));
  switch (kind) {
    case "P":
      return 10 * en * en;
    case "B":
      // a closure is near silence, but a silence long enough to see is a pause
      return 0.5 + 6 * en * en + Math.max(0, hiss - 0.5);
    case "V":
      return 5 * (1 - en) ** 2 + 3 * Math.max(0, hiss - 0.5) + 1.5 * hum;
    case "N":
      return 2 * (en - 0.6) ** 2 + 2 * Math.max(0, hiss - 0.4) + 1.5 * (1 - hum);
    case "F":
      return 3 * (1 - hiss) ** 2 + (en - 0.55) ** 2;
    case "C":
      return 0.3 + 2 * (en - 0.55) ** 2;
  }
};

/**
 * How long each kind lasts, in frames: at least `min`, usually at most `max`, and what each frame past `max` costs.
 * A hum can be held ("Mmm"), a pause can be any length, a stop or a T is brief.
 */
const DURATION: Readonly<Record<Kind, { min: number; max: number; stay: number }>> = {
  V: { min: 3, max: 20, stay: 0.3 },
  N: { min: 2, max: 20, stay: 0.02 },
  B: { min: 2, max: 10, stay: 1 },
  F: { min: 2, max: 15, stay: 0.3 },
  C: { min: 1, max: 10, stay: 1 },
  P: { min: 2, max: 2, stay: 0 },
};

export interface VisemeSegment {
  /** ms from the first sample of the sentence. */
  readonly at: number;
  readonly end: number;
  readonly viseme: Viseme;
}

/**
 * Forced alignment: the units in order over the frames, a Viterbi path through a left-to-right chain where each
 * unit is a run of states as long as its longest likely duration. `done` false means the audio so far may cover
 * only the start of the text, so the path may end anywhere.
 */
export const alignVisemes = (
  units: ReadonlyArray<SpeechUnit>,
  frames: ReadonlyArray<SoundFrame>,
  done: boolean,
): VisemeSegment[] => {
  const T = frames.length;
  const U = units.length;
  if (T === 0 || U === 0) return [];
  let peak = 1e-4;
  for (const f of frames) peak = Math.max(peak, f.rms);
  // loudness in dB below the loudest within a syllable either side (an unstressed vowel is still a vowel), 0 at
  // -40 dB; a silence stays silent against her whole sentence
  const en = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let near = peak * 0.03;
    for (let i = Math.max(0, t - 15); i < Math.min(T, t + 15); i++)
      near = Math.max(near, frames[i]!.rms);
    en[t] = Math.min(1, Math.max(0, 1 + (20 * Math.log10(frames[t]!.rms / near + 1e-9)) / 40));
  }
  const first = new Int32Array(U + 1);
  for (let u = 0; u < U; u++) first[u + 1] = first[u]! + DURATION[units[u]!.kind].max;
  const S = first[U]!;
  const unitOf = new Int32Array(S);
  const kindOf = new Int32Array(S);
  for (let u = 0; u < U; u++)
    for (let s = first[u]!; s < first[u + 1]!; s++) {
      unitOf[s] = u;
      kindOf[s] = KINDS.indexOf(units[u]!.kind);
    }
  // where a unit may go next: the one after it, or past a pause that can be left out, at that pause's cost
  const skipCost = (u: number) =>
    u < U && units[u]!.skip !== undefined ? units[u]!.skip! : Infinity;
  let cost = new Float64Array(S).fill(Infinity);
  let next = new Float64Array(S);
  const back = new Int32Array(T * S);
  const enter = (s: number, value: number, from: number, row: number) => {
    if (value < next[s]!) {
      next[s] = value;
      back[row + s] = from;
    }
  };
  const em = new Float64Array(KINDS.length);
  for (let t = 0; t < T; t++) {
    next.fill(Infinity);
    const row = t * S;
    if (t === 0) {
      enter(0, 0, -1, row);
      if (U > 1) enter(first[1]!, skipCost(0), -1, row);
    } else
      for (let s = 0; s < S; s++) {
        const c = cost[s]!;
        if (c === Infinity) continue;
        const u = unitOf[s]!;
        const d = DURATION[units[u]!.kind];
        if (s === first[u + 1]! - 1) enter(s, c + d.stay, s, row);
        else enter(s + 1, c, s, row);
        if (s - first[u]! + 1 < d.min || u + 1 >= U) continue;
        enter(first[u + 1]!, c, s, row);
        if (u + 2 < U) enter(first[u + 2]!, c + skipCost(u + 1), s, row);
      }
    for (let k = 0; k < KINDS.length; k++) em[k] = emission(KINDS[k]!, en[t]!, frames[t]!.zcr);
    for (let s = 0; s < S; s++) {
      const v = next[s]!;
      if (v !== Infinity) next[s] = v + em[kindOf[s]!]!;
    }
    [cost, next] = [next, cost];
  }
  // the end: when the sound is all here it ends in the last unit (or the pause before it); otherwise anywhere
  const canEnd = (s: number) => {
    const u = unitOf[s]!;
    if (!done) return true;
    if (s - first[u]! + 1 < DURATION[units[u]!.kind].min) return false;
    return u === U - 1 || (u === U - 2 && skipCost(U - 1) < Infinity);
  };
  let end = -1;
  for (let s = 0; s < S; s++)
    if (cost[s]! < Infinity && canEnd(s) && (end < 0 || cost[s]! < cost[end]!)) end = s;
  if (end < 0) return [];
  const out: VisemeSegment[] = [];
  for (let t = T - 1, s = end; t >= 0; t--) {
    const viseme = units[unitOf[s]!]!.viseme;
    const head = out[0];
    if (head !== undefined && head.viseme === viseme) out[0] = { ...head, at: t * ALIGN_HOP_MS };
    else out.unshift({ at: t * ALIGN_HOP_MS, end: (t + 1) * ALIGN_HOP_MS, viseme });
    s = back[t * S + s]!;
  }
  return out;
};

/** Closed lips must read on screen even when the sound's closure is short: at least this long, taken from before it. */
export const CLOSURE_MS = 80;

export const holdClosures = (track: ReadonlyArray<VisemeSegment>): VisemeSegment[] => {
  const out = track.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!;
    if (s.viseme !== "mbp" || s.end - s.at >= CLOSURE_MS) continue;
    let at = s.end - CLOSURE_MS;
    // the lips close ahead of the sound, taking the time from the shapes before it
    for (let j = i - 1; j >= 0 && at < out[j]!.end; j--) {
      const p = out[j]!;
      const keep = Math.min(p.end, Math.max(p.at, at));
      if (keep === p.at) at = p.at;
      p.end = keep;
      if (p.at < at) break;
    }
    s.at = Math.max(0, at);
  }
  return out.filter((s) => s.end > s.at);
};

/** The shape at `ms`, or undefined past the track. */
export const visemeAt = (track: ReadonlyArray<VisemeSegment>, ms: number): Viseme | undefined => {
  let lo = 0;
  let hi = track.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = track[mid]!;
    if (ms < s.at) hi = mid - 1;
    else if (ms >= s.end) lo = mid + 1;
    else return s.viseme;
  }
  return undefined;
};

/** The aligner trusts the end of the sound only once this much more has arrived, or the sentence has ended. */
export const TRUST_MS = 150;

/**
 * One sentence's mouth shapes as its audio streams in: push samples as they arrive, ask for the shape at any ms.
 * Before the alignment can say (the first moments, or audio not yet here) `at` returns undefined and the caller's
 * loudness classifier stands in.
 */
export const createVisemeTrack = (text: string, rate: number) => {
  const units = speechUnits(text);
  const frames: SoundFrame[] = [];
  let pending = new Int16Array(0);
  let track: VisemeSegment[] = [];
  let trusted = 0;
  let alignedAt = 0;
  const align = (done: boolean) => {
    track = holdClosures(alignVisemes(units, frames, done));
    trusted = done ? Infinity : frames.length * ALIGN_HOP_MS - TRUST_MS;
    alignedAt = frames.length;
  };
  return {
    push: (samples: Int16Array) => {
      if (units.length <= 1) return;
      const all = new Int16Array(pending.length + samples.length);
      all.set(pending);
      all.set(samples, pending.length);
      const step = Math.round((rate * ALIGN_HOP_MS) / 1000);
      const whole = all.length - (all.length % step);
      frames.push(...soundFrames(all.subarray(0, whole), rate));
      pending = all.slice(whole);
      // realigning is a few ms; doing it at most every 200 ms of new sound keeps the main process light
      if ((frames.length - alignedAt) * ALIGN_HOP_MS >= 200) align(false);
    },
    end: () => {
      if (units.length > 1 && frames.length > 0) align(true);
    },
    at: (ms: number): Viseme | undefined => (ms < trusted ? visemeAt(track, ms) : undefined),
  };
};
