/**
 * Tessaya's short cues as data, and the wave Web Audio makes from them as samples: the desktop pill plays them, and
 * the R1's room loop sends them as its listening and closing sounds. Warm, short and low on purpose (D112).
 */

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

/** How long a cue sounds, with its tail, in milliseconds. */
export const soundMs = (sound: PillSound): number =>
  Math.ceil((Math.max(...PILL_SOUNDS[sound].map((n) => n.at + n.len)) + 0.02) * 1000);

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
