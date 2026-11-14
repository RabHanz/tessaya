/**
 * Tessaya's tray mark: the logo's own hinted cut (white on a dark taskbar, black on a light one) with
 * one small dot in the corner for the state, and a second for an update. The logo's pixels come from
 * `trayArt.ts`; this file only adds the dots, so it stays pure and testable. `markSvg` is still the
 * state-coloured tile the Home status uses.
 */
import { MARK_MASTER_PATH, MARK_REVERSED_PATH } from "./trayArt.ts";

export interface MarkOptions {
  readonly color: string;
  /** Listening, screen capture, acting without asking. */
  readonly caps: readonly [boolean, boolean, boolean];
  readonly muted: boolean;
  /** An update is ready: a small dot in the corner, drawn on the tray bitmap. */
  readonly badge?: boolean;
}

/** The kit's colour mark puts the dye on the left and middle strips: the third and fifth pieces of each drawing. */
const DYE_PIECES = [2, 4];
const cut = (path: string, cls: string): string => {
  const pieces = path.split(/(?=M)/);
  const part = (dye: boolean) => pieces.filter((_, i) => DYE_PIECES.includes(i) === dye).join("");
  return `<path class="${cls}" fill="currentColor" d="${part(false)}"/><path class="${cls} dye" fill="currentColor" d="${part(true)}"/>`;
};

/**
 * The mark for the window, from 48 px up, as the kit's colour mark: the master drawing in the page's ink with
 * the dye strips in the page's accent (styled by the page), and its slightly thinner reversed cut for light on
 * dark, shown by theme. Under 48 px the hinted cuts are used instead (tray, pill).
 */
export const brandMarkSvg = (): string =>
  `<svg class="mk" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Tessaya">${cut(MARK_MASTER_PATH, "on-light")}${cut(MARK_REVERSED_PATH, "on-dark")}</svg>`;

const BOX = 32;
const RADIUS = 8;
const BAR_W = 4;
const BARS: ReadonlyArray<{ readonly x: number; readonly h: number }> = [
  { x: 9.5, h: 11 },
  { x: 16, h: 19 },
  { x: 22.5, h: 14 },
];
const OFF_ALPHA = 0.38;
const SLASH = { x1: 6.5, y1: 25.5, x2: 25.5, y2: 6.5, w: 3 };

const rgb = (color: string) =>
  [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)) as [number, number, number];

/** The status tile as SVG (the Home page's state mark). */
export const markSvg = (o: MarkOptions): string => {
  const bars = BARS.map((b, i) => {
    const lit = o.caps[i]! && !o.muted;
    return `<rect x="${b.x - BAR_W / 2}" y="${16 - b.h / 2}" width="${BAR_W}" height="${b.h}" rx="${BAR_W / 2}" fill="#fff" fill-opacity="${lit ? 1 : OFF_ALPHA}"/>`;
  }).join("");
  const slash = o.muted
    ? `<line x1="${SLASH.x1}" y1="${SLASH.y1}" x2="${SLASH.x2}" y2="${SLASH.y2}" stroke="#fff" stroke-width="${SLASH.w}" stroke-linecap="round"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}"><rect width="${BOX}" height="${BOX}" rx="${RADIUS}" fill="${o.color}"/>${bars}${slash}</svg>`;
};

/** The update dot's colour: Tessaya's madder on dark, its dye on light. */
const BADGE_ON_DARK = "#D8505C";
const BADGE_ON_LIGHT = "#8E1F2F";

/**
 * Adds the state to the logo's BGRA bitmap: a dot bottom right in the state colour, with a ring of bare
 * pixels round it so it reads on the mark; and, when an update is ready, a dot top right. The mark
 * itself is untouched. `size` is the bitmap's side.
 */
export const withTrayState = (
  bgra: Buffer,
  size: number,
  o: MarkOptions,
  onDark: boolean,
): Buffer => {
  const out = Buffer.from(bgra);
  const dot = (cx: number, cy: number, r: number, [rr, gg, bb]: [number, number, number]) => {
    const ring = r + Math.max(0.6, size / 24);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const at = (y * size + x) * 4;
        if (d <= r) out.set([bb, gg, rr, 255], at);
        else if (d <= ring) out.set([0, 0, 0, 0], at);
      }
    }
  };
  const r = Math.max(1.8, size * 0.13);
  dot(size - r - 0.5, size - r - 0.5, r, rgb(o.color));
  if (o.badge === true)
    dot(size - r - 0.5, r + 0.5, r, rgb(onDark ? BADGE_ON_DARK : BADGE_ON_LIGHT));
  return out;
};
