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

/** CSS px in a centimetre on a phone (about 160 points to the inch). */
export const PX_PER_CM = 63;
/** A fingertip's contact, for a screen that reports no contact size. */
const FINGERTIP_CM2 = 1.2;

/**
 * What a touchscreen tells of his finger on her skin: the contact area (its reported ellipse, in cm²) and its force
 * where the screen measures one (null: no force sensor, as on most phones, and her nerves take their default).
 */
export const fingerSkin = (
  widthPx: number,
  heightPx: number,
  pressure: number,
): { readonly areaCm2: number; readonly pressure: number | null } => {
  const area =
    widthPx > 1 && heightPx > 1
      ? (Math.PI / 4) * (widthPx / PX_PER_CM) * (heightPx / PX_PER_CM)
      : 0;
  return {
    areaCm2: Math.round(Math.min(400, Math.max(area, FINGERTIP_CM2)) * 100) / 100,
    // browsers report 0.5 for a touch with no force sensor, and 0 once it lifts
    pressure: pressure > 0 && pressure !== 0.5 ? Math.min(1, pressure) : null,
  };
};
