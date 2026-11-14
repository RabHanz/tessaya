/**
 * The microphone is open but hears nothing (a muted or unplugged device, the wrong input chosen).
 * Fed the level of every frame and checked on a timer, so a stream that stops delivering frames
 * counts too. Says "warn" once per quiet episode; hearing something ends the episode.
 */
// frameLevel of a 15-sample peak: a dead endpoint's dither stays under it, a live room does not.
export const DEAD_LEVEL = 0.03;
export const DEFAULT_SILENCE_SECONDS = 90;

export const createSilenceWatch = (input: { readonly seconds: () => number }) => {
  let heardAt: number | null = null;
  let warned = false;
  return {
    feed: (level: number, now: number): void => {
      if (level <= DEAD_LEVEL) {
        heardAt ??= now;
        return;
      }
      heardAt = now;
      warned = false;
    },
    /** 0 seconds turns the watch off; the first check starts the clock. */
    check: (now: number): "warn" | null => {
      if (input.seconds() <= 0) return null;
      heardAt ??= now;
      if (warned || now - heardAt < input.seconds() * 1000) return null;
      warned = true;
      return "warn";
    },
    reset: () => {
      heardAt = null;
      warned = false;
    },
  };
};
