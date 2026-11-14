/**
 * Quiet-speech mode: for whispering, or a mic that is far away. Two changes, both only while it is on: audio on its way
 * to the wake word and the recogniser is lifted towards a speaking level, and each wake word's threshold is lowered so a
 * whispered name still counts. It is a mode, not the default, because lifting also lifts room noise and lowering the
 * threshold lets in more false wakes.
 */

/** How far a wake threshold drops, and the floor it never goes under. */
export const QUIET_WAKE_DROP = 0.2;
export const QUIET_WAKE_FLOOR = 0.5;
export const quietThreshold = (threshold: number): number =>
  Math.max(QUIET_WAKE_FLOOR, threshold - QUIET_WAKE_DROP);

const TARGET_RMS = 0.06;
/** 18 dB at most: a whisper is 20 to 30 dB under speech, and more than this is mostly noise. */
const MAX_GAIN = 8;
/** Under this a frame is room tone or digital silence: not lifted, so silence stays silence. */
const NOISE_FLOOR_RMS = 0.003;
const ATTACK = 0.5;
const RELEASE = 0.05;

/**
 * A per-frame gain that rises quickly when speech is quiet and falls slowly, with a floor so room tone is not lifted.
 * Stateful: one per audio stream.
 */
export const createQuietBoost = () => {
  let gain = 1;
  return (frame: Int16Array): Int16Array => {
    let sum = 0;
    for (const v of frame) sum += (v / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const want = rms < NOISE_FLOOR_RMS ? 1 : Math.min(MAX_GAIN, Math.max(1, TARGET_RMS / rms));
    gain += (want - gain) * (want > gain ? ATTACK : RELEASE);
    if (gain < 1.01) return frame;
    const out = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i += 1)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i]! * gain)));
    return out;
  };
};

/** Speech setup under way (a key recording, a Voice ID read, a mic test): she must not wake or answer, even at her name. */
export const inSpeechSetup = (setup: {
  readonly recording: boolean;
  readonly reading: boolean;
  readonly micTest: boolean;
}) => setup.recording || setup.reading || setup.micTest;

/** The core, with audio lifted on its way in while `on()` says so. */
/**
 * A core that hears silence while `quiet()` is true, decided as each frame arrives: frames held for a
 * slow start are replayed later, and must keep the verdict they had when they were heard.
 */
export const silenceWhile = <T extends { pushAudio: (frame: Int16Array) => void }>(
  core: T,
  quiet: () => boolean,
): T =>
  new Proxy(core, {
    get: (target, prop) => {
      if (prop === "pushAudio")
        return (frame: Int16Array) =>
          target.pushAudio(quiet() ? new Int16Array(frame.length) : frame);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export const boostCore = <T extends { pushAudio: (frame: Int16Array) => void }>(
  core: T,
  on: () => boolean,
): T => {
  const boost = createQuietBoost();
  return new Proxy(core, {
    get: (target, prop) => {
      if (prop === "pushAudio")
        return (frame: Int16Array) => target.pushAudio(on() ? boost(frame) : frame);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
