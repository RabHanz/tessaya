/**
 * Her skin as nerves, not flags (M-068): a contact on a region drives each receptor population there to fire over
 * time, with its own threshold, adaptation, habituation and sensitisation. Regions and receptor types are data packs
 * (any pack may add or override a region, private ones only behind the gate); the engine names no body part. Pure and
 * clock-free, and it holds state only while a contact is live or still fading, so it costs nothing at rest.
 */

/** A receptor population's response: fast types fire at onset and offset, slow ones while held. */
export interface ReceptorType {
  readonly id: string;
  readonly adapt: "fast" | "slow";
  /** Pressure (0..1) below which it stays silent. */
  readonly threshold: number;
  /** Peak firing (spikes a second) of one receptor. */
  readonly peakHz: number;
  /** Stroke speed it prefers (cm/s), when it is speed-tuned: C-tactile afferents peak near 3 cm/s. */
  readonly bestCmPerS?: number;
  /** It reads a stroke only on hairy skin. */
  readonly hairyOnly?: boolean;
  /**
   * What drives it, when not touch: the skin stretched or a pull on hair (`stretch`, 0..1), or warmth or cold against
   * her skin's own ~33 °C (`warm`, `cold`). Touch types leave it out.
   */
  readonly drive?: "stretch" | "warm" | "cold";
}
/**
 * The general human receptor types, from the literature: Meissner-like light touch (fast; Johnson 2001), C-tactile
 * caress (slow, tuned to 1–10 cm/s, best ~3 cm/s, hairy skin only; Löken et al. 2009), Merkel-like pressure (slow),
 * Pacinian vibration (fast; Bolanowski et al. 1988), and a high-threshold nociceptive population (too much).
 */
export const CORE_RECEPTORS: ReadonlyArray<ReceptorType> = [
  { id: "light", adapt: "fast", threshold: 0.02, peakHz: 80 },
  { id: "caress", adapt: "slow", threshold: 0.01, peakHz: 50, bestCmPerS: 3, hairyOnly: true },
  { id: "pressure", adapt: "slow", threshold: 0.15, peakHz: 60 },
  { id: "vibration", adapt: "fast", threshold: 0.05, peakHz: 300 },
  { id: "noci", adapt: "slow", threshold: 0.85, peakHz: 40 },
  // Ruffini-like endings answer skin stretched and hair pulled, slowly adapting (Johansson & Vallbo 1979)
  { id: "stretch", adapt: "slow", threshold: 0.05, peakHz: 40, drive: "stretch" },
  // warm and cold fibres answer a step from skin temperature, then adapt (Hensel 1973)
  { id: "warm", adapt: "fast", threshold: 0.1, peakHz: 30, drive: "warm" },
  { id: "cold", adapt: "fast", threshold: 0.1, peakHz: 40, drive: "cold" },
];

/**
 * Where an agent's hand lands on a region: between two bones (`at` along them, then `up` of her height above), and
 * the side it comes from (she faces +z, her right is -x), so a pat on the head lands on top, not on her face.
 */
export interface SenseReach {
  readonly from: string;
  readonly to: string;
  readonly at: number;
  readonly up: number;
  readonly dir: readonly [number, number, number];
}
type P3 = readonly [number, number, number];
/** A region of skin: where it is on the skeleton, how dense its receptors are, and whether it is hairy. */
export interface SenseRegion {
  readonly id: string;
  /**
   * A humanoid bone (or a pack's custom bone, by its node name), and the bone it runs toward: the region is that
   * segment. With `radius` (m) a touch within that capsule is this region, ahead of the general map's own split.
   * `offset` (m) moves its centre and `radii` (m) make it an ellipsoid, both in the bone's own frame (the model's
   * axes at rest, facing +z, turning with the bone), so many regions can share one bone without nesting.
   */
  readonly anchor: {
    readonly bone: string;
    readonly to?: string;
    readonly radius?: number;
    readonly offset?: P3;
    readonly radii?: P3;
  };
  readonly reach?: SenseReach;
  /**
   * On a flat form with no skeleton (the desk's cartoon): the boxes it covers in that form's own frame, x across her
   * body -1 (her right as he sees her, his left) to 1, y from the top of her head (0) to her feet (1).
   */
  readonly areas?: ReadonlyArray<{
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  }>;
  /** Two-point discrimination threshold (mm): density follows from it (fingertips ~2–3, back ~40). */
  readonly twoPointMm: number;
  readonly hairy: boolean;
  /** Only behind the private gate. */
  readonly private?: boolean;
  /** Its own receptor gains (0..1), when they differ from the type's defaults. */
  readonly gain?: Readonly<Record<string, number>>;
}
/**
 * A reflex arc: when a population on a region fires past `over` (0..1 of each fibre's peak), the body acts after `latencyMs`, before her brain
 * hears of it. `regions` limits it (all regions when absent). Actions the body knows: withdraw (pull the part away),
 * flinch (a quick startle of the whole trunk), leanIn (give toward the hand), turnToward (head and eyes to it).
 */
