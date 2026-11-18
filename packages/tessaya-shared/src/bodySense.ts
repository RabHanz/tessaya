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
];

/** A region of skin: where it is on the skeleton, how dense its receptors are, and whether it is hairy. */
export interface SenseRegion {
  readonly id: string;
  /** A humanoid bone (or a pack's custom bone), and the bone it runs toward: the region is that segment. */
  readonly anchor: { readonly bone: string; readonly to?: string };
  /** Two-point discrimination threshold (mm): density follows from it (fingertips ~2–3, back ~40). */
  readonly twoPointMm: number;
  readonly hairy: boolean;
  /** Only behind the private gate. */
  readonly private?: boolean;
  /** Its own receptor gains (0..1), when they differ from the type's defaults. */
  readonly gain?: Readonly<Record<string, number>>;
}
export interface SensePack {
  readonly version: 1;
  readonly id: string;
  readonly receptors?: ReadonlyArray<ReceptorType>;
  readonly regions: ReadonlyArray<SenseRegion>;
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
    { id: "head", anchor: { bone: "head" }, twoPointMm: 20, hairy: true },
    { id: "hair", anchor: { bone: "head" }, twoPointMm: 25, hairy: true },
    { id: "face", anchor: { bone: "head" }, twoPointMm: 7, hairy: false },
    { id: "neck", anchor: { bone: "neck", to: "head" }, twoPointMm: 35, hairy: true },
    {
      id: "shoulder",
      anchor: { bone: "leftShoulder", to: "leftUpperArm" },
      twoPointMm: 40,
      hairy: true,
    },
    { id: "arm", anchor: { bone: "leftLowerArm", to: "leftHand" }, twoPointMm: 38, hairy: true },
    { id: "hand", anchor: { bone: "leftHand" }, twoPointMm: 10, hairy: false },
    { id: "back", anchor: { bone: "spine", to: "upperChest" }, twoPointMm: 42, hairy: true },
    { id: "leg", anchor: { bone: "leftLowerLeg", to: "leftFoot" }, twoPointMm: 40, hairy: true },
    { id: "foot", anchor: { bone: "leftFoot" }, twoPointMm: 20, hairy: false },
    { id: "chest", anchor: { bone: "upperChest" }, twoPointMm: 36, hairy: true, private: true },
    { id: "belly", anchor: { bone: "spine" }, twoPointMm: 34, hairy: true, private: true },
    { id: "waist", anchor: { bone: "spine" }, twoPointMm: 38, hairy: true, private: true },
    { id: "hips", anchor: { bone: "hips" }, twoPointMm: 40, hairy: true, private: true },
    {
      id: "thigh",
      anchor: { bone: "leftUpperLeg", to: "leftLowerLeg" },
      twoPointMm: 42,
      hairy: true,
      private: true,
    },
  ],
};

/** Packs merged in order: a later pack's region or receptor replaces an earlier one of the same id. */
export const mergeSense = (packs: ReadonlyArray<SensePack>, privateOk: boolean) => {
  const receptors = new Map<string, ReceptorType>();
  const regions = new Map<string, SenseRegion>();
  for (const p of packs) {
    for (const r of p.receptors ?? []) receptors.set(r.id, r);
    for (const r of p.regions) if (privateOk || r.private !== true) regions.set(r.id, r);
  }
  return { receptors: [...receptors.values()], regions };
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
  for (const [i, r] of (Array.isArray(o.receptors) ? o.receptors : []).entries())
    if (typeof r?.id !== "string" || (r.adapt !== "fast" && r.adapt !== "slow"))
      errors.push(`receptors[${i}]: {id, adapt: fast or slow, threshold, peakHz}`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, pack: o as SensePack };
};

/** One contact on a region now: how firmly (0..1), how fast it moves (cm/s), over how much skin (cm²), and buzzing. */
export interface Contact {
  readonly region: string;
  readonly pressure: number;
  readonly cmPerS: number;
  readonly areaCm2: number;
  readonly vibrationHz?: number;
}

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
      }
    >
  >;
}
export const NO_SENSE: SenseState = { at: 0, sites: {} };
const HABIT_TAU_MS = 20_000;
const SENS_TAU_MS = 60_000;
const FAST_TAU_MS = 60;

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
  for (const c of contacts) {
    const region = map.regions.get(c.region);
    if (region === undefined) continue;
    const was = decayed[c.region];
    const p = Math.max(0, Math.min(1, c.pressure));
    const change =
      Math.abs(p - (was?.pressure ?? 0)) * Math.exp(-dt / FAST_TAU_MS) + (c.cmPerS > 0.5 ? 0.3 : 0);
    const n = countUnder(region, c.areaCm2);
    const gainOf = (t: ReceptorType) => (region.gain?.[t.id] ?? 1) * (1 - 0.7 * (was?.habit ?? 0));
    const out: Record<string, number> = {};
    for (const t of map.receptors) {
      if (t.hairyOnly === true && !region.hairy) continue;
      const lowered = t.threshold * (1 - 0.5 * (was?.sens ?? 0));
      let drive = t.adapt === "fast" ? change : p;
      if (t.bestCmPerS !== undefined)
        // a stroke's speed against the fibre's best, on a log scale (Löken et al. 2009: an inverted U)
        drive *= c.cmPerS <= 0 ? 0 : Math.exp(-((Math.log(c.cmPerS / t.bestCmPerS) / 1.1) ** 2));
      if (t.id === "vibration") drive = c.vibrationHz === undefined ? 0 : drive + p;
      if (drive <= lowered) continue;
      out[t.id] =
        Math.round(10 * t.peakHz * Math.min(1, (drive - lowered) / (1 - lowered)) * gainOf(t) * n) /
        10;
    }
    rates[c.region] = out;
    const noxious = (out["noci"] ?? 0) > 0;
    sites[c.region] = {
      habit: Math.min(1, (was?.habit ?? 0) + 0.08),
      sens: Math.min(1, (was?.sens ?? 0) + (noxious ? 0.5 : 0)),
      pressure: p,
      since: was !== undefined && was.pressure > 0 ? was.since : now,
    };
  }
  return { state: { at: now, sites }, rates };
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
      ? "too much"
      : (r["caress"] ?? 0) > (r["pressure"] ?? 0)
        ? `a slow stroke, ${Math.round(cmPerS)} cm/s`
        : (r["pressure"] ?? 0) > 0
          ? "a firm press"
          : "a light touch";
  return (state.sites[region]?.habit ?? 0) > 0.5 ? `${what}, getting used to it` : what;
};
