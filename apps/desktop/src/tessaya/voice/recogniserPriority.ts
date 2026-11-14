export type RecogniserPriority = "above" | "normal";

/**
 * The recogniser's priority while it works: above normal during a recognition, so ordinary background
 * load (a browser, Defender, a VM) yields to his words, and normal again after. Never raised while she
 * speaks, or while a game or full-screen app is in front: her voice and his game keep their share.
 */
export const createRecogniserPriority = (input: {
  readonly set: (level: RecogniserPriority) => void;
  /** A game or full-screen app is in front. */
  readonly fullscreen: () => boolean;
}) => {
  let working = 0;
  let speaking = false;
  let level: RecogniserPriority = "normal";
  const to = (next: RecogniserPriority) => {
    if (next === level) return;
    level = next;
    input.set(next);
  };
  return {
    /** A recognition starts; returns the priority it runs at, for its log line. */
    begin: (): RecogniserPriority => {
      working += 1;
      if (!speaking && !input.fullscreen()) to("above");
      return level;
    },
    end: () => {
      working = Math.max(0, working - 1);
      if (working === 0) to("normal");
    },
    /** Her voice started or stopped: while it plays, the recogniser is back to normal. */
    speaking: (active: boolean) => {
      speaking = active;
      if (active) to("normal");
    },
  };
};
