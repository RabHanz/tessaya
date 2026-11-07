/**
 * The pill's three sounds as data: played in the page by Web Audio and rendered here so
 * scripts/tessaya/voice-lab/sound-score.ts can put the same waves through the wake models and Silero.
 * Warm, short and low on purpose. D112 has the numbers and what they replaced.
 */

import type { TurnPhase } from "@t3tools/baton-shared/voiceTurn";

export interface PillNote {
  readonly hz: number;
  /** Seconds after the sound starts. */
  readonly at: number;
  readonly len: number;
  readonly gain: number;
}

export type PillSound =
  | "wake"
  | "end"
  | "error"
  | "thinking"
  | "start"
  | "stepDone"
  | "waiting"
  | "finished";

export const PILL_SOUNDS: Record<PillSound, ReadonlyArray<PillNote>> = {
  wake: [
    { hz: 523.25, at: 0, len: 0.11, gain: 0.05 },
    { hz: 783.99, at: 0.055, len: 0.16, gain: 0.045 },
  ],
  end: [
    { hz: 659.25, at: 0, len: 0.1, gain: 0.04 },
    { hz: 440, at: 0.06, len: 0.17, gain: 0.04 },
  ],
  // Falling: something did not work.
  error: [
    { hz: 392, at: 0, len: 0.1, gain: 0.045 },
    { hz: 293.66, at: 0.09, len: 0.16, gain: 0.04 },
  ],
  // A lesson or a drive begins: rising.
  start: [
    { hz: 440, at: 0, len: 0.1, gain: 0.04 },
    { hz: 659.25, at: 0.07, len: 0.15, gain: 0.04 },
  ],
  // One step is done: a soft tick.
  stepDone: [{ hz: 880, at: 0, len: 0.07, gain: 0.049 }],
  // Waiting for him: one low soft note.
  waiting: [{ hz: 392, at: 0, len: 0.16, gain: 0.04 }],
  // All done: three notes that resolve.
  finished: [
    { hz: 523.25, at: 0, len: 0.1, gain: 0.04 },
    { hz: 659.25, at: 0.08, len: 0.1, gain: 0.04 },
    { hz: 783.99, at: 0.16, len: 0.2, gain: 0.04 },
  ],
  // One soft low note, only after a long wait: "still working", never a chime.
  thinking: [{ hz: 329.63, at: 0, len: 0.14, gain: 0.03 }],
};

/**
 * Whether the end cue sounds as the pill goes from `before` to `now` (null: it lowers). Once, when listening ends:
 * as the window closes ("ended"), or as it lowers from anything that had not ended already. Never seconds later as
 * an ended pill lowers: then it would blank the microphone over a name he may be saying.
 */
export const endCueOn = (before: TurnPhase, now: TurnPhase | null): boolean =>
  now === "ended"
    ? before !== "ended"
    : now === null &&
      before !== "idle" &&
      before !== "ended" &&
      before !== "error" &&
      before !== "done";

/** How long a cue sounds, with its tail, in milliseconds. */
export const soundMs = (sound: PillSound): number =>
  Math.ceil((Math.max(...PILL_SOUNDS[sound].map((n) => n.at + n.len)) + 0.02) * 1000);

/** Cue levels: "Quiet" is half of "Normal"; Off plays nothing. */
export type CueLevel = "off" | "quiet" | "normal";
export const CUE_GAIN: Readonly<Record<CueLevel, number>> = { off: 0, quiet: 0.5, normal: 1 };
export const parseCueLevel = (value: unknown, legacySounds?: unknown): CueLevel =>
  value === "off" || value === "quiet" || value === "normal"
    ? value
    : legacySounds === false
      ? "off"
      : "normal";

/** After a cue the mic path stays silent this much longer, so its echo cannot be heard as speech. */
export const CUE_TAIL_MS = 150;
/** A cue waits at most this long for him to stop speaking, then is dropped. */
export const CUE_WAIT_MS = 300;
/** Thinking cue: after this long, then at most this often. */
export const THINKING_AFTER_MS = 4_000;
export const THINKING_EVERY_MS = 8_000;

/** Share of the second harmonic: enough to sound like a struck thing rather than a test tone. */
export const PILL_PARTIAL = 0.22;
const ATTACK = 0.004;

/** The same wave Web Audio makes, as samples. */
export const renderSound = (notes: ReadonlyArray<PillNote>, sampleRate: number): Float32Array => {
  const end = Math.max(...notes.map((n) => n.at + n.len)) + 0.02;
  const out = new Float32Array(Math.ceil(end * sampleRate));
  for (const { hz, at, len, gain } of notes) {
    const start = Math.floor(at * sampleRate);
    const count = Math.ceil(len * sampleRate);
    for (let i = 0; i < count && start + i < out.length; i++) {
      const t = i / sampleRate;
      const envelope = Math.min(t / ATTACK, 1) * Math.exp((-6.2 * t) / len);
      const wave = Math.sin(2 * Math.PI * hz * t) + PILL_PARTIAL * Math.sin(4 * Math.PI * hz * t);
      out[start + i]! += gain * envelope * wave;
    }
  }
  return out;
};
