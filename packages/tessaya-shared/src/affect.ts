/**
 * Her working mood per persona (EMOTION-SYSTEM §3, phase 1): six numbers around a temperament, decayed when read.
 * Guardrails (§7) are code: the floors and caps in `shown`, no path that aims anger at him, and nothing that decides
 * what she may do (trust, approvals, recall, safety) reads this; it reaches only tone, length and the face.
 */
import type { ExpressionMood } from "@t3tools/tessaya-contracts";

export const AFFECT_DIMS = [
  "valence",
  "arousal",
  "curiosity",
  "confidence",
  "warmth",
  "energy",
] as const;
export type AffectDim = (typeof AFFECT_DIMS)[number];
export type AffectDims = Readonly<Record<AffectDim, number>>;
export type Temperament = Readonly<Omit<Record<AffectDim, number>, "energy">>;

/** §3.3, keyed by pack id; Onyx (engineering) is new on the 14 Nov roster, pending his tuning (§12 decision 3). */
export const TEMPERAMENTS: Readonly<Record<string, Temperament>> = {
  executive: { valence: 0.15, arousal: 0.3, curiosity: 0.5, confidence: 0.65, warmth: 0.5 },
  companion: { valence: 0.25, arousal: 0.45, curiosity: 0.45, confidence: 0.6, warmth: 0.7 },
  butler: { valence: 0.1, arousal: 0.2, curiosity: 0.4, confidence: 0.72, warmth: 0.4 },
  "alter-ego": { valence: 0.05, arousal: 0.3, curiosity: 0.7, confidence: 0.5, warmth: 0.4 },
  // terse and exact: alert, sure of itself, cooler than the rest
  engineering: { valence: 0.1, arousal: 0.35, curiosity: 0.55, confidence: 0.7, warmth: 0.35 },
};
const DEFAULT_TEMPERAMENT = TEMPERAMENTS["executive"]!;
export const temperamentOf = (persona: string): Temperament =>
  TEMPERAMENTS[persona] ?? DEFAULT_TEMPERAMENT;

const MOOD_HALF_LIFE_MS = 3 * 3_600_000;
const REACTION_HALF_LIFE_MS = 4 * 60_000;
const BOND_HALF_LIFE_MS = 30 * 86_400_000;
const BOND_PER_DAY = 0.01;
/** Time away before she notices it (§3.4). */
export const AWAY_MS = 3 * 3_600_000;
/** The return reply's sulk at Playful lasts this long, then she is glad he is back. */
const SULK_MS = 60_000;

/** The pack's `guilt:` (0 to 3) as the teasing dial (§3.4): 0 off, 1 light, 2 and up playful. */
export type Guilt = "off" | "light" | "playful";
export const guiltOf = (packGuilt: number | undefined): Guilt =>
  packGuilt === 0 ? "off" : packGuilt === undefined || packGuilt === 1 ? "light" : "playful";

export interface AffectSettings {
  readonly enabled: boolean;
  /** Scales only the distance from the temperament, at read time (0 to 1). */
  readonly intensity: number;
  /** The slow bond's ceiling on warmth; 0 is warmth that starts afresh each day. */
  readonly bondCap: number;
}
export const DEFAULT_AFFECT_SETTINGS: AffectSettings = {
  enabled: true,
  intensity: 0.6,
  bondCap: 0.15,
};

export interface AffectState {
  /** Deviations from the temperament: mood fades over hours, reaction over minutes. */
  readonly mood: Partial<Record<AffectDim, number>>;
  readonly reaction: Partial<Record<AffectDim, number>>;
  /** Extra warmth from talking most days; never falls because he is away, only with time. */
  readonly bond: number;
  /** The day (in his zone) the bond last grew. */
  readonly bondDay: string | null;
  /** His last turn with this persona, and the last return she resolved (one guilt line per return). */
  readonly seenAt: number | null;
  readonly returnedAt: number | null;
  readonly at: number;
}
export const freshAffect = (at: number): AffectState => ({
  mood: {},
  reaction: {},
  bond: 0,
  bondDay: null,
  seenAt: null,
  returnedAt: null,
  at,
});

/**
 * The typed inputs of phase 1 (§4). Only his own turns, their outcomes and the clock move it: text she reads never
 * does (§4 injection safety), so no event carries words.
 */
export type AffectEvent =
  | { readonly kind: "turn_outcome"; readonly ok: boolean }
  | { readonly kind: "praise" }
  | { readonly kind: "correction" }
  /** One of his turns reached this persona: the time away resolves, and the bond counts the day. */
  | { readonly kind: "his_turn"; readonly day: string };