export const REFLEX_ACTIONS = ["withdraw", "flinch", "leanIn", "turnToward"] as const;
export type ReflexAction = (typeof REFLEX_ACTIONS)[number];
export interface ReflexArc {
  readonly id: string;
  readonly receptor: string;
  readonly over: number;
  readonly action: ReflexAction;
  readonly latencyMs: number;
  /** 0..1, how strongly the body acts. */
  readonly strength: number;
  readonly regions?: ReadonlyArray<string>;
}
export interface SensePack {
  readonly version: 1;
  readonly id: string;
  readonly receptors?: ReadonlyArray<ReceptorType>;
  readonly regions: ReadonlyArray<SenseRegion>;
  readonly reflexes?: ReadonlyArray<ReflexArc>;
}

/**
 * The general human map: the region set her touch already uses, with two-point thresholds from Weinstein (1968) and
 * Mancini et al. (2014). Regions of a private moment are tagged so; a pack adds an earlobe the same way.
 */
export const HUMAN_SENSE: SensePack = {
  version: 1,
  id: "human",
  receptors: CORE_RECEPTORS,
  regions: [
    {
      id: "head",
      anchor: { bone: "head" },
      twoPointMm: 20,
      hairy: true,
      reach: { from: "head", to: "head", at: 0, up: 0.07, dir: [0, 1, 0.3] },
    },
    {
      id: "hair",
      anchor: { bone: "head" },
      twoPointMm: 25,
      hairy: true,
      reach: { from: "head", to: "head", at: 0, up: 0.06, dir: [0, 0.6, -1] },
    },
    {
      id: "face",
      anchor: { bone: "head" },
      twoPointMm: 7,
      hairy: false,
      reach: { from: "head", to: "head", at: 0, up: 0.04, dir: [0, 0, 1] },
    },
    {
      id: "neck",
      anchor: { bone: "neck", to: "head" },
      twoPointMm: 35,
      hairy: true,
      reach: { from: "neck", to: "head", at: 0.5, up: 0, dir: [0, 0, 1] },
    },
    {
      id: "shoulder",
      anchor: { bone: "leftShoulder", to: "leftUpperArm" },
      twoPointMm: 40,
      hairy: true,
      reach: { from: "rightUpperArm", to: "rightUpperArm", at: 0, up: 0, dir: [-0.3, 1, 0] },
    },
    {
      id: "arm",
      anchor: { bone: "leftLowerArm", to: "leftHand" },
      twoPointMm: 38,
      hairy: true,
      reach: { from: "rightUpperArm", to: "rightLowerArm", at: 0.5, up: 0, dir: [-1, 0, 0.2] },
    },
    {
      id: "hand",
      anchor: { bone: "leftHand" },
      twoPointMm: 10,
      hairy: false,
      reach: { from: "rightHand", to: "rightHand", at: 0, up: 0, dir: [-1, 0.4, 0] },
    },
    {
      id: "back",
      anchor: { bone: "spine", to: "upperChest" },
      twoPointMm: 42,
      hairy: true,
      reach: { from: "chest", to: "upperChest", at: 0.5, up: 0, dir: [0, 0, -1] },
    },
    {
      id: "leg",
      anchor: { bone: "leftLowerLeg", to: "leftFoot" },
      twoPointMm: 40,
      hairy: true,
      reach: { from: "rightLowerLeg", to: "rightFoot", at: 0.4, up: 0, dir: [0, 0, 1] },
    },
    {
      id: "foot",
      anchor: { bone: "leftFoot" },
      twoPointMm: 20,
      hairy: false,
      reach: { from: "rightFoot", to: "rightFoot", at: 0, up: 0, dir: [0, 1, 0.5] },
    },
    {
      id: "chest",
      anchor: { bone: "upperChest" },
      twoPointMm: 36,
      hairy: true,
      private: true,
      reach: { from: "chest", to: "upperChest", at: 0.5, up: 0, dir: [0, 0, 1] },
    },
    {
      id: "belly",
      anchor: { bone: "spine" },
      twoPointMm: 34,
      hairy: true,
      private: true,
      reach: { from: "spine", to: "spine", at: 0, up: 0, dir: [0, 0, 1] },
    },
    {
      id: "waist",
      anchor: { bone: "spine" },
      twoPointMm: 38,
      hairy: true,
      private: true,
      reach: { from: "spine", to: "spine", at: 0, up: 0, dir: [-1, 0, 0] },
    },
    {
      id: "hips",
      anchor: { bone: "hips" },
      twoPointMm: 40,
      hairy: true,
      private: true,
      reach: { from: "hips", to: "hips", at: 0, up: 0, dir: [-1, 0, 0] },
    },
    {
      id: "thigh",
      anchor: { bone: "leftUpperLeg", to: "leftLowerLeg" },
      twoPointMm: 42,
      hairy: true,
      private: true,
      reach: { from: "rightUpperLeg", to: "rightLowerLeg", at: 0.4, up: 0, dir: [0, 0, 1] },
    },
  ],
  /**
   * Spinal withdrawal from a noxious touch (~60–100 ms in people), a startle at a sudden firm onset, an orienting turn
   * of head and eyes (~150 ms), and the slower lean into a caress near the C-tactile optimum.
   */
  reflexes: [
    {
      id: "withdraw",
      receptor: "noci",
      over: 0.01,
      action: "withdraw",
      latencyMs: 80,
      strength: 1,
    },
    {
      id: "startle",
      receptor: "light",
      over: 0.35,
      action: "flinch",
      latencyMs: 100,
      strength: 0.6,
    },
    {
      id: "orient",
      receptor: "light",
      over: 0.1,
      action: "turnToward",
      latencyMs: 150,
      strength: 0.5,
    },
    { id: "lean", receptor: "caress", over: 0.15, action: "leanIn", latencyMs: 400, strength: 0.4 },
  ],
};

