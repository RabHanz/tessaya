/** A press that moves less than this is a click, not the start of a drag. */
export const CLICK_PX = 4;
export const CLICK_MS = 400;

/**
 * Pointer up after a press: a click when it barely moved and was quick. Its body is injected into
 * the pill page as text, so it must stay self-contained (literals match the constants above).
 */
export const isPillClick = (dx: number, dy: number, ms: number): boolean =>
  Math.hypot(dx, dy) < 4 && ms < 400;
