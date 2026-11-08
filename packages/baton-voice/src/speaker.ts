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
  readonly sources: ReadonlyArray<"wispr" | "spoken">;
  readonly enrolledAt: string;
  /** Saved people: what they said when they agreed, and when. */
  readonly consentNote?: string;
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
  readonly margin: number;
}

/**
 * 3D-Speaker CAM++ (VoxCeleb), voiceid-bench REPORT 2026-11-08, enrolment of 60 s or more:
 * listen 0.10 (about 1% of his 2 s clips missed), steer at the equal-error point (0.22 on one 2 s clip, 0.28 on
 * 3 averaged), act at 0.1% false accepts (0.40 on a 4 s clip, 0.36 on 3 averaged 2 s clips).
 */
export const CAMPLUS_POLICY: Omit<SpeakerPolicy, "model"> = {
  minSpeechMs: 2_000,
  single: { listen: 0.1, steer: 0.22, act: 0.4 },
  averaged: { listen: 0.1, steer: 0.28, act: 0.36 },
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

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

const unit = (v: Float32Array): Float32Array => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

/**
 * Whose voice, for one use. `scored` holds the clip's score (or, averaged, the mean of up to 3 consecutive clips'
 * scores) per profile; the caller averages, so a verdict reads the same from one clip or from three.
 */
export const decideSpeaker = (input: {
  readonly vectors: ReadonlyArray<Float32Array>;
  readonly speechMs: number;
  readonly profiles: ReadonlyArray<SpeakerProfile>;
  readonly policy: SpeakerPolicy | null;
  readonly use: SpeakerUse;
}): SpeakerVerdict => {
  const { policy } = input;
  if (policy === null) return { kind: "unverified", why: "no-model" };
  const mine = input.profiles.filter((p) => p.model === policy.model);
  if (!mine.some((p) => p.kind === "owner")) return { kind: "unverified", why: "no-profile" };
  if (input.vectors.length === 0) return { kind: "unverified", why: "failed" };
  if (input.speechMs < policy.minSpeechMs) return { kind: "unverified", why: "too-short" };
  const averaged = input.vectors.length >= 3;
  const cut = averaged
    ? policy.averaged[input.use]
    : input.use === "act" && input.speechMs < ACT_SINGLE_MS
      ? Number.POSITIVE_INFINITY
      : policy.single[input.use];
  const recent = input.vectors.slice(-3);
  const scores = mine
    .map((p) => ({
      p,
      score: recent.reduce((n, v) => n + cosine(v, p.centroid), 0) / recent.length,
    }))
    .toSorted((a, b) => b.score - a.score);
  const [best, next] = scores;
  if (best === undefined) return { kind: "unverified", why: "no-profile" };
  if (best.score < cut || (next !== undefined && best.score - next.score < policy.margin))
    return { kind: "guest", best: best.score };
  return best.p.kind === "owner"
    ? { kind: "owner", score: best.score }
    : { kind: "saved", id: best.p.id, name: best.p.name, score: best.score };
};

/**
 * A profile's centroid from enrolment vectors. A vector far from the rest (another voice in one of his Wispr
 * clips) is dropped: kept are those within `spread` of the median vector's cosine to the first pass's mean.
 */
export const enrol = (
  vectors: ReadonlyArray<Float32Array>,
  minSamples = 3,
): { readonly centroid: Float32Array; readonly kept: number; readonly dropped: number } | null => {
  if (vectors.length < minSamples) return null;
  const mean = (vs: ReadonlyArray<Float32Array>) => {
    const out = new Float32Array(vs[0]!.length);
    for (const v of vs) {
      const u = unit(v);
      for (let i = 0; i < out.length; i += 1) out[i] = out[i]! + u[i]!;
    }
    return unit(out);
  };
  const first = mean(vectors);
  const scores = vectors.map((v) => cosine(v, first));
  const sorted = scores.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const mad = sorted.map((s) => Math.abs(s - median)).toSorted((a, b) => a - b)[
    Math.floor(sorted.length / 2)
  ]!;
  const kept = vectors.filter((_, i) => scores[i]! >= median - 3 * Math.max(mad, 0.02));
  if (kept.length < minSamples) return null;
  return { centroid: mean(kept), kept: kept.length, dropped: vectors.length - kept.length };
};
