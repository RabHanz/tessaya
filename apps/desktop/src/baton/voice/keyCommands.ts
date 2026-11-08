/**
 * Spoken "stop dictation" while a key or button dictation records. The voice core hears nothing then (the helper has
 * the words), so short utterances with a pause after them are cut from the mic and heard on their own; only a whole
 * "stop dictation" counts (`keyDictationCommand`).
 */

/** A level this loud is speech (frameLevel's scale). */
const LOUD = 0.15;
/** At 512 samples a frame (32 ms): at least 190 ms of speech, at most 2.5 s, ended by 400 ms of quiet. */
const MIN_SPEECH = 6;
const MAX_FRAMES = 78;
const PAUSE = 12;
/** Quiet frames kept before the speech, so a soft first sound ("s" of "stop") is in the clip. */
const PRE_ROLL = 3;

export const createCommandClips = () => {
  let pre: Int16Array[] = [];
  let frames: Int16Array[] = [];
  let speech = 0;
  let quiet = 0;
  let tooLong = false;
  const reset = () => {
    pre = [];
    frames = [];
    speech = 0;
    quiet = 0;
    tooLong = false;
  };
  return {
    reset,
    /** A clip to hear when a short utterance has just ended; null otherwise. */
    feed: (input: { readonly level: number; readonly pcm: Int16Array }): Int16Array | null => {
      if (input.level >= LOUD) {
        if (speech === 0) frames = [...pre];
        quiet = 0;
        speech += 1;
        if (frames.length >= MAX_FRAMES + PRE_ROLL) tooLong = true;
        if (!tooLong) frames.push(input.pcm);
        return null;
      }
      if (speech === 0) {
        pre = [...pre, input.pcm].slice(-PRE_ROLL);
        return null;
      }
      quiet += 1;
      if (!tooLong) frames.push(input.pcm);
      if (quiet < PAUSE) return null;
      const keep = !tooLong && speech >= MIN_SPEECH ? frames : null;
      reset();
      if (keep === null) return null;
      const clip = new Int16Array(keep.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of keep) {
        clip.set(f, at);
        at += f.length;
      }
      return clip;
    },
  };
};
