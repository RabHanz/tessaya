/**
 * Spoken "stop dictation" and "cancel" while a key or button dictation records. The voice core hears nothing then
 * (the helper has the words), so short utterances with a pause after them are cut from the mic and heard on their
 * own: only a whole command counts, so the words he dictates are never taken for one.
 */
import { classifyDictation } from "@t3tools/baton-shared/dictation";
import { isCancelPhrase } from "@t3tools/baton-shared/voiceTurn";

/** A level this loud is speech (frameLevel's scale). */
const LOUD = 0.15;
/** At 512 samples a frame (32 ms): at least 190 ms of speech, at most 2.5 s, ended by 400 ms of quiet. */
const MIN_SPEECH = 6;
const MAX_FRAMES = 78;
const PAUSE = 12;

/** "stop" ends and pastes (✓); "cancel" throws the words away (✕); null for anything he dictates. */
export const keyCommandOf = (text: string): "stop" | "cancel" | null => {
  const said = text.trim();
  if (said === "") return null;
  const d = classifyDictation(said, { dictating: true });
  if (d.kind === "stop" && d.text === undefined) return "stop";
  return isCancelPhrase(said) ? "cancel" : null;
};

/** The helper heard the command too, at the end of what he dictated: it is not his words. */
export const withoutTrailingCommand = (text: string): string => {
  const d = classifyDictation(text, { dictating: true });
  return d.kind === "stop" ? (d.text ?? "").trim() : text;
};

export const createCommandClips = () => {
  let frames: Int16Array[] = [];
  let speech = 0;
  let quiet = 0;
  let tooLong = false;
  const reset = () => {
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
        quiet = 0;
        speech += 1;
        if (frames.length >= MAX_FRAMES) tooLong = true;
        if (!tooLong) frames.push(input.pcm);
        return null;
      }
      if (speech === 0) return null;
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