/** Packs merged in order: a later pack's region or receptor replaces an earlier one of the same id. */
export const mergeSense = (packs: ReadonlyArray<SensePack>, privateOk: boolean) => {
  const receptors = new Map<string, ReceptorType>();
  const regions = new Map<string, SenseRegion>();
  const reflexes = new Map<string, ReflexArc>();
  for (const p of packs) {
    for (const r of p.receptors ?? []) receptors.set(r.id, r);
    for (const r of p.regions) if (privateOk || r.private !== true) regions.set(r.id, r);
    for (const r of p.reflexes ?? []) reflexes.set(r.id, r);
  }
  return { receptors: [...receptors.values()], regions, reflexes: [...reflexes.values()] };
};
export type SenseMap = ReturnType<typeof mergeSense>;

/** A pack off disk, checked; each error names where and how to fix it. */
export const decodeSensePack = (
  raw: unknown,
):
  | { readonly ok: true; readonly pack: SensePack }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> } => {
  const errors: string[] = [];
  const o = raw as Partial<SensePack> | null;
  if (o === null || typeof o !== "object")
    return { ok: false, errors: ["a sense pack is an object"] };
  if (o.version !== 1) errors.push("version: must be 1");
  if (typeof o.id !== "string" || o.id === "") errors.push("id: name the pack");
  if (!Array.isArray(o.regions))
    errors.push("regions: a list of {id, anchor: {bone}, twoPointMm, hairy}");
  for (const [i, r] of (Array.isArray(o.regions) ? o.regions : []).entries()) {
    if (typeof r?.id !== "string") errors.push(`regions[${i}].id: name the region`);
    if (typeof r?.anchor?.bone !== "string")
      errors.push(`regions[${i}].anchor.bone: the bone it sits on`);
    if (typeof r?.twoPointMm !== "number" || r.twoPointMm < 1 || r.twoPointMm > 80)
      errors.push(`regions[${i}].twoPointMm: 1 to 80 (fingertips ~2, back ~40)`);
    if (typeof r?.hairy !== "boolean") errors.push(`regions[${i}].hairy: true or false`);
  }
  for (const [i, r] of (Array.isArray(o.regions) ? o.regions : []).entries()) {
    const radius = r?.anchor?.radius;
    if (radius !== undefined && (typeof radius !== "number" || radius < 0.005 || radius > 0.5))
      errors.push(`regions[${i}].anchor.radius: 0.005 to 0.5 m, or leave it out`);
    const triple = (v: unknown, lo: number, hi: number) =>
      v === undefined ||
      (Array.isArray(v) &&
        v.length === 3 &&
        v.every((x) => typeof x === "number" && x >= lo && x <= hi));
    if (!triple(r?.anchor?.offset, -0.5, 0.5))
      errors.push(`regions[${i}].anchor.offset: [x, y, z] within ±0.5 m, or leave it out`);
    if (!triple(r?.anchor?.radii, 0.005, 0.5))
      errors.push(`regions[${i}].anchor.radii: [x, y, z] of 0.005 to 0.5 m, or leave it out`);
    const areas = r?.areas;
    if (
      areas !== undefined &&
      !(
        Array.isArray(areas) &&
        areas.every(
          (a) =>
            [a?.x0, a?.x1].every((v) => typeof v === "number" && v >= -1 && v <= 1) &&
            [a?.y0, a?.y1].every((v) => typeof v === "number" && v >= 0 && v <= 1) &&
            a.x0 < a.x1 &&
            a.y0 < a.y1,
        )
      )
    )
      errors.push(
        `regions[${i}].areas: [{x0, y0, x1, y1}], x -1 to 1 and y 0 to 1, or leave it out`,
      );
    const reach = r?.reach;
    if (
      reach !== undefined &&
      (typeof reach?.from !== "string" ||
        typeof reach.to !== "string" ||
        !Array.isArray(reach.dir) ||
        reach.dir.length !== 3)
    )
      errors.push(`regions[${i}].reach: {from, to, at, up, dir: [x, y, z]} or leave it out`);
  }
  for (const [i, r] of (Array.isArray(o.receptors) ? o.receptors : []).entries())
    if (typeof r?.id !== "string" || (r.adapt !== "fast" && r.adapt !== "slow"))
      errors.push(`receptors[${i}]: {id, adapt: fast or slow, threshold, peakHz}`);
  for (const [i, r] of (Array.isArray(o.reflexes) ? o.reflexes : []).entries())
    if (
      typeof r?.id !== "string" ||
      typeof r.receptor !== "string" ||
      typeof r.over !== "number" ||
      r.over < 0 ||
      r.over > 1 ||
      !(REFLEX_ACTIONS as ReadonlyArray<unknown>).includes(r.action) ||
      typeof r.latencyMs !== "number" ||
      r.latencyMs < 0 ||
      r.latencyMs > 2000
    )
      errors.push(
        `reflexes[${i}]: {id, receptor, over 0 to 1, action: ${REFLEX_ACTIONS.join(" or ")}, latencyMs 0 to 2000, strength}`,
      );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, pack: o as SensePack };
};