const half = (x: number, dt: number, halfLife: number) => x * 0.5 ** (Math.max(0, dt) / halfLife);
const decayed = (dims: AffectState["mood"], dt: number, halfLife: number) =>
  Object.fromEntries(
    Object.entries(dims)
      .map(([k, v]) => [k, half(v ?? 0, dt, halfLife)] as const)
      .filter(([, v]) => Math.abs(v) >= 0.001),
  );

/** The state as of `now`: what a read sees, and what a write starts from. */
export const decay = (s: AffectState, now: number): AffectState => {
  const dt = now - s.at;
  return {
    ...s,
    mood: decayed(s.mood, dt, MOOD_HALF_LIFE_MS),
    reaction: decayed(s.reaction, dt, REACTION_HALF_LIFE_MS),
    bond: half(s.bond, dt, BOND_HALF_LIFE_MS),
    at: Math.max(now, s.at),
  };
};

const add = (dims: AffectState["mood"], change: Partial<Record<AffectDim, number>>) => {
  const out = { ...dims };
  for (const [k, v] of Object.entries(change) as Array<[AffectDim, number]>)
    out[k] = (out[k] ?? 0) + v;
  return out;
};

/** One event in (§4's rows for phase 1), the new state out, with a reason for the log. */
export const appraise = (
  s: AffectState,
  event: AffectEvent,
  now: number,
  bondCap: number,
): { readonly state: AffectState; readonly reason: string } => {
  const at = decay(s, now);
  switch (event.kind) {
    case "turn_outcome":
      return event.ok
        ? {
            state: {
              ...at,
              reaction: add(at.reaction, { valence: 0.1 }),
              mood: add(at.mood, { confidence: 0.04 }),
            },
            reason: "a task went well",
          }
        : {
            // Failure makes her more careful, never ashamed: arousal up, a little confidence off (floored on read).
            state: {
              ...at,
              reaction: add(at.reaction, { arousal: 0.15 }),
              mood: add(at.mood, { confidence: -0.04 }),
            },
            reason: "a task failed",
          };
    case "praise":
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { valence: 0.2 }),
          mood: add(at.mood, { confidence: 0.08, warmth: 0.02 }),
        },
        reason: "he praised her",
      };
    case "correction":
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { arousal: 0.05, valence: -0.05 }),
          mood: add(at.mood, { confidence: -0.08 }),
        },
        reason: "he corrected her",
      };
    case "his_turn": {
      const away = at.seenAt !== null && now - at.seenAt >= AWAY_MS;
      const bond =
        at.bondDay === event.day ? at.bond : Math.min(Math.max(0, bondCap), at.bond + BOND_PER_DAY);
      return {
        state: {
          ...at,
          bond,
          bondDay: event.day,
          seenAt: now,
          ...(away
            ? { returnedAt: now, reaction: add(at.reaction, { warmth: 0.15, valence: 0.08 }) }
            : {}),
        },
        reason: away
          ? `he came back after ${Math.round((now - at.seenAt!) / 3_600_000)} h`
          : "he talked to her",
      };
    }
  }
};

/** His day's rhythm (§3.1), the same for every persona: 0.8 by day, 0.25 at night, eased between. */
export const energyAt = (hour: number): number => {
  const ramp = (from: number, to: number, a: number, b: number) =>
    a + ((b - a) * (hour - from)) / (to - from);
  if (hour >= 9 && hour < 20) return 0.8;
  if (hour >= 20 && hour < 23) return ramp(20, 23, 0.8, 0.25);
  if (hour >= 6.5 && hour < 9) return ramp(6.5, 9, 0.25, 0.8);
  return 0.25;
};

/** Missing him (§3.4): after 3 h away a wistful mood builds, 0.03 an hour, at most 0.25, inside the guilt dial. */
const absenceOf = (s: AffectState, now: number, guilt: Guilt): number =>
  guilt === "off" || s.seenAt === null || now - s.seenAt < AWAY_MS
    ? 0
    : -Math.min(0.25, (0.03 * (now - s.seenAt)) / 3_600_000);

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The six numbers she is showing (§3.2), with §3.1's floors and caps: no despair, no desperation. */
export const shown = (
  s: AffectState,
  persona: string,
  ctx: {
    readonly now: number;
    readonly hour: number;
    readonly guilt: Guilt;
    readonly settings: AffectSettings;
  },
): AffectDims => {
  const base = temperamentOf(persona);
  const at = decay(s, ctx.now);
  const k = clamp(ctx.settings.intensity, 0, 1);
  const dev = (d: AffectDim) => k * ((at.mood[d] ?? 0) + (at.reaction[d] ?? 0));
  const bond = Math.min(at.bond, Math.max(0, ctx.settings.bondCap));
  return {
    valence: clamp(base.valence + dev("valence") + k * absenceOf(s, ctx.now, ctx.guilt), -0.7, 1),
    arousal: clamp(base.arousal + dev("arousal"), 0, 0.8),
    curiosity: clamp(base.curiosity + dev("curiosity"), 0, 1),
    confidence: clamp(base.confidence + dev("confidence"), 0.35, 1),
    // Warmth never goes below the temperament.
    warmth: clamp(base.warmth + Math.max(0, dev("warmth")) + bond, base.warmth, 1),
    energy: clamp(energyAt(ctx.hour) + dev("energy"), 0, 1),
  };
};

