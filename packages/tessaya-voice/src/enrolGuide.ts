/**
 * Guided voice enrolment: he reads a short script, the card follows his words, and each sentence is checked for level,
 * clipping, noise and voice before it counts. Pure: the caller feeds microphone audio, the recogniser's words and each
 * accepted sentence's voice vector, and enrols from `clips()` once it says `ready`. The desktop's Voice ID and the R1's
 * room loop both drive it, so the card reads and behaves the same on either microphone.
 */
import type { EnrolCard, EnrolCardLine } from "@t3tools/tessaya-contracts";

import { cosine } from "./speaker.ts";

const BLOCK = 320;
const BLOCK_MS = 20;
const PREROLL_BLOCKS = 10;
const HISTORY_BLOCKS = 1_500;
const NOISE_AFTER_BLOCKS = 50;
/** He paused this long after speaking: the sentence may be over. */
const PAUSE_MS = 700;
const MIN_SPEECH_MS = 600;
/** A sentence counts as read once he has spoken this share of its expected length, whatever the recogniser heard. */
const WORD_MS = 300;
const SPOKEN_SHARE = 0.75;
/** How far ahead of the last matched word a heard word may land: a missed or misread word is skipped, never waited on. */
const LOOKAHEAD = 4;

export const ENROL_QUALITY = {
  /** Below this a block is not speech, whatever the room. */
  speechFloor: 200,
  /** Speech this many times the noise floor counts as speech. */
  speechOverNoise: 2.5,
  /** About -38 dBFS: speech quieter than this is too far from the mic. */
  quietRms: 400,
  clipLevel: 32_000,
  clipShare: 0.002,
  minSnrDb: 12,
} as const;

export type EnrolIssue = "quiet" | "loud" | "noisy" | "otherVoice";

export const ISSUE_LINE: Readonly<Record<EnrolIssue, string>> = {
  quiet: "That one was too quiet. Please read it again, a little closer to the mic.",
  loud: "That one was too loud and crackled. Please read it again, a little further back.",
  noisy: "There was a lot of background noise. Please read it again when it's quieter.",
  otherVoice: "That didn't sound like the same voice as the others. Please read it again yourself.",
};

/** Six varied sentences, about 30 s, with her name and his (the computer account's, when it looks like one). */
export const enrolScript = (name: string | null): ReadonlyArray<string> => [
  `Hi Tessaya, ${name === null ? "it's me" : `it's ${name}`}, and this is how my voice sounds on an ordinary day.`,
  "The quick brown fox jumps over the lazy dog, then naps in the warm sun.",
  "Please move Thursday's meeting to half past ten and remind me the night before.",
  "Five big jugs of fresh orange juice were shipped to the village yesterday.",
  "Should we check the weather, or would you rather read the news first?",
  "Thanks, Tessaya. That's everything for now, so let's get back to work.",
];

/** A login name that reads as a first name ("maya" -> "Maya"); null for "dev", "admin1" and the like. */
export const scriptName = (login: string): string | null => {
  const first = login.trim().split(/[\s._-]/)[0] ?? "";
  if (!/^[a-z]{3,20}$/i.test(first) || /^(admin|user|dev|root|owner|guest|test)$/i.test(first))
    return null;
  return first[0]!.toUpperCase() + first.slice(1).toLowerCase();
};

const norm = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (text: string) => text.split(/\s+/).filter((w) => w !== "");

const distance = (a: string, b: string) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length]!;
};

/** Close enough for a recogniser: "tessa" for "tessaya", "thursdays" for "thursday's". */
export const sameWord = (script: string, heard: string): boolean => {
  if (script === "" || heard === "") return false;
  if (script === heard) return true;
  const longest = Math.max(script.length, heard.length);
  if (longest < 4) return false;
  if (Math.min(script.length, heard.length) >= 4 && script.slice(0, 4) === heard.slice(0, 4))
    return true;
  return distance(script, heard) <= (longest >= 7 ? 2 : 1);
};

/**
 * How many of the sentence's words (split on spaces) he has reached, from what the recogniser heard. Heard words that
 * match nothing near are skipped, and the count also follows how many words were heard, so a misread word or a
 * recogniser that hears him poorly never holds the highlight back for long.
 */