/** One contact on a region now: how firmly (0..1), how fast it moves (cm/s), over how much skin (cm²), and buzzing. */
export interface Contact {
  readonly region: string;
  readonly pressure: number;
  readonly cmPerS: number;
  readonly areaCm2: number;
  readonly vibrationHz?: number;
  /** How far the skin is stretched or the hair pulled (0..1). */
  readonly stretch?: number;
  /** What touches her is this warm (°C); her skin sits near 33. */
  readonly tempC?: number;
}
const SKIN_C = 33;

/** Per region: how worn it is by repeated touch (habituation), how raw after too much (sensitisation), and the last contact. */
export interface SenseState {
  readonly at: number;
  readonly sites: Readonly<
    Record<
      string,
      {
        readonly habit: number;
        readonly sens: number;
        readonly pressure: number;
        readonly since: number;
        /** The fast fibres' onset energy: recent changes of pressure, leaking away over FAST_TAU_MS. */
        readonly fast?: number;
      }
    >
  >;
}
export const NO_SENSE: SenseState = { at: 0, sites: {} };
const HABIT_TAU_MS = 20_000;
const SENS_TAU_MS = 60_000;
const FAST_TAU_MS = 100;
/** Steps closer than this are one contact going on (a body's frames); further apart, each is a new touch. */
const SAME_CONTACT_MS = 250;

