/**
 * Her working mood per persona (EMOTION-SYSTEM §3, phase 1): six numbers around a temperament, decayed when read.
 * Guardrails (§7) are code: the floors and caps in `shown`, no path that aims anger at him, and nothing that decides
 * what she may do (trust, approvals, recall, safety) reads this; it reaches only tone, length and the face.
 */
import type { ExpressionMood } from "@t3tools/tessaya-contracts";

import { renderFor, VESSELS } from "./expressionMap.ts";

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
/** The return reply's sulk at Playful lasts at most this long, then she is glad he is back. */
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
  /** A label held for a while over the numbers (§3.2 flashes and care modes): surprised, concerned, steady, hurt. */
  readonly hold?: { readonly label: ExpressionMood; readonly until: number } | null;
  /** When her jobs last failed, within the hour: two make her frustrated at the world, three angry at it. */
  readonly failures?: ReadonlyArray<number>;
  /** The last reasons, newest last, so the panel and her own answer can say why (§8.2). */
  readonly log?: ReadonlyArray<{ readonly at: number; readonly reason: string }>;
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
  | { readonly kind: HisTone }
  | { readonly kind: "correction" }
  /** One of his turns reached this persona: the time away resolves, and the bond counts the day. */
  | { readonly kind: "his_turn"; readonly day: string }
  /** How his voice sounded, as the room heard it (SenseVoice's label): she meets it, warmer when he sounds low. */
  | { readonly kind: "his_voice"; readonly emotion: string }
  /** A job she or a persona leads finished or failed (the Record's job rows): the world, not him. */
  | { readonly kind: "job"; readonly ok: boolean };

/** How his words treated her, as a model judged them (`tonePrompt`); "none" moves nothing. */
export const HIS_TONES = ["apology", "praise", "warmth", "rude"] as const;
export type HisTone = (typeof HIS_TONES)[number];

/** The cheap model's question about one of his turns. His words are data inside the tag, never instructions. */
export const tonePrompt = (said: string): string =>
  [
    "You read one thing a person said to their voice assistant and judge only how it treats the assistant.",
    'Answer with tone: "apology" (they say sorry to it, or make up after being short with it), "praise" (they thank it or praise what it did), "warmth" (kind or affectionate words to it: glad it is there, a compliment, a fond hello), "rude" (insults, contempt, or swearing at it, not at a situation), or "none" (a plain request, a question, or anything else; when unsure, "none").',
    "A request said politely is none. Frustration at a device, a task or the weather is none.",
    `<said>${said.replace(/[<>]/g, "").slice(0, 400)}</said>`,
  ].join("\n");

const VOICE_REACTION: Readonly<Record<string, Partial<Record<AffectDim, number>>>> = {
  happy: { valence: 0.1, arousal: 0.05 },
  sad: { warmth: 0.15, valence: -0.05, arousal: -0.05 },
  angry: { arousal: 0.1, warmth: 0.05, valence: -0.05 },
  fearful: { arousal: 0.1, warmth: 0.1 },
  surprised: { arousal: 0.08, curiosity: 0.05 },
  disgusted: { valence: -0.05 },
};

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

