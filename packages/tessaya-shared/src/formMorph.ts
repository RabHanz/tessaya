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
  /**
   * One form to another (her body <-> an animal), in v4 frames: the "out" half stops as the skin has nearly covered the
   * first form and the "in" half starts already moving, so no plain column stands between them (Director 28 Nov).
   */
  M2M: { COVER: 36, IN0: 3 },
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

/**
 * One form to another (her body <-> an animal, M2M): the skin closes over the first form ("cover", v4's "out" half up
 * to M2M.COVER), then reshapes from it into the second and lets the second's colours through ("reveal", the "in" half
 * from M2M.IN0). The skin stays plain throughout and holds the first form until "reveal" moves it.
 */
interface SwapFrame {
  /** The visible form's surface resolved from the crown down (cover: the first going, reveal: the second coming). */
  readonly wipe: number;
  readonly pp: number;
  /** How far the skin has moved from the first form onto the second at height share h (reveal only; cover is 0). */
  readonly hug: (h: number) => number;
  /** The share of the way from the first form to the second, continuous across the hand-over. */
  readonly prog: number;
  readonly done: boolean;
}
const SWAP_U = { cover: [OUT_U[0], MORPH.M2M.COVER], reveal: [MORPH.M2M.IN0, IN_U[1]] } as const;

/** How long each half of a form-to-form change takes (s). */
export const swapSeconds = (half: "cover" | "reveal") =>
  (SWAP_U[half][1] - SWAP_U[half][0]) / MORPH.FPS;

/** Where a form-to-form change's half is `t` seconds after it began. */
export function swapAt(
  half: "cover" | "reveal",
  t: number,
  look: MorphLook = "original",
): SwapFrame {
  const { LEAD, DURS, DUR, HSTAG, M2M } = MORPH;
  const u = SWAP_U[half][0] + t * MORPH.FPS;
  const dir: MorphDir = half === "cover" ? "out" : "in";
  const wipe0 = wPart(look === "water" ? LEAD.wipeWet : LEAD.wipe, DURS.wipe, u, dir);
  const torso = wPart(LEAD.torso, DUR, u, dir);
  const coverEnd = 1 - wPart(LEAD.torso, DUR, M2M.COVER, "out");
  const reveal0 = wPart(LEAD.torso, DUR, M2M.IN0, "in");
  return {
    wipe: look === "water" ? 1 - (1 - wipe0) ** 1.6 : wipe0,
    pp: wPart(LEAD.pp, DURS.pp, u, dir),
    hug: (h) => (half === "cover" ? 0 : wPart(LEAD.hug + (1 - h) * HSTAG, DURS.hug, u, "in")),
    prog:
      half === "cover"
        ? (0.5 * (1 - torso)) / coverEnd
        : 0.5 + (0.5 * (torso - reveal0)) / (1 - reveal0),
    done: t >= swapSeconds(half),
  };
}

/** A bird's flight after it arrives (morph-live owl): crouch, a deep first beat lifts it, slow beats and flat glides. */
export const OWL = {
  LIFT: 0.65,
  READY: 0.85,
  beat: 0.95,
  beats: 2,
  glide: 1.3,
  height: 0.85,
  perch: 0.5,
} as const;

/** The owl `u` seconds into a flight of `span` seconds that ends landed: wing phase, glide, height share and crouch. */
export function owlAt(u: number, span: number) {
  const { LIFT, READY, beat, beats, glide } = OWL;
  const land = span - 0.35;
  const cyc = beats * beat + glide;
  const c = Math.max(0, u - LIFT - 2 * beat) % cyc;
  let phase =
    u < LIFT ? READY + (1 - READY) * smooth((u - 0.3) / (LIFT - 0.3)) : ((u - LIFT) / beat) % 1;
  let gl =
    u > LIFT + 2 * beat
      ? smooth((c - beats * beat) / 0.3) * (1 - smooth((c - cyc + 0.3) / 0.3))
      : 0;
  // glides in to land, then wings back up, ready
  gl = Math.max(gl, smooth((u - (land - 0.9)) / 0.3));
  if (u > land) {
    gl = 1 - smooth((u - land) / 0.3);
    phase = READY;
  }
  const air = smooth(Math.min((u - LIFT) / 1.2, (land - u) / 1.2));
  const crouch = u < LIFT + 0.15 ? Math.sin(Math.PI * Math.min(1, u / (LIFT + 0.15))) : 0;
  return { phase, glide: gl, air, crouch, done: u >= span };
}