/** Receptors under a contact: density from two-point discrimination (per cm², ~1/d²), times the skin it covers. */
const countUnder = (r: SenseRegion, areaCm2: number) => {
  const perCm2 = 100 / (r.twoPointMm * r.twoPointMm);
  return perCm2 * Math.max(0.5, areaCm2);
};

/**
 * One step of her skin: each live contact fires each population on its region (spikes a second, summed over the
 * receptors it covers), and the state carries habituation and sensitisation on. Fast types answer the change of
 * pressure, slow ones the pressure held; a caress fibre answers a stroke near its best speed on hairy skin; past the
 * noxious threshold she is sensitised for a while.
 */
export const fire = (
  map: SenseMap,
  state: SenseState,
  contacts: ReadonlyArray<Contact>,
  now: number,
): {
  readonly state: SenseState;
  readonly rates: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** How hard each fibre fires, 0..1 of its peak, before the count of fibres under the touch. */
  readonly levels: Readonly<Record<string, Readonly<Record<string, number>>>>;
} => {
  const dt = Math.max(0, now - state.at);
  const decayed: Record<string, SenseState["sites"][string]> = {};
  for (const [id, s] of Object.entries(state.sites))
    decayed[id] = {
      ...s,
      habit: s.habit * Math.exp(-dt / HABIT_TAU_MS),
      sens: s.sens * Math.exp(-dt / SENS_TAU_MS),
    };
  // a site is kept while it is still worn or raw, and forgotten after
  const sites: Record<string, SenseState["sites"][string]> = Object.fromEntries(
    Object.entries(decayed)
      .filter(([, s]) => s.habit > 0.01 || s.sens > 0.01)
      .map(([id, s]) => [id, { ...s, pressure: 0 }]),
  );
  const rates: Record<string, Record<string, number>> = {};
  const levels: Record<string, Record<string, number>> = {};
  for (const c of contacts) {
    const region = map.regions.get(c.region);
    if (region === undefined) continue;
    const was = decayed[c.region];
    const p = Math.max(0, Math.min(1, c.pressure));
    // called every frame or once a touch, the same: fast fibres sum the recent changes, a new touch is all change
    const going = was !== undefined && was.pressure > 0 && dt < SAME_CONTACT_MS;
    const fast =
      (going ? (was.fast ?? 0) * Math.exp(-dt / FAST_TAU_MS) : 0) +
      Math.abs(p - (going ? was.pressure : 0));
    // the same force through a fingertip indents her skin more than through a palm (fast fibres read indentation)
    const sharp = Math.max(0.6, Math.min(1.6, Math.sqrt(6 / Math.max(0.5, c.areaCm2))));
    const change = Math.min(1, Math.min(1, fast) * sharp + (c.cmPerS > 0.5 ? 0.3 : 0));
    const n = countUnder(region, c.areaCm2);
    const gainOf = (t: ReceptorType) => (region.gain?.[t.id] ?? 1) * (1 - 0.7 * (was?.habit ?? 0));
    const out: Record<string, number> = {};
    const level: Record<string, number> = {};
    for (const t of map.receptors) {
      if (t.hairyOnly === true && !region.hairy) continue;
      const lowered = t.threshold * (1 - 0.5 * (was?.sens ?? 0));
      // too much is too much however it comes: a press, or a hard pull on the skin or hair
      let drive = t.id === "noci" ? Math.max(p, c.stretch ?? 0) : t.adapt === "fast" ? change : p;
      if (t.bestCmPerS !== undefined)
        // a stroke's speed against the fibre's best, on a log scale (Löken et al. 2009: an inverted U)
        drive *= c.cmPerS <= 0 ? 0 : Math.exp(-((Math.log(c.cmPerS / t.bestCmPerS) / 1.1) ** 2));
      if (t.id === "vibration") drive = c.vibrationHz === undefined ? 0 : drive + p;
      if (t.drive === "stretch") drive = Math.max(0, Math.min(1, c.stretch ?? 0));
      if (t.drive === "warm" || t.drive === "cold") {
        // a step of 10 °C from her skin is a full drive; it adapts with the touch like any fast type
        const step = ((c.tempC ?? SKIN_C) - SKIN_C) / 10;
        drive =
          Math.max(0, t.drive === "warm" ? step : -step) * (going ? 0.4 : 1) * Math.min(1, p * 4);
      }
      if (drive <= lowered) continue;
      level[t.id] = Math.min(1, (drive - lowered) / (1 - lowered)) * gainOf(t);
      out[t.id] = Math.round(10 * t.peakHz * level[t.id]! * n) / 10;
    }
    rates[c.region] = out;
    levels[c.region] = level;
    const noxious = (out["noci"] ?? 0) > 0;
    sites[c.region] = {
      // habituation counts touches, not frames; too much raises her sensitivity at once, then while it lasts
      habit: Math.min(1, (was?.habit ?? 0) + (going ? 0 : 0.08)),
      sens: Math.min(1, (was?.sens ?? 0) + (noxious ? (going ? dt / 2000 : 0.5) : 0)),
      pressure: p,
      since: going ? was.since : now,
      fast,
    };
  }
  return { state: { at: now, sites }, rates, levels };
};

