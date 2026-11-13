/**
 * Voice match (VOICE-ID): whose voice an utterance is, from speaker embeddings. Pure; the model runs elsewhere
 * (providers/speakerOnnx.ts). Identity only ever narrows what a turn may do: a weak or missing verdict is
 * "unverified", which behaves as today and never grants more.
 *
 * @module baton-voice/speaker
 */

export interface SpeakerProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: "owner" | "saved";
  /** The embedder's model id: a profile from another model is never compared. */
  readonly model: string;
  /** The mean of the kept enrolment vectors, length 1. */
  readonly centroid: Float32Array;
  readonly samples: number;
  readonly sources: ReadonlyArray<"wispr" | "spoken" | "adapted">;
  readonly enrolledAt: string;
  /** Saved people: what they said when they agreed, and when. */
  readonly consentNote?: string;
  /** The home server's version of this person's profile this copy was made from; absent: never synced. */
  readonly version?: number;
  /** That shared profile's centroid: this device's own refinements stay within reach of it. */
  readonly base?: Float32Array;
}

/** What the verdict is for: each use has its own cut-off, because a wrong "yes" costs more for some. */
export type SpeakerUse = "listen" | "steer" | "act";

/** Cosine cut-offs for one model, from the voice-match benchmark on his clips (raw cosine, no AS-norm). */
export interface SpeakerPolicy {
  readonly model: string;
  /** Under this much speech nothing is decided: the clip is too short to tell voices apart. */
  readonly minSpeechMs: number;
  /** One clip of `clipMs` or more, scored alone. */
  readonly single: Readonly<Record<SpeakerUse, number>>;
  /** The mean of 3 consecutive clips' scores. */
  readonly averaged: Readonly<Record<SpeakerUse, number>>;
  /** The winner must beat the next profile by this much, or it is nobody's. */
  // shortcut: the margin is a guess (the benchmark enrolled one person); derive it once two saved people are measured.
  readonly margin: number;
}

/**
 * CAM++ raw cosine, 60-clip seed, calibrated 2026-11-11 on his held-out clips and 173 public speakers (PR body has the
 * table). listen (one 2 s cut-in): FRR <= 2.1%. steer (a 2-10 s turn): FRR <= 1.9%, FAR <= 1.2%. act (verified,
 * one 4 s clip): FAR <= 0.09%, FRR <= 2.8%; on 3 averaged 2 s clips FAR 0.03%.
 */
export const CAMPLUS_POLICY: Omit<SpeakerPolicy, "model"> = {
  minSpeechMs: 2_000,
  single: { listen: 0.36, steer: 0.45, act: 0.53 },
  averaged: { listen: 0.36, steer: 0.45, act: 0.47 },
  margin: 0.05,
};
/** One clip must be this long to be scored at the "act" level on its own. */
export const ACT_SINGLE_MS = 4_000;

export type SpeakerVerdict =
  | { readonly kind: "owner"; readonly score: number }
  | { readonly kind: "saved"; readonly id: string; readonly name: string; readonly score: number }
  | { readonly kind: "guest"; readonly best: number }
  | {
      readonly kind: "unverified";
      readonly why: "no-model" | "no-profile" | "too-short" | "failed";
    };

/** NaN when the lengths differ or either is empty or zero: a score that cannot be trusted is never a number. */
export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || a.length === 0) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? Number.NaN : dot / Math.sqrt(na * nb);
};

/** Length 1, or null when the vector has a non-finite value or no length at all. */
export const unitOrNull = (v: Float32Array): Float32Array | null => {
  if (v.length === 0 || !v.every(Number.isFinite)) return null;
  const n = Math.hypot(...v);
  return n > 0 && Number.isFinite(n) ? v.map((x) => x / n) : null;
};

/** One clip of speech from this turn and how long it was. */
export interface SpeakerClip {
  readonly vector: Float32Array;
  readonly ms: number;
}

/**
 * Whose voice, for one use, from this turn's clips (the caller starts a fresh list each turn). Only clips of 2 s or
 * more count. Three or more: the mean of the last three clips' scores, at the averaged cut-offs. Fewer: the last
 * clip alone, at the one-clip cut-off; "act" then needs that clip to be 4 s long. Every score must be a finite
 * number, or the verdict is unverified: a broken score must never pass as him.
 */