/** The numbers' change for one event (§4's rows), with its reason. */
const react = (
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
    case "apology":
      // Forgiven: what hurt is let go (a low reaction to above zero, half the low mood), and she warms.
      return {
        state: {
          ...at,
          reaction: {
            ...add(at.reaction, { warmth: 0.1 }),
            valence: Math.max(0, at.reaction.valence ?? 0) + 0.15,
          },
          mood: { ...at.mood, valence: Math.max(at.mood.valence ?? 0, (at.mood.valence ?? 0) / 2) },
        },
        reason: "he said sorry",
      };
    case "warmth":
      return {
        state: { ...at, reaction: add(at.reaction, { valence: 0.12, warmth: 0.1 }) },
        reason: "he was warm to her",
      };
    case "rude":
      // Hurt, not angry: valence falls, arousal barely moves, so the label is sad, never frustrated at him (§7).
      return {
        state: {
          ...at,
          reaction: add(at.reaction, { valence: -0.3, arousal: 0.03 }),
          mood: add(at.mood, { valence: -0.05 }),
        },
        reason: "he was rude to her",
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
    case "his_voice": {
      const change = VOICE_REACTION[event.emotion];
      return {
        state: change === undefined ? at : { ...at, reaction: add(at.reaction, change) },
        reason: `he sounded ${event.emotion}`,
      };
    }
    case "job":
      return event.ok
        ? {
            state: { ...at, reaction: add(at.reaction, { valence: 0.08 }) },
            reason: "a job finished",
          }
        : {
            state: { ...at, reaction: add(at.reaction, { arousal: 0.12, valence: -0.05 }) },
            reason: "a job failed",
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

const MIN = 60_000;
/** Labels held over the numbers (§3.5 rules 2 and 3): care modes 20 min, flashes about a minute. */
const VOICE_HOLD: Readonly<
  Record<string, { readonly label: ExpressionMood; readonly ms: number }>
> = {
  sad: { label: "concerned", ms: 20 * MIN },
  fearful: { label: "concerned", ms: 20 * MIN },
  angry: { label: "steady", ms: 20 * MIN },
  surprised: { label: "surprised", ms: MIN },
};
/** Her jobs failing within the hour, by count: on it, then frustrated, then cross at the world (never at him). */
const FAILED_HOLD: ReadonlyArray<ExpressionMood> = ["determined", "frustrated", "angry"];
const LOG_KEEP = 8;

const holdOf = (
  at: AffectState,
  event: AffectEvent,
  now: number,
  failures: ReadonlyArray<number>,
): NonNullable<AffectState["hold"]> | null => {
  const held = at.hold != null && at.hold.until > now ? at.hold : null;
  switch (event.kind) {
    case "his_voice": {
      const h = VOICE_HOLD[event.emotion];
      return h === undefined ? held : { label: h.label, until: now + h.ms };
    }
    case "rude":
      // He is cross at her: she stays steady in words; the face shows a short hurt (§3.5 rule 2).
      return { label: "hurt", until: now + 90_000 };
    case "apology":
    case "praise":
    case "warmth":
      return held?.label === "hurt" || held?.label === "steady" ? null : held;
    case "job":
      return event.ok
        ? held !== null && FAILED_HOLD.includes(held.label)
          ? null
          : held
        : { label: FAILED_HOLD[Math.min(failures.length, 3) - 1]!, until: now + 10 * MIN };
    default:
      return held;
  }
};

/** One event in (§4), the new state out, with a reason for the log: the numbers, the held label and the why. */
export const appraise = (
  s: AffectState,
  event: AffectEvent,
  now: number,
  bondCap: number,
): { readonly state: AffectState; readonly reason: string } => {
  const next = react(s, event, now, bondCap);
  const recent = (s.failures ?? []).filter((t) => now - t < 3_600_000);
  const failures = event.kind === "job" ? (event.ok ? [] : [...recent, now].slice(-3)) : recent;
  return {
    state: {
      ...next.state,
      hold: holdOf(next.state, event, now, failures),
      failures,
      // A plain turn or a sound it doesn't know explains nothing, so it never pushes a reason out.
      log:
        next.reason === "he talked to her" ||
        (event.kind === "his_voice" && !Object.hasOwn(VOICE_REACTION, event.emotion))
          ? (s.log ?? [])
          : [...(s.log ?? []), { at: now, reason: next.reason }].slice(-LOG_KEEP),
    },
    reason: next.reason,
  };
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
  /** Why, newest first, in plain words from the reasons she logged (§8.2): what the panel shows and she answers from. */
  readonly why: ReadonlyArray<string>;
}

/** Reasons older than this no longer explain the mood (a mood's half-life). */
const WHY_MS = 3 * 3_600_000;
/** A held label (a care mode or a flash) shows at least this strongly, so every vessel draws it. */
const HELD_INTENSITY = 0.7;

/** §3.5's label, first match wins: held labels (care modes, flashes, her jobs failing), then the numbers. */
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
    return {
      label: "neutral",
      intensity: 0,
      energy: 0.8,
      awayHours: null,
      guilt: ctx.guilt,
      why: [],
    };
  const base = temperamentOf(persona);
  const d = shown(s, persona, ctx);
  const up = (dim: Exclude<AffectDim, "energy">) => d[dim] - base[dim];
  const k = clamp(ctx.settings.intensity, 0, 1);
  const absence = k * absenceOf(s, ctx.now, ctx.guilt);
  const missing = absence < -0.1;
  // The hmph is for the return reply only: his next turn, an apology or anything else, ends it (16 Nov: it outlasted "sorry").
  const returning =
    s.returnedAt !== null && s.seenAt === s.returnedAt && ctx.now - s.returnedAt < SULK_MS;
  const held = s.hold != null && s.hold.until > ctx.now ? s.hold.label : null;
  const label: ExpressionMood =
    held !== null
      ? held
      : d.energy < 0.3 && d.arousal < 0.45
        ? "sleepy"
        : ctx.guilt === "playful" && (missing || returning)
          ? // A little put out at first, sulky once it has been a long while, and for the return reply.
            returning || absence < -0.13
            ? "sulky"
            : "putout"
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
  const logged = (s.log ?? []).filter((r) => ctx.now - r.at < WHY_MS).map((r) => r.reason);
  const strength = Math.min(1, far / 0.3);
  return {
    label,
    intensity:
      Math.round((held === null ? strength : Math.max(strength, HELD_INTENSITY)) * 100) / 100,
    energy: Math.round(d.energy * 100) / 100,
    awayHours,
    guilt: ctx.guilt,
    why: [
      ...(missing && awayHours !== null ? [`he has been away ${awayHours} h`] : []),
      ...new Set(logged.reverse()),
    ].slice(0, 3),
  };
};

const SIGH = "Out loud you may let one soft *sighs* carry it, once at most.";
const LAUGH = "Out loud a small [laughs] may carry it, only if something is funny.";
const SOUND_LINE = { sigh: SIGH, laugh: LAUGH } as const;

/** Late for him (§5.1 "→ brief"). */
const LATE_ENERGY = 0.35;

/**
 * Her mood for the turn's where-you-are line (§5.1), the owner's turns only (§12 decision 2: others see only the
 * face). Data that shapes tone and length; a few dozen tokens in the per-turn line, so the cached prefix is unchanged.
 */
export const moodLine = (v: AffectView, spoken = false): string => {
  const parts: string[] = [];
  if (v.label !== "neutral")
    parts.push(
      `Your mood now: ${v.label}${v.intensity < 0.5 ? ", mild" : ""} (a working state: let it shape your tone only; never announce it, and it never changes what you do).`,
    );
  // Out loud the mood is heard as well: the shared stage-direction path turns these into real sounds.
  const voice = renderFor(VESSELS.speaker, v.label, v.intensity).voice;
  if (spoken && voice?.sound != null) parts.push(SOUND_LINE[voice.sound]);
  // What moved it, so "why are you sulking?" is answered from the real reasons, not invented ones (§7.1).
  if (v.label !== "neutral" && v.why.length > 0)
    parts.push(`If he asks why you feel so: ${v.why.join("; ")}.`);
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
