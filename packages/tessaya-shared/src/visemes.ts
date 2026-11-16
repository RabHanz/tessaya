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

/**
 * How a sound looks to the aligner: vowel-like (loud, voiced), the short glide that ends a diphthong (the OO of "ow"),
 * nasal, a hummed "Mmm" (lips shut however long it lasts),
 * lip or tongue closure, hiss, other consonant, pause.
 */
type Kind = "V" | "G" | "N" | "H" | "B" | "F" | "C" | "P";

export interface SpeechUnit {
  readonly viseme: Viseme;
  readonly kind: Kind;
  /** A pause the audio may not have, and what leaving it out costs: nothing between words, a lot at a full stop. */
  readonly skip?: number;
  /** Which word of the text (its whitespace-split index) this unit is part of; none for a pause. */
  readonly word?: number;
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
      ["ee", "G"],
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
      ["oo", "G"],
    ],
  ],
  [
    "ow",
    [
      ["oh", "V"],
      ["oo", "G"],
    ],
  ],
  [
    "oi",
    [
      ["oh", "V"],
      ["ee", "G"],
    ],
  ],
  [
    "oy",
    [
      ["oh", "V"],
      ["ee", "G"],
    ],
  ],
  [
    "ai",
    [
      ["aa", "V"],
      ["ee", "G"],
    ],
  ],
  [
    "ay",
    [
      ["aa", "V"],
      ["ee", "G"],
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
  w: ["oo", "C"],
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
  // hums said with the lips shut: "Mmm", "Hmm", "Mm-hmm", "Mhm", "Mmmh", and the hum at the end of "Umm" and "Erm"
  const said = word.toLowerCase().replace(/[^a-z]/g, "");
  const hum: SpeechUnit = { viseme: "mbp", kind: "H" };
  if (said.length > 1 && /^[hm]*m[hm]*$/.test(said)) return [hum];
  if (/^u+m+$/.test(said)) return [{ viseme: "uh", kind: "V" }, hum];
  if (/^e+r+m+$/.test(said)) return [{ viseme: "er", kind: "V" }, hum];
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
  for (const [word, token] of (text.match(/[^\s]+/g) ?? []).entries()) {
    const units = wordUnits(token);
    if (units.length === 0) continue;
    const skip = /[.!?…;:]["')\]]*$/.test(token) ? 8 : /[,—–-]["')\]]*$/.test(token) ? 3 : 0;
    out.push(...units.map((u) => ({ ...u, word })), { viseme: "rest", kind: "P", skip });
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

const KINDS: ReadonlyArray<Kind> = ["V", "G", "N", "H", "B", "F", "C", "P"];

/** What each kind costs on a frame: loudness `en` (0 silent, 1 the loudest near it) and hiss `z`. Lower is likelier. */
const emission = (kind: Kind, en: number, z: number): number => {
  const hiss = Math.min(1, z / 0.25);
  // a hum (m, n) has its energy low down: it crosses zero less often than an open vowel
  const hum = Math.min(1, Math.max(0, (0.04 - z) / 0.02));
  switch (kind) {
    case "P":
      return 10 * en * en;
    case "H":
      // voiced and low: loud enough to be her voice, and not crossing zero like an open vowel
      return 1.5 * (1 - hum) + 4 * Math.max(0, 0.55 - en) ** 2 + 2 * Math.max(0, hiss - 0.4);
    case "B":
      // a closure is a dip: a voiced B in "maybe" is only 12 to 18 dB under the vowels beside it. A silence long enough
      // to see is a pause, which its duration limit leaves to "P".
      return 0.5 + 8 * Math.max(0, en - 0.5) ** 2 + Math.max(0, hiss - 0.5);
    case "V":
    case "G":
      return 5 * (1 - en) ** 2 + 3 * Math.max(0, hiss - 0.5) + 0.5 * hum;
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
  V: { min: 3, max: 20, stay: 0.1 },
  G: { min: 2, max: 8, stay: 1 },
  H: { min: 3, max: 3, stay: 0 },
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
  /** A hum: shut lips the alignment can be sure of before the sound around it has all arrived. */
  readonly hum?: boolean;
}

/** Loudness is read against the loudest sound this far back and ahead (frames): a syllable either side, less ahead. */
const NEAR_BACK = 15;
const NEAR_AHEAD = 8;
/** Below this (about -40 dBFS) a sound is quiet whatever is near it: silence never counts as her loudest. */
const NEAR_FLOOR = 0.01;

/**
 * Forced alignment that keeps up with the sound: the units in order, a Viterbi path through a left-to-right chain where
 * each unit is a run of states as long as its longest likely duration, one step per frame as frames arrive. A frame is
 * stepped once NEAR_AHEAD frames after it are here (or the sound has ended).
 */
export const createAligner = (units: ReadonlyArray<SpeechUnit>) => {
  const U = units.length;
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
  const frames: SoundFrame[] = [];
  const back: Int32Array[] = [];
  let cost = new Float64Array(S).fill(Infinity);
  let next = new Float64Array(S);
  const em = new Float64Array(KINDS.length);
  const step = (t: number) => {
    let near = NEAR_FLOOR;
    for (let i = Math.max(0, t - NEAR_BACK); i <= Math.min(frames.length - 1, t + NEAR_AHEAD); i++)
      near = Math.max(near, frames[i]!.rms);
    const en = Math.min(1, Math.max(0, 1 + (20 * Math.log10(frames[t]!.rms / near + 1e-9)) / 40));
    const row = new Int32Array(S);
    back.push(row);
    next.fill(Infinity);
    const enter = (s: number, value: number, from: number) => {
      if (value < next[s]!) {
        next[s] = value;
        row[s] = from;
      }
    };
    if (t === 0) {
      enter(0, 0, -1);
      if (U > 1) enter(first[1]!, skipCost(0), -1);
    } else
      for (let s = 0; s < S; s++) {
        const c = cost[s]!;
        if (c === Infinity) continue;
        const u = unitOf[s]!;
        const d = DURATION[units[u]!.kind];
        if (s === first[u + 1]! - 1) enter(s, c + d.stay, s);
        else enter(s + 1, c, s);
        if (s - first[u]! + 1 < d.min || u + 1 >= U) continue;
        enter(first[u + 1]!, c, s);
        if (u + 2 < U) enter(first[u + 2]!, c + skipCost(u + 1), s);
      }
    for (let k = 0; k < KINDS.length; k++) em[k] = emission(KINDS[k]!, en, frames[t]!.zcr);
    for (let s = 0; s < S; s++) {
      const v = next[s]!;
      if (v !== Infinity) next[s] = v + em[kindOf[s]!]!;
    }
    [cost, next] = [next, cost];
  };
  let ended = false;
  /** The likeliest path's unit per frame: once the sound has ended it must finish the text, before then anywhere. */
  const trace = (): Int32Array => {
    const T = back.length;
    if (T === 0 || U === 0) return new Int32Array(0);
    const canEnd = (s: number) => {
      const u = unitOf[s]!;
      if (!ended) return true;
      if (s - first[u]! + 1 < DURATION[units[u]!.kind].min) return false;
      return u === U - 1 || (u === U - 2 && skipCost(U - 1) < Infinity);
    };
    let end = -1;
    for (let s = 0; s < S; s++)
      if (cost[s]! < Infinity && canEnd(s) && (end < 0 || cost[s]! < cost[end]!)) end = s;
    if (end < 0) return new Int32Array(0);
    const along = new Int32Array(T);
    for (let t = T - 1, s = end; t >= 0; t--) {
      along[t] = unitOf[s]!;
      s = back[t]![s]!;
    }
    return along;
  };
  const catchUp = () => {
    while (back.length < frames.length && (ended || back.length + NEAR_AHEAD < frames.length))
      step(back.length);
  };
  return {
    push: (more: ReadonlyArray<SoundFrame>) => {
      frames.push(...more);
      if (U > 0) catchUp();
    },
    end: () => {
      ended = true;
      if (U > 0) catchUp();
    },
    /** Frames the path covers so far. */
    stepped: () => back.length,
    /** The likeliest path so far: once the sound has ended it must finish the text, before then it may end anywhere. */
    path: (): VisemeSegment[] => {
      const out: VisemeSegment[] = [];
      const along = trace();
      for (let t = along.length - 1; t >= 0; t--) {
        const unit = units[along[t]!]!;
        const hum = unit.kind === "H" ? { hum: true } : {};
        const head = out[0];
        if (head !== undefined && head.viseme === unit.viseme)
          out[0] = { ...head, ...hum, at: t * ALIGN_HOP_MS };
        else
          out.unshift({
            at: t * ALIGN_HOP_MS,
            end: (t + 1) * ALIGN_HOP_MS,
            viseme: unit.viseme,
            ...hum,
          });
      }
      return out;
    },
    /** The unit each stepped frame is in, on the same likeliest path; empty when there is none yet. */
    units: trace,
  };
};

/** The whole alignment at once. `done` false means the frames may cover only the start of the text. */
export const alignVisemes = (
  units: ReadonlyArray<SpeechUnit>,
  frames: ReadonlyArray<SoundFrame>,
  done: boolean,
): VisemeSegment[] => {
  const aligner = createAligner(units);
  aligner.push(frames);
  if (done) aligner.end();
  return aligner.path();
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
const segmentAt = (track: ReadonlyArray<VisemeSegment>, ms: number): VisemeSegment | undefined => {
  let lo = 0;
  let hi = track.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = track[mid]!;
    if (ms < s.at) hi = mid - 1;
    else if (ms >= s.end) lo = mid + 1;
    else return s;
  }
  return undefined;
};

export const visemeAt = (track: ReadonlyArray<VisemeSegment>, ms: number): Viseme | undefined =>
  segmentAt(track, ms)?.viseme;

/**
 * How far ahead of its sound each shape shows (on top of the jaw's own lead): rounding starts earliest, a closure or
 * teeth on the lip least, since its silence or hiss is already the shape.
 */
const LEAD_MS: Readonly<Record<Viseme, number>> = {
  rest: 40,
  mbp: 20,
  fv: 20,
  th: 20,
  l: 20,
  ee: 40,
  aa: 40,
  uh: 40,
  er: 40,
  etc: 40,
  sh: 60,
  oh: 60,
  oo: 60,
};

/**
 * The shape to show for the sound at `ms`: a closure or contact due now, else the furthest-ahead shape whose lead
 * reaches back to now. A rounding never skips the lips closing before it ("be Bob").
 */
const ledAt = (track: ReadonlyArray<VisemeSegment>, ms: number): Viseme | undefined => {
  for (const lead of [20, 60, 40]) {
    const v = visemeAt(track, ms + lead);
    if (v !== undefined && LEAD_MS[v] === lead) return v;
  }
  return visemeAt(track, ms + 40);
};

/** The end of a path that may still change as more sound arrives: not used until this much more has been stepped. */
export const TRUST_MS = 60;

/**
 * One sentence's mouth shapes as its audio streams in: push samples as they arrive, ask for the shape at the sound's
 * ms (the shape's own lead is added here). Where the alignment cannot say yet, `at` returns undefined and the caller's
 * loudness classifier stands in, except inside a hum, whose lips stay shut from its first frame.
 */
export const createVisemeTrack = (text: string, rate: number) => {
  const units = speechUnits(text);
  const aligner = createAligner(units);
  const step = Math.max(1, Math.round((rate * ALIGN_HOP_MS) / 1000));
  let pending = new Int16Array(0);
  let track: VisemeSegment[] = [];
  let trusted = 0;
  let pathAt = -1;
  let along: Int32Array = new Int32Array(0);
  let alongAt = -2;
  let ended = false;
  const live = units.length > 1;
  // a line that opens with a hum ("Mmm, …") has its lips shut from its first sound, before the path has reached it
  const opensWithHum = units[1]?.kind === "H";
  const refresh = () => {
    if (aligner.stepped() === pathAt) return;
    pathAt = aligner.stepped();
    track = holdClosures(aligner.path());
    trusted = ended ? Infinity : pathAt * ALIGN_HOP_MS - TRUST_MS;
  };
  return {
    push: (samples: Int16Array) => {
      if (!live) return;
      const all = new Int16Array(pending.length + samples.length);
      all.set(pending);
      all.set(samples, pending.length);
      const whole = all.length - (all.length % step);
      aligner.push(soundFrames(all.subarray(0, whole), rate));
      pending = all.slice(whole);
    },
    end: () => {
      if (!live) return;
      ended = true;
      aligner.end();
      pathAt = -1;
      refresh();
    },
    at: (ms: number): Viseme | undefined => {
      if (!live) return undefined;
      refresh();
      if (ms + 60 < trusted) return ledAt(track, ms);
      // a hum the path has reached goes on until the sound says otherwise
      const last = track[track.length - 1];
      const seg = segmentAt(track, ms) ?? (last !== undefined && ms >= last.end ? last : undefined);
      if (seg?.hum === true) return "mbp";
      if (opensWithHum && track.every((s) => s.viseme === "rest" || s.hum === true)) return "mbp";
      return ms < trusted ? visemeAt(track, ms) : undefined;
    },
    /**
     * The word of the text (whitespace-split index) sounding at the sound's ms, once the alignment trusts it there;
     * null for a pause between words (where a spliced sound plays).
     */
    wordAt: (ms: number): number | null | undefined => {
      if (!live) return undefined;
      refresh();
      if (ms >= trusted || ms < 0) return undefined;
      if (alongAt !== pathAt) {
        along = aligner.units();
        alongAt = pathAt;
      }
      const unit = along[Math.floor(ms / ALIGN_HOP_MS)];
      return unit === undefined ? undefined : (units[unit]?.word ?? null);
    },
  };
};