export const decideSpeaker = (input: {
  readonly clips: ReadonlyArray<SpeakerClip>;
  /** The model that made the clips' vectors; another model's cut-offs and profiles say nothing about them. */
  readonly model: string;
  readonly profiles: ReadonlyArray<SpeakerProfile>;
  readonly policy: SpeakerPolicy | null;
  readonly use: SpeakerUse;
}): SpeakerVerdict => {
  const { policy } = input;
  if (policy === null || input.model !== policy.model)
    return { kind: "unverified", why: "no-model" };
  const mine = input.profiles.filter((p) => p.model === policy.model);
  if (!mine.some((p) => p.kind === "owner")) return { kind: "unverified", why: "no-profile" };
  if (input.clips.length === 0) return { kind: "unverified", why: "failed" };
  const long = input.clips.filter((c) => c.ms >= policy.minSpeechMs);
  if (long.length === 0) return { kind: "unverified", why: "too-short" };
  const averaged = long.length >= 3;
  const used = averaged ? long.slice(-3) : long.slice(-1);
  if (!averaged && input.use === "act" && used[0]!.ms < ACT_SINGLE_MS)
    return { kind: "unverified", why: "too-short" };
  const cut = averaged ? policy.averaged[input.use] : policy.single[input.use];
  const scores = mine.map((p) => ({
    p,
    score: used.reduce((n, c) => n + cosine(c.vector, p.centroid), 0) / used.length,
  }));
  if (!scores.every((s) => Number.isFinite(s.score))) return { kind: "unverified", why: "failed" };
  const [best, next] = scores.toSorted((a, b) => b.score - a.score);
  if (best === undefined) return { kind: "unverified", why: "no-profile" };
  if (best.score < cut || (next !== undefined && best.score - next.score < policy.margin))
    return { kind: "guest", best: best.score };
  return best.p.kind === "owner"
    ? { kind: "owner", score: best.score }
    : { kind: "saved", id: best.p.id, name: best.p.name, score: best.score };
};

/**
 * A profile's centroid from enrolment vectors. A vector far from the rest (another voice in one of his Wispr
 * clips) is dropped: kept are those whose cosine to the first mean is within 3 median deviations of the median.
 */
export const enrol = (
  input: ReadonlyArray<Float32Array>,
  minSamples = 3,
): { readonly centroid: Float32Array; readonly kept: number; readonly dropped: number } | null => {
  if (input.length < minSamples) return null;
  const units = input.map(unitOrNull);
  // One broken or odd-length vector means the model misbehaved: make no profile from it.
  if (units.some((u) => u === null || u.length !== units[0]!.length)) return null;
  const mean = (vs: ReadonlyArray<Float32Array>) => {
    const out = new Float32Array(vs[0]!.length);
    for (const u of vs) for (let i = 0; i < out.length; i += 1) out[i] = out[i]! + u[i]!;
    return unitOrNull(out);
  };
  const vectors = units as Float32Array[];
  const first = mean(vectors);
  if (first === null) return null;
  const scores = vectors.map((v) => cosine(v, first));
  const sorted = scores.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const mad = sorted.map((s) => Math.abs(s - median)).toSorted((a, b) => a - b)[
    Math.floor(sorted.length / 2)
  ]!;
  const kept = vectors.filter((_, i) => scores[i]! >= median - 3 * Math.max(mad, 0.02));
  const centroid = kept.length < minSamples ? null : mean(kept);
  return centroid === null
    ? null
    : { centroid, kept: kept.length, dropped: vectors.length - kept.length };
};

/**
 * Who is speaking, for everything downstream: the turn's trust path, the memory stores, the approval path. One
 * shape for all of them, so nobody invents a second identity.
 */
export interface SpeakerIdentity {
  readonly kind: "owner" | "saved" | "guest" | "unverified";
  /** "owner" or a saved profile's id; null for a guest or unverified. */
  readonly personId: string | null;
  readonly name: string | null;
  /** Raw cosine to the matched centroid (to the nearest one for a guest); null when unverified. */
  readonly confidence: number | null;
  /** This turn's own clips cleared the "act" cut-off. Never true for an inherited verdict. */
  readonly verified: boolean;
  /** A short follow-up carrying the last verdict (same microphone, under `INHERIT_MS`). */
  readonly inherited: boolean;
  readonly at: number;
}

/** A short follow-up ("yes", "stop") keeps the last verdict this long, and only for listening. */
export const INHERIT_MS = 15_000;

export const UNVERIFIED = (at: number): SpeakerIdentity => ({
  kind: "unverified",
  personId: null,
  name: null,
  confidence: null,
  verified: false,
  inherited: false,
  at,
});

/** The identity from this turn's verdicts at the listen and act levels. */
export const identityOf = (
  listen: SpeakerVerdict,
  act: SpeakerVerdict,
  at: number,
): SpeakerIdentity => {
  if (listen.kind === "unverified") return UNVERIFIED(at);
  if (listen.kind === "guest") return { ...UNVERIFIED(at), kind: "guest", confidence: listen.best };
  const personId = listen.kind === "owner" ? "owner" : listen.id;
  const verified =
    (act.kind === "owner" && personId === "owner") || (act.kind === "saved" && act.id === personId);
  return {
    kind: listen.kind,
    personId,
    name: listen.kind === "saved" ? listen.name : null,
    confidence: listen.score,
    verified,
    inherited: false,
    at,
  };
};

