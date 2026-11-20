/**
 * Contact as one system: where a contact is placed on her, and what her skin makes of it. Two-hand skills (a clap, a
 * rub) and touches name a place by intent ("above her head", "to her left") or give a point in her trunk's frame;
 * the renderer closes the skin there on her own body, and every contact it makes is felt through the same nerves.
 */

/** A point in her trunk's frame on the 1.6 m body, from her upper chest: [ahead, up, to her left] in metres. */
export type TrunkPoint = readonly [number, number, number];

/** Where two hands meet, by intent: in front of her sternum (a normal clap), overhead, low behind her back, or out to a side. */
export const CONTACT_PLACES = {
  chest: [0.24, -0.08, 0],
  overhead: [0.1, 0.34, 0],
  behind: [-0.2, -0.4, 0],
  left: [0.26, -0.06, 0.16],
  right: [0.26, -0.06, -0.16],
} as const satisfies Record<string, TrunkPoint>;
export type ContactPlace = keyof typeof CONTACT_PLACES;
export const isContactPlace = (v: unknown): v is ContactPlace =>
  typeof v === "string" && Object.hasOwn(CONTACT_PLACES, v);

/** A place by name, or a point (clamped to her reach: within 0.75 m of her upper chest). */
export const contactPoint = (where: ContactPlace | TrunkPoint | undefined): TrunkPoint => {
  if (where === undefined) return CONTACT_PLACES.chest;
  if (isContactPlace(where)) return CONTACT_PLACES[where];
  const r = Math.hypot(...where);
  const k = r > 0.75 ? 0.75 / r : 1;
  return [where[0] * k, where[1] * k, where[2] * k];
};

/** Palms flat (a sharp clap, the most skin) or cupped (a hollow one, about a third of it). */
export const PALM_SHAPES = ["flat", "cupped"] as const;
export type PalmShape = (typeof PALM_SHAPES)[number];

/**
 * What her skin reads from a contact as it is made: the impact's speed (m/s) presses hardest at the moment of impact
 * and eases over ~80 ms as the skin settles, the overlap of skin on skin (m) presses for as long as it lasts. Pressure
 * is 0..1 (her nociceptors start near 0.85: a hard clap stings, a gentle one barely registers).
 */
export const contactFeel = (c: {
  readonly impact: number;
  readonly sinceMs: number;
  readonly depth: number;
  readonly areaCm2: number;
  readonly slideCmS?: number;
}): { readonly pressure: number; readonly areaCm2: number; readonly cmPerS: number } => {
  const hit = (Math.max(0, c.impact) / 1.3) * Math.exp(-Math.max(0, c.sinceMs) / 80);
  const press = Math.max(0, c.depth) / 0.004;
  return {
    pressure: Math.round(1000 * (1 - Math.exp(-(hit + press + 0.15)))) / 1000,
    areaCm2: Math.round(c.areaCm2 * 10) / 10,
    cmPerS: c.slideCmS ?? 0,
  };
};
