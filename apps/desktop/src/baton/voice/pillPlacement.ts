/**
 * Where the pill sits (D141). Dragged, it keeps one place as a fraction of a work area, so it lands in the same spot
 * on whichever screen is active, and a change of resolution, scaling or taskbar moves it with the screen, never off it.
 * Pure, so the arithmetic is testable without a display.
 */
export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 0 is the left or top edge of the free space, 1 the right or bottom. */
export interface Spot {
  readonly fx: number;
  readonly fy: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const spotFrom = (
  area: Area,
  size: { readonly width: number; readonly height: number },
  at: { readonly x: number; readonly y: number },
): Spot => {
  const freeX = Math.max(1, area.width - size.width);
  const freeY = Math.max(1, area.height - size.height);
  return { fx: clamp01((at.x - area.x) / freeX), fy: clamp01((at.y - area.y) / freeY) };
};

export const positionOf = (
  area: Area,
  size: { readonly width: number; readonly height: number },
  spot: Spot,
): { readonly x: number; readonly y: number } => ({
  x: Math.round(area.x + clamp01(spot.fx) * Math.max(0, area.width - size.width)),
  y: Math.round(area.y + clamp01(spot.fy) * Math.max(0, area.height - size.height)),
});

/** Centred at the bottom, above the taskbar, or at the top: where it sits until he moves it. */
export const defaultPosition = (
  area: Area,
  size: { readonly width: number; readonly height: number },
  edge: "bottom" | "top",
  margins: { readonly top: number; readonly bottom: number },
): { readonly x: number; readonly y: number } => ({
  x: Math.round(area.x + (area.width - size.width) / 2),
  y: edge === "top" ? area.y + margins.top : area.y + area.height - size.height - margins.bottom,
});

/** A saved file is untrusted: only finite numbers in range become a spot. */
export const parseSpots = (raw: unknown): Readonly<Record<string, Spot>> => {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, Spot> = {};
  for (const [key, value] of Object.entries(raw)) {
    const { fx, fy } = (value ?? {}) as { fx?: unknown; fy?: unknown };
    if (
      typeof fx === "number" &&
      typeof fy === "number" &&
      Number.isFinite(fx) &&
      Number.isFinite(fy)
    ) {
      out[key] = { fx: clamp01(fx), fy: clamp01(fy) };
    }
  }
  return out;
};

export interface PlaceMargins {
  readonly top: number;
  readonly bottom: number;
}

/** Named places the pill snaps to. `fx` is across the free width; `y` is "top", "middle" or "bottom". */
export const PLACES = [
  { id: "top-left", label: "Top left", fx: 0, row: "top" },
  { id: "top", label: "Top", fx: 0.5, row: "top" },
  { id: "top-right", label: "Top right", fx: 1, row: "top" },
  { id: "centre", label: "Centre", fx: 0.5, row: "middle" },
  { id: "bottom-left", label: "Bottom left", fx: 0, row: "bottom" },
  { id: "bottom", label: "Bottom", fx: 0.5, row: "bottom" },
  { id: "bottom-right", label: "Bottom right", fx: 1, row: "bottom" },
] as const;
export type PlaceId = (typeof PLACES)[number]["id"];

export const placePosition = (
  area: Area,
  size: { readonly width: number; readonly height: number },
  id: PlaceId,
  margins: PlaceMargins,
): { readonly x: number; readonly y: number } => {
  const place = PLACES.find((p) => p.id === id)!;
  const x = Math.round(area.x + place.fx * Math.max(0, area.width - size.width));
  const y =
    place.row === "top"
      ? area.y + margins.top
      : place.row === "bottom"
        ? area.y + area.height - size.height - margins.bottom
        : Math.round(area.y + (area.height - size.height) / 2);
  return { x, y };
};

/** Free placement is stepped to this many divisions of the free space, so a dragged pill lines up. */
export const GRID_STEPS = 24;
/** Near a named place the pill is pulled onto it. */
export const MAGNET_PX = 40;

/**
 * Where a drag lands: onto a named place when near one, else onto the grid. `bypass` (Alt or Shift
 * held) leaves the position alone, so free placement stays one key away. Always inside the area.
 */
export const snapPosition = (
  area: Area,
  size: { readonly width: number; readonly height: number },
  at: { readonly x: number; readonly y: number },
  options: { readonly bypass: boolean; readonly margins: PlaceMargins },
): { readonly x: number; readonly y: number; readonly place: PlaceId | null } => {
  const maxX = area.x + Math.max(0, area.width - size.width);
  const maxY = area.y + Math.max(0, area.height - size.height);
  const inside = {
    x: Math.min(Math.max(at.x, area.x), maxX),
    y: Math.min(Math.max(at.y, area.y), maxY),
  };
  if (options.bypass) return { x: Math.round(inside.x), y: Math.round(inside.y), place: null };
  let best: { id: PlaceId; x: number; y: number; d: number } | null = null;
  for (const place of PLACES) {
    const p = placePosition(area, size, place.id, options.margins);
    const d = Math.hypot(p.x - inside.x, p.y - inside.y);
    if (d <= MAGNET_PX && (best === null || d < best.d)) best = { id: place.id, ...p, d };
  }
  if (best !== null) return { x: best.x, y: best.y, place: best.id };
  const stepX = Math.max(1, (area.width - size.width) / GRID_STEPS);
  const stepY = Math.max(1, (area.height - size.height) / GRID_STEPS);
  return {
    x: Math.round(Math.min(maxX, area.x + Math.round((inside.x - area.x) / stepX) * stepX)),
    y: Math.round(Math.min(maxY, area.y + Math.round((inside.y - area.y) / stepY) * stepY)),
    place: null,
  };
};

/** Whether the cursor is over the capsule (a box inside the window), with a little reach around it. */
export const cursorOverCapsule = (
  cursor: { readonly x: number; readonly y: number },
  window: Area,
  capsule: Area,
  pad = 6,
): boolean =>
  cursor.x >= window.x + capsule.x - pad &&
  cursor.x <= window.x + capsule.x + capsule.width + pad &&
  cursor.y >= window.y + capsule.y - pad &&
  cursor.y <= window.y + capsule.y + capsule.height + pad;

export interface Screen {
  readonly id: number;
  readonly bounds: Area;
  readonly workArea: Area;
}

const inside = (area: Area, x: number, y: number): boolean =>
  x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;

const overlap = (a: Area, b: Area): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * The screen where the work is, all in DIP: the one holding most of the target window, else the cursor's, else the
 * primary. Picked when the pill appears or the target changes, never as the cursor moves.
 */
export const pickScreen = <S extends Screen>(
  screens: ReadonlyArray<S>,
  primary: S,
  at: {
    readonly window?: Area | null;
    readonly cursor?: { readonly x: number; readonly y: number } | null;
  },
): S => {
  const { window, cursor } = at;
  if (window != null) {
    const most = screens
      .map((s) => ({ s, shared: overlap(s.bounds, window) }))
      .sort((a, b) => b.shared - a.shared)[0];
    if (most !== undefined && most.shared > 0) return most.s;
  }
  const byCursor =
    cursor == null ? undefined : screens.find((s) => inside(s.bounds, cursor.x, cursor.y));
  return byCursor ?? primary;
};

/** His one place for every screen; a place saved per screen by an older version stands in until he moves it again. */
export const sharedSpot = (spots: Readonly<Record<string, Spot>>): Spot | undefined =>
  spots["any"] ?? Object.values(spots)[0];