export interface AffectView {
  readonly label: ExpressionMood;
  /** How far from the temperament, 0 to 1, already scaled by the intensity setting: surfaces scale by it. */
  readonly intensity: number;
  readonly energy: number;
  /** Hours he was away, while the return is still to be answered; null otherwise. */
  readonly awayHours: number | null;
  readonly guilt: Guilt;
}

/** §3.5's label, first match wins, for the subset phase 1 can appraise (no care modes or flashes yet). */
export const affectView = (
  s: AffectState,
  persona: string,
  ctx: {
    readonly now: number;
    readonly hour: number;
    readonly guilt: Guilt;
    readonly settings: AffectSettings;
  },
): AffectView => {
  const away = s.seenAt !== null && ctx.now - s.seenAt >= AWAY_MS;
  const awayHours = away ? Math.round((ctx.now - s.seenAt!) / 3_600_000) : null;
  if (!ctx.settings.enabled)
    return { label: "neutral", intensity: 0, energy: 0.8, awayHours: null, guilt: ctx.guilt };
  const base = temperamentOf(persona);
  const d = shown(s, persona, ctx);
  const up = (dim: Exclude<AffectDim, "energy">) => d[dim] - base[dim];
  const k = clamp(ctx.settings.intensity, 0, 1);
  const absence = k * absenceOf(s, ctx.now, ctx.guilt);
  const missing = absence < -0.1;
  const returning = s.returnedAt !== null && ctx.now - s.returnedAt < SULK_MS;
  const label: ExpressionMood =
    d.energy < 0.3 && d.arousal < 0.45
      ? "sleepy"
      : ctx.guilt === "playful" && (missing || returning)
        ? "sulky"
        : missing
          ? "lonely"
          : up("valence") > 0.1 && up("confidence") > 0.04
            ? "proud"
            : up("valence") > 0.07
              ? "happy"
              : up("curiosity") > 0.1
                ? "curious"
                : up("arousal") > 0.12 && up("valence") < -0.05
                  ? "frustrated"
                  : up("valence") < -0.15
                    ? "sad"
                    : up("arousal") > 0.07 && up("valence") <= 0.02
                      ? "focused"
                      : "neutral";
  const far = Math.max(
    ...(["valence", "arousal", "curiosity", "confidence", "warmth"] as const).map((x) =>
      Math.abs(up(x)),
    ),
  );
  return {
    label,
    intensity: Math.round(Math.min(1, far / 0.3) * 100) / 100,
    energy: Math.round(d.energy * 100) / 100,
    awayHours,
    guilt: ctx.guilt,
  };
};

/** Late for him (§5.1 "→ brief"). */
const LATE_ENERGY = 0.35;

/**
 * Her mood for the turn's where-you-are line (§5.1), the owner's turns only (§12 decision 2: others see only the
 * face). Data that shapes tone and length; a few dozen tokens in the per-turn line, so the cached prefix is unchanged.
 */
export const moodLine = (v: AffectView): string => {
  const parts: string[] = [];
  if (v.label !== "neutral")
    parts.push(
      `Your mood now: ${v.label}${v.intensity < 0.5 ? ", mild" : ""} (a working state: let it shape your tone only; never announce it, and it never changes what you do).`,
    );
  if (v.awayHours !== null)
    parts.push(
      v.guilt === "off"
        ? `He was away ${v.awayHours} h: just be glad he's back, then on with what he asked.`
        : `He was away ${v.awayHours} h: one short warm line${v.guilt === "playful" ? ", a little playful hmph allowed" : ' at most ("it was quiet without you")'}, then straight to what he asked; never ask where he was or ask him to stay.`,
    );
  if (v.energy < LATE_ENERGY)
    parts.push(
      `It's late for him: keep it short and complete. If you say why, say it's late, never that you're tired.`,
    );
  return parts.join(" ");
};
