/**
 * Her shapeshift's clock (the passed v4 morph, M-149/M-156): when each part of the change runs, as pure numbers, so
 * every surface plays the same change. The renderer (apps/web/src/body/formMorph.ts) only draws these shares.
 * "in" is cartoon -> body, "out" is body -> cartoon. Frames are v4's, at 24 fps.
 */

export type MorphLook = "original" | "water";
export type MorphDir = "in" | "out";

export const MORPH = {
  FPS: 24,
  SPAN: 30,
  DUR: 20,
  /** How far the hug runs ahead at her crown over her feet (share of SPAN). */
  HSTAG: 0.12,
  LEAD: {
    plain: -0.15,
    hug: 0,
    wipe: 0.4,
    wipeWet: 0.3,
    pp: 0.15,
    rise: 0,
    torso: 0.2,
    face: 0.05,
  },
  DURS: { plain: 6, wipe: 14, pp: 14, hug: 14, face: 13 },
} as const;

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** v4's w_part: "in" runs 0 -> 1 (cartoon -> body), "out" runs 1 -> 0; u = frames since the change began. */
export function wPart(lead: number, dur: number, u: number, dir: MorphDir): number {
  const { SPAN, DUR } = MORPH;
  return dir === "in"
    ? smooth((u - lead * SPAN) / dur)
    : 1 - smooth((u - ((1 - lead) * SPAN + DUR - dur)) / dur);
}

// each half's window in v4 frames: "in" from the drawing's first fade to the last part's arrival, "out" from the
// wipe's start to the drawing's return
const IN_U = [MORPH.LEAD.plain * MORPH.SPAN, MORPH.LEAD.torso * MORPH.SPAN + MORPH.DUR] as const;
const OUT_U = [
  (1 - MORPH.LEAD.torso) * MORPH.SPAN - 1,
  (1 - MORPH.LEAD.plain) * MORPH.SPAN + MORPH.DUR,
] as const;

/** How long a change takes (s). */
export const morphSeconds = (dir: MorphDir) =>
  (dir === "in" ? IN_U[1] - IN_U[0] : OUT_U[1] - OUT_U[0]) / MORPH.FPS;

interface MorphFrame {
  /** v4 frame of the change. */
  readonly u: number;
  /** The drawing gone plain (0 drawn, 1 plain). */
  readonly plain: number;
  /** Her surface resolved from the crown down (0 none, 1 all of her). */
  readonly wipe: number;
  /** Her proportions in place of the cartoon's (pp). */
  readonly pp: number;
  /** The loaf's own motion (hop, facing the camera) still in it. */
  readonly loaf: number;
  /** How much of the drawn face still shows: it rides the forming skin and fades as the drawing goes plain. */
  readonly face: number;
  /** How far the skin has hugged her at height share h (0 feet, 1 crown). */
  readonly hug: (h: number) => number;
  /** The share of the way from the first form to the second (its travel speed blends by it). */
  readonly prog: number;
  readonly done: boolean;
}

/** Where a change is `t` seconds after it began. */
export function morphAt(dir: MorphDir, t: number, look: MorphLook = "original"): MorphFrame {
  const { LEAD, DURS, DUR, HSTAG } = MORPH;
  const u = (dir === "in" ? IN_U[0] : OUT_U[0]) + t * MORPH.FPS;
  const wipe0 = wPart(look === "water" ? LEAD.wipeWet : LEAD.wipe, DURS.wipe, u, dir);
  const torso = wPart(LEAD.torso, DUR, u, dir);
  // the face's travel share; it is gone (melted into the skin) by the time it would have reached her head
  const k = wPart(LEAD.face, DURS.face, u, dir);
  return {
    u,
    plain: wPart(LEAD.plain, DURS.plain, u, dir),
    // water: the last of the skin leaves sooner, so no puddle lingers at her feet
    wipe: look === "water" ? 1 - (1 - wipe0) ** 1.6 : wipe0,
    pp: wPart(LEAD.pp, DURS.pp, u, dir),
    loaf: 1 - wPart(LEAD.rise, DUR, u, dir),
    face: 1 - smooth((k - 0.05) / 0.5),
    hug: (h) => wPart(LEAD.hug + (dir === "out" ? h : 1 - h) * HSTAG, DURS.hug, u, dir),
    prog: dir === "in" ? torso : 1 - torso,
    done: t >= morphSeconds(dir),
  };
}