export const alignHeard = (sentence: string, heard: string): number => {
  const script = words(sentence).map(norm);
  const said = words(heard)
    .map(norm)
    .filter((w) => w !== "");
  let at = 0;
  for (const word of said) {
    for (let j = at; j < Math.min(at + LOOKAHEAD, script.length); j += 1)
      if (sameWord(script[j]!, word)) {
        at = j + 1;
        break;
      }
  }
  return Math.min(script.length, Math.max(at, Math.min(said.length, script.length) - 3));
};

export interface TakeStats {
  readonly speechRms: number;
  readonly noiseRms: number;
  readonly clipShare: number;
}

/** Why a read sentence will not do, or null when it will (the voice check comes later, with its vector). */
export const takeIssue = (
  s: TakeStats,
  quietRms: number = ENROL_QUALITY.quietRms,
): EnrolIssue | null => {
  if (s.clipShare > ENROL_QUALITY.clipShare) return "loud";
  if (s.speechRms < quietRms) return "quiet";
  if (20 * Math.log10(s.speechRms / Math.max(s.noiseRms, 1)) < ENROL_QUALITY.minSnrDb)
    return "noisy";
  return null;
};

/** The sentence whose voice is furthest from the rest, when it is below `threshold`; needs three to judge. */
export const oddVoice = (
  vectors: ReadonlyMap<number, Float32Array>,
  threshold: number,
): number | null => {
  if (vectors.size < 3) return null;
  let worst: { index: number; score: number } | null = null;
  for (const [index, v] of vectors) {
    const rest = [...vectors].filter(([i]) => i !== index).map(([, w]) => w);
    const mean = new Float32Array(v.length);
    for (const w of rest) for (let k = 0; k < w.length; k += 1) mean[k]! += w[k]! / rest.length;
    const score = cosine(v, mean);
    if (worst === null || score < worst.score) worst = { index, score };
  }
  return worst !== null && worst.score < threshold ? worst.index : null;
};

const meanLeaveOneOut = (vectors: ReadonlyArray<Float32Array>): number | null => {
  if (vectors.length < 2) return null;
  let sum = 0;
  for (const v of vectors) {
    const mean = new Float32Array(v.length);
    for (const w of vectors) if (w !== v) for (let k = 0; k < w.length; k += 1) mean[k]! += w[k]!;
    sum += cosine(v, mean);
  }
  return sum / vectors.length;
};

const QUALITY_WORDS = ["", "Fair", "Good", "Strong"] as const;

export interface EnrolGuideInput {
  readonly sentences: ReadonlyArray<string>;
  readonly title: string;
  readonly lead: string;
  readonly mic: string;
  /** For the summary: where else to enrol. */
  readonly tip: string | null;
  /** Cosine below which a sentence is another voice (the model's "listen" cut-off). */
  readonly otherVoiceBelow: number;
  /** Mean sentence-to-rest cosine for three bars (two from `otherVoiceBelow + 0.17`). */
  readonly strongFrom: number;
  /**
   * Absolute floors for a mic far quieter than a desk mic (the R1 sends speech at RMS 30-600, 13 Nov); speech still
   * has to clear the room's own floor and the SNR check. Defaults: `ENROL_QUALITY`.
   */
  readonly floors?: { readonly speech: number; readonly quiet: number };
}

export interface GuideStep {
  /** The card changed (not counting the level). */
  readonly changed: boolean;
  /** A sentence passed its checks: embed it and hand back its vector with `voice`. */
  readonly accepted: { readonly index: number; readonly pcm: Int16Array } | null;
  /** Every sentence is in: enrol from `clips()`, then call `finish`. */
  readonly ready: boolean;
}

