/**
 * Voice dictation's window and its Esc: where the words go, read at the wake or as dictation starts, and
 * the Esc that ends it while it is on. Cleared together, so a stopped voice leaves neither behind.
 */
export const createDictationHold = <T>(
  holdEscape: (onPress: () => void, rank: "recording") => () => void,
  end: () => void,
) => {
  let release: (() => void) | null = null;
  let target: T | null = null;
  return {
    target: () => target,
    setTarget: (next: T | null) => {
      target = next;
    },
    /** The target once: a follow-up with no new wake reads where the keyboard is then. */
    takeTarget: () => {
      const taken = target;
      target = null;
      return taken;
    },
    start: (next: T | null) => {
      target = next;
      release ??= holdEscape(end, "recording");
    },
    /** Dictation ended: Esc is his again; the target stays until the last words are pasted. */
    stop: () => {
      release?.();
      release = null;
    },
    clear: () => {
      release?.();
      release = null;
      target = null;
    },
  };
};
