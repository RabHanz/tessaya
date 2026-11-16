/**
 * The people graph's pure rules (HOUSEHOLD-DESIGN §11): where a stranger's voice goes, which people may be the same,
 * and how a voice that was two people splits. What she is told about a person is tessaya-shared/people.
 */
import type { PersonStatus } from "@t3tools/tessaya-shared/people";
import { CAMPLUS_POLICY, cosine } from "@t3tools/tessaya-voice/speaker";

/**
 * From Voice ID's CAM++ numbers on his room (speaker.ts, 16 Nov): a 2-10 s turn at the steer cut-off is the same voice
 * (FAR <= 1.2%), so it joins without asking; from the listen cut-off up it may be, so the owner is asked. Under 2 s a
 * stranger's clip is too unsure to file: his own 2.2 s turns scored 0.27 against his profile, in the impostor range.
 */
export const VOICE_RULES = {
  join: CAMPLUS_POLICY.single.steer,
  suggest: CAMPLUS_POLICY.single.listen,
  minMs: 2_000,
  /** A centroid learns from at most this many clips' worth, so one odd clip can't drag a settled voice. */
  maxWeight: 20,
} as const;

/**
 * Days an unnamed voice is kept from first heard; 0 keeps it, as everyone named is kept (the Director, 16 Nov:
 * "they should be remembered, not just faded off"). The owner may set an expiry, for unnamed voices only.
 */
export const UNNAMED_DAYS_DEFAULT = 0;

export interface VoiceNode {
  readonly id: string;
  readonly status: PersonStatus;
  readonly centroid: Float32Array;
  readonly samples: number;
}

export type Placement =
  | { readonly kind: "join"; readonly id: string; readonly score: number }
  | { readonly kind: "new"; readonly near: { readonly id: string; readonly score: number } | null };

/** Where a clip goes: into the nearest voice at the join cut-off, else a new one (noting a near one to ask about). */
export const placeVoice = (vector: Float32Array, nodes: ReadonlyArray<VoiceNode>): Placement => {
  let best: { id: string; score: number } | null = null;
  for (const n of nodes) {
    const score = cosine(vector, n.centroid);
    if (Number.isFinite(score) && (best === null || score > best.score)) best = { id: n.id, score };
  }
  if (best !== null && best.score >= VOICE_RULES.join) return { kind: "join", ...best };
  return { kind: "new", near: best !== null && best.score >= VOICE_RULES.suggest ? best : null };
};

const unit = (v: Float32Array): Float32Array => {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
};

/** The centroid after one more clip (or another centroid of `weight` clips), as a unit vector. */
export const mergeCentroid = (
  centroid: Float32Array,
  samples: number,
  add: Float32Array,
  weight = 1,
): Float32Array => {
  const w = Math.min(samples, VOICE_RULES.maxWeight);
  const a = Math.min(weight, VOICE_RULES.maxWeight);
  return unit(centroid.map((x, i) => (x * w + add[i]! * a) / (w + a)));
};

const mean = (vs: ReadonlyArray<Float32Array>): Float32Array =>
  unit(vs[0]!.map((_, i) => vs.reduce((s, v) => s + v[i]!, 0) / vs.length));

/**
 * Two groups for a voice that may be two people (2-means from the farthest pair): the clips in each, and how alike the
 * groups' centres are. Null under four clips, too few to tell.
 */
export const splitTwo = (
  vectors: ReadonlyArray<Float32Array>,
): {
  readonly a: ReadonlyArray<number>;
  readonly b: ReadonlyArray<number>;
  readonly score: number;
} | null => {
  if (vectors.length < 4) return null;
  let seeds: [number, number] = [0, 1];
  let far = Number.POSITIVE_INFINITY;
  for (let i = 0; i < vectors.length; i += 1)
    for (let j = i + 1; j < vectors.length; j += 1) {
      const s = cosine(vectors[i]!, vectors[j]!);
      if (s < far) [far, seeds] = [s, [i, j]];
    }
  let ca = vectors[seeds[0]]!;
  let cb = vectors[seeds[1]]!;
  let a: number[] = [];
  let b: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    a = [];
    b = [];
    vectors.forEach((v, i) => (cosine(v, ca) >= cosine(v, cb) ? a : b).push(i));
    if (a.length === 0 || b.length === 0) return null;
    ca = mean(a.map((i) => vectors[i]!));
    cb = mean(b.map((i) => vectors[i]!));
  }
  return { a, b, score: cosine(ca, cb) };
};

export type Suggestion =
  | {
      readonly kind: "same";
      readonly a: string;
      readonly b: string;
      readonly score: number;
    }
  | { readonly kind: "name"; readonly id: string; readonly heard: number }
  | { readonly kind: "split"; readonly id: string; readonly score: number };

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * What to put to the owner: voices that may be one person (from the listen cut-off up, never two members, never a
 * pair he said are different), unknown voices heard three times or more, and voices whose clips fall into two groups
 * less alike than the listen cut-off.
 */
export const suggestionsFor = (
  nodes: ReadonlyArray<VoiceNode & { readonly heard: number; readonly split: number | null }>,
  different: ReadonlySet<string>,
): ReadonlyArray<Suggestion> => {
  const out: Suggestion[] = [];
  const voices = nodes.filter((n) => n.status !== "not_person");
  for (let i = 0; i < voices.length; i += 1)
    for (let j = i + 1; j < voices.length; j += 1) {
      const [x, y] = [voices[i]!, voices[j]!];
      if (x.status === "member" && y.status === "member") continue;
      if (different.has(pairKey(x.id, y.id))) continue;
      const score = cosine(x.centroid, y.centroid);
      if (score >= VOICE_RULES.suggest) out.push({ kind: "same", a: x.id, b: y.id, score });
    }
  for (const n of voices) {
    if (n.status === "unknown" && n.heard >= 3)
      out.push({ kind: "name", id: n.id, heard: n.heard });
    if (n.split !== null && n.split < VOICE_RULES.suggest)
      out.push({ kind: "split", id: n.id, score: n.split });
  }
  return out.sort(
    (p, q) =>
      ("score" in q ? q.score : 0) - ("score" in p ? p.score : 0) ||
      ("heard" in q ? q.heard : 0) - ("heard" in p ? p.heard : 0),
  );
};
