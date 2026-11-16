/**
 * Effects that land on her words (VOXTA-STUDY G7): a face, a buzz or a sound fires when her voice reaches the word it
 * belongs to, now, or after the speech. The anchors are the stage directions she already writes (`*laughs*`): each is a
 * sound piece (`interjections.ts`) and its effect lands on the word it sits before. Each vessel times them on its own
 * playback clock: the aligner's word cues where it has them, else characters across the sentence's measured length.
 */
import type { Nonverbal, SpeechPiece } from "./interjections.ts";

export type EffectWhen =
  /** On word `word` (whitespace-split, of `saidText`) of the reply's sentence `sentence`; past its last word, at its end. */
  | { readonly at: "speech"; readonly sentence: number; readonly word: number }
  | { readonly at: "now" }
  | { readonly at: "after" };

export interface SoundAnchor {
  /** The word of the line's `saidText` it sits before; the word count for one at the line's end. */
  readonly word: number;
  readonly nonverbal: Nonverbal;
}

const wordsOf = (text: string) => text.split(/\s+/).filter((w) => w !== "");

/** What a line's audio says, as the aligner and the word cues count it: its words and any sound said as words. */
export const saidText = (pieces: ReadonlyArray<SpeechPiece>): string =>
  pieces
    .map((p) => (p.kind === "text" ? p.text : p.sound.kind === "say" ? p.sound.text : ""))
    .filter((t) => t !== "")
    .join(" ");

/** A Gemini tag in a line's text (`<laugh>`, `<short pause>`): where a stage direction was. */
const GEMINI_TAG = /<[a-z -]{1,30}>/g;

/**
 * Each sound in a line, on the word it sits before. A Gemini line has no sound pieces: its directions are tags inside
 * the text, and `gemini` (`directionsOf` the reply) says, in order, what each tag stands for.
 */
export const soundAnchors = (
  pieces: ReadonlyArray<SpeechPiece>,
  gemini: ReadonlyArray<Nonverbal> = [],
): SoundAnchor[] => {
  const out: SoundAnchor[] = [];
  let word = 0;
  let tag = 0;
  for (const p of pieces) {
    if (p.kind === "sound") out.push({ word, nonverbal: p.nonverbal });
    const text = p.kind === "text" ? p.text : p.sound.kind === "say" ? p.sound.text : "";
    if (p.kind === "text" && gemini.length > 0)
      for (const m of text.matchAll(GEMINI_TAG)) {
        const nonverbal = gemini[tag++];
        if (nonverbal !== undefined)
          out.push({ word: word + wordsOf(text.slice(0, m.index)).length, nonverbal });
      }
    word += wordsOf(text).length;
  }
  return out;
};

export interface SentenceClock {
  /** When its first sample sounds, on the vessel's playback clock; null until it is known. */
  readonly startMs: number | null;
  /** Its audio's whole length; null while it is still being made. */
  readonly durationMs: number | null;
  /** What it says (`saidText`). */
  readonly text: string;
  /** Where the aligner heard each word start, ms after `startMs`, where it has. */
  readonly wordMs?: ReadonlyArray<number | undefined>;
}

export interface SpeechTimeline {
  readonly nowMs: number;
  /** The reply's sentences in order, as far as they are known. */
  readonly sentences: ReadonlyArray<SentenceClock>;
  /** When the last of the reply has sounded; null until it is known. */
  readonly endMs: number | null;
}

/** How far into a sentence a word starts, by its share of the sentence's letters: 0 at the first, 1 past the last. */
export const charShare = (text: string, word: number): number => {
  const words = wordsOf(text);
  const total = words.reduce((n, w) => n + w.length, 0);
  if (total === 0 || word <= 0) return 0;
  if (word >= words.length) return 1;
  return words.slice(0, word).reduce((n, w) => n + w.length, 0) / total;
};

/** When an effect fires on the vessel's clock, or null while that part of the speech has no timing yet. */
export const fireAtMs = (when: EffectWhen, timeline: SpeechTimeline): number | null => {
  if (when.at === "now") return timeline.nowMs;
  if (when.at === "after") return timeline.endMs;
  const s = timeline.sentences[when.sentence];
  if (s === undefined || s.startMs === null) return null;
  const aligned = s.wordMs?.[when.word];
  if (aligned !== undefined) return s.startMs + aligned;
  if (s.durationMs === null) return null;
  return s.startMs + s.durationMs * charShare(s.text, when.word);
};