/**
 * What a region's firing feels like, for the touch map (M-078) and her brain: 0..1 on a log scale of all its
 * populations, and the population that dominates it.
 */
export const feltOf = (
  rates: Readonly<Record<string, Readonly<Record<string, number>>>>,
): ReadonlyArray<{ readonly surface: string; readonly intensity: number; readonly kind: string }> =>
  Object.entries(rates).flatMap(([surface, r]) => {
    const total = Object.values(r).reduce((a, b) => a + b, 0);
    if (total <= 0) return [];
    const kind = Object.entries(r).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    return [{ surface, intensity: Math.min(1, Math.log10(1 + total) / 4), kind }];
  });

/** A region's firing in words for her context: what it was, and whether she is getting used to it there. */
export const feltWords = (
  region: string,
  r: Readonly<Record<string, number>>,
  state: SenseState,
  cmPerS: number,
): string => {
  const what =
    (r["noci"] ?? 0) > 0
      ? (r["stretch"] ?? 0) > 0
        ? "a pull that hurts"
        : "too much"
      : (r["stretch"] ?? 0) > (r["pressure"] ?? 0)
        ? "a pull"
        : // a moving touch her caress fibres answer is a stroke, unless it presses far harder than it caresses
          (r["caress"] ?? 0) * 2 > (r["pressure"] ?? 0)
          ? `a slow stroke, ${Math.round(cmPerS)} cm/s`
          : (r["pressure"] ?? 0) > 0
            ? "a firm press"
            : "a light touch";
  const temp = (r["warm"] ?? 0) > 0 ? ", warm" : (r["cold"] ?? 0) > 0 ? ", cold" : "";
  return (state.sites[region]?.habit ?? 0) > 0.5
    ? `${what}${temp}, getting used to it`
    : (state.sites[region]?.sens ?? 0) > 0.3 && (r["noci"] ?? 0) === 0
      ? `${what}${temp}, still tender there`
      : `${what}${temp}`;
};

/** How a touch sits with her, for her mood's quick reaction: never what it means, only how it felt on the skin. */
export const feltTone = (
  r: Readonly<Record<string, number>>,
): "pleasant" | "firm" | "hurt" | null =>
  (r["noci"] ?? 0) > 0
    ? "hurt"
    : (r["caress"] ?? 0) > 0
      ? "pleasant"
      : (r["pressure"] ?? 0) + (r["stretch"] ?? 0) > 0
        ? "firm"
        : null;

/** The reflex arcs this firing sets off, each once per region, strongest first; the body acts on them itself. */
export const reflexesOf = (
  map: SenseMap,
  levels: Readonly<Record<string, Readonly<Record<string, number>>>>,
): ReadonlyArray<{
  readonly id: string;
  readonly region: string;
  readonly action: ReflexAction;
  readonly latencyMs: number;
  readonly strength: number;
}> =>
  Object.entries(levels)
    .flatMap(([region, r]) =>
      map.reflexes
        .filter(
          (a) =>
            (r[a.receptor] ?? 0) > a.over &&
            (a.regions === undefined || a.regions.includes(region)),
        )
        .map((a) => ({
          id: a.id,
          region,
          action: a.action,
          latencyMs: a.latencyMs,
          strength: a.strength,
        })),
    )
    .sort((a, b) => b.strength - a.strength);