export const createEnrolGuide = (input: EnrolGuideInput) => {
  const n = input.sentences.length;
  const speechFloor = input.floors?.speech ?? ENROL_QUALITY.speechFloor;
  const quietRms = input.floors?.quiet ?? ENROL_QUALITY.quietRms;
  let done: Array<Int16Array | null>;
  let again: Array<EnrolIssue | null>;
  let vectors: Map<number, Float32Array>;
  let waiting: Set<number>;
  let retries: Array<EnrolIssue>;
  let phase: EnrolCard["phase"];
  let summary: EnrolCard["summary"];
  let snrs: number[];
  let current: number | null;
  let takeNo = 0;
  let heard = 0;
  // The take: his audio for the sentence being read, from just before he started.
  let preroll: Int16Array[] = [];
  let take: Int16Array[] = [];
  let started = false;
  let speechBlocks = 0;
  let speechSq = 0;
  let silentBlocks = 0;
  let clipped = 0;
  let samples = 0;
  let judged = false;
  const history: number[] = [];
  let noise = 0;
  let blocks = 0;
  let level = 0;
  let rest = new Int16Array(0);

  const nextIndex = () => {
    for (let i = 0; i < n; i += 1) if (done[i] === null && !waiting.has(i)) return i;
    return null;
  };
  const newTake = () => {
    takeNo += 1;
    heard = 0;
    preroll = [];
    take = [];
    started = false;
    speechBlocks = 0;
    speechSq = 0;
    silentBlocks = 0;
    clipped = 0;
    samples = 0;
    judged = false;
    current = phase === "reading" ? nextIndex() : null;
  };
  const reset = () => {
    done = Array.from({ length: n }, () => null);
    again = Array.from({ length: n }, () => null);
    vectors = new Map();
    waiting = new Set();
    retries = [];
    snrs = [];
    phase = "reading";
    summary = null;
    newTake();
  };
  reset();

  const readyNow = () => phase === "reading" && done.every((d) => d !== null) && waiting.size === 0;

  const markAgain = (index: number, issue: EnrolIssue) => {
    done[index] = null;
    again[index] = issue;
    vectors.delete(index);
    retries.push(issue);
  };

  /** The read sentence is judged at his pause: on to the next, or that one again. */
  const judge = (): GuideStep => {
    const index = current;
    if (index === null) return { changed: false, accepted: null, ready: false };
    const length = words(input.sentences[index]!).length;
    const spokenMs = speechBlocks * BLOCK_MS;
    const reached = heard >= length - 2 || spokenMs >= SPOKEN_SHARE * length * WORD_MS;
    if (!reached) return { changed: false, accepted: null, ready: false };
    const speechRms = Math.sqrt(speechSq / Math.max(1, speechBlocks));
    const issue = takeIssue(
      {
        speechRms,
        noiseRms: noise,
        clipShare: clipped / Math.max(1, samples),
      },
      quietRms,
    );
    if (issue !== null) {
      markAgain(index, issue);
      newTake();
      return { changed: true, accepted: null, ready: false };
    }
    snrs.push(20 * Math.log10(speechRms / Math.max(noise, 1)));
    // The pause he ended on is not his voice.
    const kept = take.slice(0, Math.max(1, take.length - silentBlocks));
    const pcm = new Int16Array(kept.reduce((s, b) => s + b.length, 0));
    let at = 0;
    for (const b of kept) {
      pcm.set(b, at);
      at += b.length;
    }
    done[index] = pcm;
    again[index] = null;
    waiting.add(index);
    newTake();
    return { changed: true, accepted: { index, pcm }, ready: false };
  };

  const block = (b: Int16Array): GuideStep | null => {
    let sq = 0;
    let clips = 0;
    for (const v of b) {
      sq += v * v;
      if (v >= ENROL_QUALITY.clipLevel || v <= -ENROL_QUALITY.clipLevel) clips += 1;
    }
    const rms = Math.sqrt(sq / b.length);
    level = Math.min(1, Math.sqrt(rms / 32_768) * 2.2);
    history.push(rms);
    if (history.length > HISTORY_BLOCKS) history.shift();
    blocks += 1;
    // The room's floor: the quietest tenth of the last 30 s, once there is a second of it to judge from.
    if (blocks >= NOISE_AFTER_BLOCKS && blocks % 25 === 0)
      noise = history.toSorted((x, y) => x - y)[Math.floor(history.length / 10)]!;
    if (current === null) return null;
    const speech = rms >= Math.max(speechFloor, noise * ENROL_QUALITY.speechOverNoise);
    if (!started) {
      preroll.push(b);
      if (preroll.length > PREROLL_BLOCKS) preroll.shift();
      if (!speech) return null;
      started = true;
      take = preroll;
      preroll = [];
    } else take.push(b);
    samples += b.length;
    clipped += clips;
    if (speech) {
      speechBlocks += 1;
      speechSq += rms * rms;
      silentBlocks = 0;
      judged = false;
      return null;
    }
    silentBlocks += 1;
    if (judged || silentBlocks * BLOCK_MS < PAUSE_MS || speechBlocks * BLOCK_MS < MIN_SPEECH_MS)
      return null;
    // Judged again on each quiet block until it decides: the recogniser's last words can land after his pause.
    const step = judge();
    if (step.changed) judged = true;
    return step;
  };

  const view = (): EnrolCard => ({
    title: input.title,
    lead: input.lead,
    lines: input.sentences.map((text, i): EnrolCardLine => ({
      text,
      state:
        done[i] !== null || waiting.has(i)
          ? "done"
          : again[i] !== null
            ? "again"
            : i === current
              ? "now"
              : "todo",
      heard: i === current ? heard : 0,
      why: done[i] === null && again[i] != null ? ISSUE_LINE[again[i]!] : null,
    })),
    mic: input.mic,
    level,
    phase,
    summary,
  });

  return {
    /** Microphone audio, 16 kHz mono, in any frame size. */
    frame: (pcm: Int16Array): GuideStep => {
      const all = new Int16Array(rest.length + pcm.length);
      all.set(rest);
      all.set(pcm, rest.length);
      let changed = false;
      let accepted: GuideStep["accepted"] = null;
      let at = 0;
      for (; at + BLOCK <= all.length; at += BLOCK) {
        const step = block(all.slice(at, at + BLOCK));
        if (step === null) continue;
        changed ||= step.changed;
        accepted = step.accepted ?? accepted;
      }
      rest = all.slice(at);
      return { changed, accepted, ready: false };
    },
    /** The recogniser's words for take `no` so far. */
    heard: (text: string, no: number): boolean => {
      if (no !== takeNo || current === null) return false;
      const reached = alignHeard(input.sentences[current]!, text);
      if (reached <= heard) return false;
      heard = reached;
      return true;
    },
    /** Which take is being read, and its audio so far, for the recogniser. */
    take: (): { readonly no: number; readonly pcm: Int16Array | null } => {
      if (!started || current === null) return { no: takeNo, pcm: null };
      const pcm = new Int16Array(take.reduce((s, b) => s + b.length, 0));
      let at = 0;
      for (const b of take) {
        pcm.set(b, at);
        at += b.length;
      }
      return { no: takeNo, pcm };
    },
    /** Sentence `index`'s voice vector, or null when there is no model to judge it. */
    voice: (index: number, vector: Float32Array | null): GuideStep => {
      if (!waiting.delete(index)) return { changed: false, accepted: null, ready: false };
      if (vector !== null && done[index] !== null) vectors.set(index, vector);
      const odd = oddVoice(vectors, input.otherVoiceBelow);
      let changed = false;
      if (odd !== null) {
        markAgain(odd, "otherVoice");
        changed = true;
      }
      if (current === null && phase === "reading") {
        current = nextIndex();
        changed ||= current !== null;
      }
      const ready = readyNow();
      if (ready) {
        phase = "saving";
        changed = true;
      }
      return { changed, accepted: null, ready };
    },
    /** The accepted sentences, in order: what the profile is made from. */
    clips: (): ReadonlyArray<Int16Array> => done.filter((d) => d !== null),
    /** The profile was made (or not): the summary. `rows` come after the quality and microphone rows. */
    finish: (result: {
      readonly saved: boolean;
      readonly headline: string;
      readonly rows?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    }) => {
      const likeness = meanLeaveOneOut([...vectors.values()]);
      const snr = snrs.reduce((s, v) => s + v, 0) / Math.max(1, snrs.length);
      const quality = !result.saved
        ? 0
        : likeness !== null
          ? likeness >= input.strongFrom
            ? 3
            : likeness >= input.otherVoiceBelow + 0.17
              ? 2
              : 1
          : snr >= 25
            ? 3
            : snr >= 18
              ? 2
              : 1;
      const counts = new Map<EnrolIssue, number>();
      for (const r of retries) counts.set(r, (counts.get(r) ?? 0) + 1);
      const why = [...counts.keys()]
        .map(
          (k) =>
            ({ quiet: "too quiet", loud: "too loud", noisy: "noise", otherVoice: "another voice" })[
              k
            ],
        )
        .join(", ");
      phase = result.saved ? "done" : "failed";
      summary = {
        quality,
        headline: result.headline,
        rows: [
          ...(quality > 0 ? [{ label: "Quality", value: QUALITY_WORDS[quality]! }] : []),
          { label: "Microphone", value: input.mic },
          {
            label: "Read again",
            value:
              retries.length === 0
                ? "None"
                : `${retries.length} ${retries.length === 1 ? "sentence" : "sentences"} (${why})`,
          },
          ...(result.rows ?? []),
        ],
        tip: result.saved ? input.tip : null,
      };
    },
    /** Redo: from the first sentence again. */
    restart: reset,
    view,
    phase: () => phase,
  };
};

export type EnrolGuide = ReturnType<typeof createEnrolGuide>;
