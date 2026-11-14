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