const segmentD = (p: P3, a: P3, b: P3) => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t =
    l2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2),
        );
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
};
/**
 * The pack region a touch at `p` is on, when one claims it: a region with an anchor radius is the capsule along its
 * bone (to `to`, else a sphere), or with an offset or radii the ellipsoid in the bone's frame, nearest first (by
 * its scaled distance). `boneAt` finds any bone by name, custom ones included, and `inBone` gives a point in a bone's
 * frame; null leaves the touch to the general map's own split (touchZoneAt).
 */
export const claimedRegion = (
  map: SenseMap,
  p: P3,
  boneAt: (name: string) => P3 | undefined,
  inBone?: (name: string, p: P3) => P3 | undefined,
): string | null => {
  let best: { id: string; d: number } | null = null;
  for (const r of map.regions.values()) {
    const { radius, offset, radii } = r.anchor;
    if (radius === undefined && radii === undefined) continue;
    let d: number;
    if (offset !== undefined || radii !== undefined) {
      const q = inBone?.(r.anchor.bone, p);
      if (q === undefined) continue;
      const o = offset ?? [0, 0, 0];
      const e = radii ?? [radius!, radius!, radius!];
      d = Math.hypot((q[0] - o[0]) / e[0], (q[1] - o[1]) / e[1], (q[2] - o[2]) / e[2]);
    } else {
      const a = boneAt(r.anchor.bone);
      if (a === undefined) continue;
      d = segmentD(p, a, (r.anchor.to === undefined ? a : boneAt(r.anchor.to)) ?? a) / radius!;
    }
    if (d <= 1 && (best === null || d < best.d)) best = { id: r.id, d };
  }
  return best?.id ?? null;
};

/** The region at (x, y) on a flat form (SenseRegion.areas): the smallest box holding it, or null off her. */
export const regionAt = (map: SenseMap, x: number, y: number): string | null => {
  let best: { id: string; size: number } | null = null;
  for (const r of map.regions.values())
    for (const a of r.areas ?? []) {
      if (x < a.x0 || x > a.x1 || y < a.y0 || y > a.y1) continue;
      const size = (a.x1 - a.x0) * (a.y1 - a.y0);
      if (best === null || size < best.size) best = { id: r.id, size };
    }
  return best?.id ?? null;
};

/**
 * The desk's cartoon (one round body, a face on it, little arms and feet) as a form over the human map: the same
 * regions and skin, each placed where that form has it, so his mouse on her is felt by the one nervous system.
 */
export const MASCOT_SENSE: SensePack = {
  version: 1,
  id: "mascot",
  regions: [
    ...Object.entries({
      head: [{ x0: -0.75, y0: 0, x1: 0.75, y1: 0.3 }],
      face: [{ x0: -0.5, y0: 0.18, x1: 0.5, y1: 0.55 }],
      arm: [
        { x0: -1, y0: 0.3, x1: -0.6, y1: 0.85 },
        { x0: 0.6, y0: 0.3, x1: 1, y1: 0.85 },
      ],
      foot: [{ x0: -0.8, y0: 0.85, x1: 0.8, y1: 1 }],
    }).map(([id, areas]) => ({ ...HUMAN_SENSE.regions.find((r) => r.id === id)!, areas })),
    // her round middle below the face: everyday skin, as her back is (a human belly is a private region)
    {
      id: "middle",
      anchor: { bone: "spine" },
      twoPointMm: 40,
      hairy: false,
      areas: [{ x0: -0.6, y0: 0.55, x1: 0.6, y1: 0.85 }],
    },
  ],
};

/** The private layer's older `zones` cue (a bone and a radius each) as a pack, so one registry holds them all. */
export const zonesPack = (
  zones: ReadonlyArray<{
    readonly id: string;
    readonly bone: string;
    readonly radius: number;
    readonly offset?: P3;
    readonly radii?: P3;
  }>,
): SensePack => ({
  version: 1,
  id: "zones",
  regions: zones.map((z) => ({
    id: z.id,
    anchor: {
      bone: z.bone,
      radius: z.radius,
      ...(z.offset === undefined ? {} : { offset: z.offset }),
      ...(z.radii === undefined ? {} : { radii: z.radii }),
    },
    twoPointMm: 30,
    hairy: true,
  })),
});
