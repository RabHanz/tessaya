/**
 * Speech stretches of a long recording, from Silero's score per 32 ms window, for `transcribe.ts`. A stretch ends at
 * half a second under the threshold, at the first dip once it is 15 s long, and always by 25 s (SenseVoice reads 30 s).
 * @module tessaya-voice/room/fileSegments
 */
const WINDOW = 512;
const ON = 0.5;
const OFF = 0.35;
const END_WINDOWS = 16;
const PAD_WINDOWS = 6;
const SOFT_WINDOWS = Math.round((15 * 16_000) / WINDOW);
const HARD_WINDOWS = Math.round((25 * 16_000) / WINDOW);

export interface FileSegment {
  /** Sample index of its first sample in the recording. */
  readonly start: number;
  readonly pcm: Int16Array;
}

export const createFileSegmenter = () => {
  let at = 0;
  const before: Int16Array[] = [];
  let open: Int16Array[] | null = null;
  let start = 0;
  let quiet = 0;
  const close = (keep: number): FileSegment => {
    const windows = open!.slice(0, keep);
    const pcm = new Int16Array(windows.length * WINDOW);
    windows.forEach((w, i) => pcm.set(w, i * WINDOW));
    open = null;
    quiet = 0;
    return { start, pcm };
  };
  return {
    /** One 512-sample window and its speech probability; a stretch when this window ends one. */
    push: (window: Int16Array, prob: number): FileSegment | null => {
      const w = window.slice();
      at += WINDOW;
      if (open === null) {
        before.push(w);
        if (before.length > PAD_WINDOWS + 1) before.shift();
        if (prob < ON) return null;
        open = before.splice(0);
        start = at - open.length * WINDOW;
        return null;
      }
      open.push(w);
      quiet = prob < OFF ? quiet + 1 : 0;
      if (quiet >= END_WINDOWS) return close(open.length - quiet + PAD_WINDOWS);
      if ((open.length >= SOFT_WINDOWS && prob < ON) || open.length >= HARD_WINDOWS)
        return close(open.length);
      return null;
    },
    /** The stretch still open when the recording ends. */
    flush: (): FileSegment | null =>
      open === null ? null : close(open.length - quiet + PAD_WINDOWS),
  };
};

/** `[mm:ss]`, or `[h:mm:ss]` from the first hour. */
export const stamp = (sample: number): string => {
  const s = Math.floor(sample / 16_000);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `[${Math.floor(s / 3600)}:${mm}:${ss}]` : `[${mm}:${ss}]`;
};
