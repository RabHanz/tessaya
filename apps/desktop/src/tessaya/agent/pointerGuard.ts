/**
 * The mouse stays his (D115). If the pointer is not where Baton left it, he has moved it, and Baton
 * stops and says so rather than click where he now is. The first action of a turn has nowhere it
 * left it, so it is allowed: he had just asked for it.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A few pixels of rounding between the driver's physical points and Electron's DIPs. */
export const POINTER_TOLERANCE = 8;

export const pointerMoved = (
  left: Point | null,
  now: Point,
  tolerance = POINTER_TOLERANCE,
): boolean =>
  left !== null && (Math.abs(left.x - now.x) > tolerance || Math.abs(left.y - now.y) > tolerance);

/**
 * His mouse moves only as a last resort, and only after he says yes (CU-6): once a turn, since one task can need a few
 * clicks. A no throws, so the model hears it and finds another way.
 */
export const createMouseConsent = (ask: () => Promise<boolean>) => {
  let yes = false;
  return {
    need: async (): Promise<void> => {
      if (yes) return;
      yes = await ask();
      if (!yes) {
        throw new Error(
          "He said no to his mouse being used. Find another way (ui_tree and click_element, or keys), or tell him what to click.",
        );
      }
    },
    reset: () => void (yes = false),
  };
};

/** How long he must have left the keys and mouse alone before she carries on after he typed. */
export const QUIET_MS = 3_000;
/** How long she waits for that quiet before she stops and tells him. */
export const PAUSE_MAX_MS = 30_000;
/** Her own input lands a little after she sends it; within this it is hers. */
const OWN_INPUT_SLACK_MS = 400;

/**
 * His keyboard stays his too: before each key, click or drag of hers, any input since her last one is his (typing,
 * or the mouse). She pauses until he has been quiet for `QUIET_MS`, then carries on; still busy after `PAUSE_MAX_MS`,
 * she stops and tells him, and his "carry on" starts a new turn. A reading that fails never blocks her.
 */
export const createInputPause = (deps: {
  /** Milliseconds since anyone's last key or mouse input, hers included; null when it cannot be read. */
  readonly idleMs: () => Promise<number | null>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}) => {
  let lastOwn: number | null = null;
  return {
    /** A turn starts: what he typed to ask is before it. */
    reset: () => void (lastOwn = deps.now()),
    /** Her own input just went out. */
    acted: () => void (lastOwn = deps.now()),
    before: async (): Promise<void> => {
      if (lastOwn === null) return;
      const idle = await deps.idleMs().catch(() => null);
      if (idle === null || deps.now() - idle <= lastOwn + OWN_INPUT_SLACK_MS) return;
      const started = deps.now();
      for (;;) {
        const quiet = await deps.idleMs().catch(() => null);
        if (quiet === null || quiet >= QUIET_MS) {
          lastOwn = deps.now();
          return;
        }
        if (deps.now() - started >= PAUSE_MAX_MS)
          throw new Error(
            "He is using his keyboard or mouse, so I paused and stopped. Tell him, and carry on when he says so.",
          );
        await deps.sleep(Math.max(250, QUIET_MS - quiet));
      }
    },
  };
};
