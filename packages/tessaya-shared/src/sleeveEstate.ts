/**
 * Her estate on a phone Sleeve (M-158, REQ-25-166): where her character may stand on the screen and how big she may
 * be. Pure, so the stage page and its tests agree: she stays whole on screen and above the app's bottom panel.
 */
export interface Spot {
  /** Her centre, in CSS px. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
export interface StageBox {
  readonly w: number;
  readonly h: number;
  /** The app's panel over the bottom of the screen, in CSS px. */
  readonly bottom: number;
}

export const STAGE_SCALE = { min: 0.55, max: 1.7 } as const;

const within = (v: number, lo: number, hi: number) =>
  lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));

/** The nearest spot where all of her shows: her drawing is `size` square before her scale. */
export const clampSpot = (s: Spot, size: number, box: StageBox): Spot => {
  const scale = within(s.scale, STAGE_SCALE.min, STAGE_SCALE.max);
  const half = (size * scale) / 2;
  return {
    scale,
    x: within(s.x, half, box.w - half),
    y: within(s.y, half, box.h - box.bottom - half),
  };
};

/** Two fingers apart on her: her size follows the change in their distance. */
export const pinchScale = (from: number, fromApart: number, apart: number): number =>
  fromApart <= 0 ? from : within((from * apart) / fromApart, STAGE_SCALE.min, STAGE_SCALE.max);

/** Somewhere else on her screen for a quiet walk: a short stroll, not across the whole screen. */
export const wanderSpot = (s: Spot, size: number, box: StageBox, random: () => number): Spot => {
  const reach = Math.min(box.w, box.h) * 0.35;
  const angle = random() * Math.PI * 2;
  return clampSpot(
    { ...s, x: s.x + Math.cos(angle) * reach, y: s.y + Math.sin(angle) * reach * 0.5 },
    size,
    box,
  );
};