/** The Voice ID switches a verdict is weighed against (D1-D3, D8 in voiceid-plan.md). */
export interface SpeakerGate {
  readonly respondToOthers: boolean;
  readonly offSilencesSaved: boolean;
  readonly savedBarge: boolean;
  readonly strictWhenUnavailable: boolean;
}

/**
 * May this voice open a turn, or cut in over her? He always may. Identity only narrows: a voice that is let in
 * still goes down the outside path unless it is his (see `speakerPath`).
 */
export const admits = (
  identity: SpeakerIdentity,
  gate: SpeakerGate,
  use: "turn" | "barge",
): boolean => {
  switch (identity.kind) {
    case "owner":
      return true;
    case "unverified":
      return !gate.strictWhenUnavailable;
    case "saved":
      return use === "barge" ? gate.savedBarge : gate.respondToOthers || !gate.offSilencesSaved;
    case "guest":
      return use === "turn" && gate.respondToOthers;
  }
};

/** His own path, or the outside one (fresh session, read-only, a proposal for anything that acts). */
export const speakerPath = (identity: SpeakerIdentity | null): "his" | "outside" =>
  identity === null || identity.kind === "owner" || identity.kind === "unverified"
    ? "his"
    : "outside";

/**
 * What a spoken yes is worth (D4), while Voice ID is running. `voiceFactor`: his voice, verified on this turn's own
 * clips, counts as ONE approval factor (the Home Assistant path needs another). `cardRequired`: the spoken yes is not
 * enough on its own. An ordinary yes from his voice (a short "yes" inherits his last verdict) needs no card when he
 * allowed it; a risky act always needs the card on screen or on his phone.
 */
export const voiceApproval = (
  identity: SpeakerIdentity | null,
  risk: "ordinary" | "risky",
  voiceYes: boolean,
): { readonly voiceFactor: boolean; readonly cardRequired: boolean } => ({
  voiceFactor:
    identity !== null && identity.kind === "owner" && identity.verified && !identity.inherited,
  cardRequired: risk === "risky" || !voiceYes || identity?.kind !== "owner",
});

/**
 * Whether a spoken yes stands without the card (D4). A "yes" is too short to judge, so an unjudged one is the voice of
 * the turn it answers; one judged as someone else's never is (2026-11-12: every short yes was sent to the card).
 */
export const spokenYesStands = (
  heard: SpeakerIdentity,
  turn: SpeakerIdentity | null,
  risk: "ordinary" | "risky",
  voiceYes: boolean,
): boolean =>
  !voiceApproval(
    heard.kind === "unverified" && turn?.kind === "owner" ? turn : heard,
    risk,
    voiceYes,
  ).cardRequired;

/** How far one confident turn moves his centroid (D6). */
const ADAPT_WEIGHT = 0.02;
/** How far a device's refinements may take a profile from the shared one (cosine): a bad mic can't drift a person away. */
const ADAPT_MIN_LIKENESS = 0.92;
/** Only a turn this far above the act cut-off teaches: a doubtful one could pull him towards someone else. */
const ADAPT_ABOVE_ACT = 0.1;

/**
 * A member's profile on this device nudged towards one confident clip of this turn, or null when the clip should not
 * teach: only from a 4 s clip, only well above the act cut-off, and never further from the shared profile than
 * `ADAPT_MIN_LIKENESS`. The nudge stays on this device; the shared profile changes only by enrolling.
 */
export const adaptProfile = (
  profile: SpeakerProfile,
  clip: SpeakerClip,
  policy: SpeakerPolicy,
): SpeakerProfile | null => {
  if (profile.model !== policy.model || clip.ms < ACT_SINGLE_MS) return null;
  const score = cosine(clip.vector, profile.centroid);
  if (!Number.isFinite(score) || score < policy.single.act + ADAPT_ABOVE_ACT) return null;
  const v = unitOrNull(clip.vector);
  if (v === null) return null;
  const moved = unitOrNull(
    profile.centroid.map((c, i) => (1 - ADAPT_WEIGHT) * c + ADAPT_WEIGHT * v[i]!),
  );
  const base = profile.base ?? profile.centroid;
  return moved === null || cosine(moved, base) < ADAPT_MIN_LIKENESS
    ? null
    : {
        ...profile,
        base,
        centroid: moved,
        sources: profile.sources.includes("adapted")
          ? profile.sources
          : [...profile.sources, "adapted"],
      };
};
