/**
 * Voice match (VOICE-ID): whose voice an utterance is, from speaker embeddings (the model runs in speakerOnnx.ts).
 * Where Voice ID runs, a weak, late or missing verdict is "unverified" with a guest's reach, never his (16 Nov); only
 * a vessel where it cannot run (`voiceIdOff`) keeps his path for every voice. @module baton-voice/speaker
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
  /** Their voice as this device's own mic hears it, learnt from turns it was sure of (profileSync): scored beside `centroid`. */
  readonly room?: Float32Array;
  /** Their voice from across the room, softer and duller (farVoice): only whether it is them talking, never to act. */
  readonly far?: Float32Array;
}

/**
 * The far centroid counts from here up. His far-degraded held-out clips scored 0.33-0.72 with it; 790 degraded clips of
 * 40 other speakers (LibriSpeech) at most 0.42, none accepted (20 Nov): below this it adds nothing but risk.
 */
export const FAR_MIN = 0.45;

/**
 * A clip's cosine to a profile: the best of its enrolled centroid, this device's room centroid and, for "is it them
 * talking" (any use but `act`), their far voice from FAR_MIN up. Acting on their word never rests on the far one.
 */
export const profileScore = (
  vector: Float32Array,
  profile: SpeakerProfile,
  use: SpeakerUse = "steer",
): number => {
  const near =
    profile.room === undefined
      ? cosine(vector, profile.centroid)
      : Math.max(cosine(vector, profile.centroid), cosine(vector, profile.room));
  if (use === "act" || profile.far === undefined) return near;
  const far = cosine(vector, profile.far);
  return far >= FAR_MIN ? Math.max(near, far) : near;
};

/** Which mic a turn came through (upformat v1 flags bit4 is the headset's): a voice sounds different on each. */
export type VoiceInput = "mic" | "headset";

/** The profiles to judge a turn on this input by: each person's own for it, else the one enrolled on her mic. */
export const profilesFor = (
  own: ReadonlyArray<SpeakerProfile>,
  mic: ReadonlyArray<SpeakerProfile>,
): ReadonlyArray<SpeakerProfile> => [...own, ...mic.filter((p) => !own.some((o) => o.id === p.id))];

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
/**
 * Tumble's room mic, scored with its room centroid: steer 0.40 (17 Nov, held out: his room clips 57% -> 91%, LibriSpeech
 * 2/4 s 0%, no stranger, replay or clone verified). Act is unchanged, so owner-only acts are as strict as before.
 */
export const ROOM_POLICY: Omit<SpeakerPolicy, "model"> = {
  ...CAMPLUS_POLICY,
  single: { ...CAMPLUS_POLICY.single, steer: 0.4 },
  averaged: { ...CAMPLUS_POLICY.averaged, steer: 0.4 },
};
/** One clip must be this long to be scored at the "act" level on its own. */
export const ACT_SINGLE_MS = 4_000;

export type SpeakerVerdict =
  | { readonly kind: "owner"; readonly score: number }
  | { readonly kind: "saved"; readonly id: string; readonly name: string; readonly score: number }
  | { readonly kind: "guest"; readonly best: number }
  | {
      readonly kind: "unverified";
      readonly why: "no-model" | "no-profile" | "stale-profile" | "too-short" | "failed";
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
  // His profile from another model only means this one is not enrolled yet: closed, never "no Voice ID here".
  if (!mine.some((p) => p.kind === "owner"))
    return input.profiles.some((p) => p.kind === "owner")
      ? { kind: "unverified", why: "stale-profile" }
      : { kind: "unverified", why: "no-profile" };
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
    score: used.reduce((n, c) => n + profileScore(c.vector, p, input.use), 0) / used.length,
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
  /** Unverified because Voice ID cannot run here at all: the one unverified voice still on his path. */
  readonly voiceIdOff?: true;
  /** The test clone, trusted as him only while test mode is on (roomTestMode.ts); every such turn is marked. */
  readonly test?: true;
  /** This turn's own cosine to his profile and its length, whatever the verdict (even too short): session evidence. */
  readonly own?: {
    readonly score: number;
    readonly ms: number;
    /** The turn's embedding, for his session's same-voice check and the room profile; never sent off this device. */
    readonly vector?: Float32Array;
  };
  /** Its cosine to his own pieces earlier in this verified session (same room, same mic), whenever it has some. */
  readonly same?: number;
  /** His held session's verdict on a turn not clearly his: never teaches or keeps his voice. */
  readonly carried?: true;
  /** His by his session's evidence, not this turn's own score: verified only as his held session (`session`). */
  readonly lifted?: true;
  /** The replay check on the room mic: "heard" a loudspeaker (a guest), or "unchecked" (it could not run: never verified). */
  readonly replay?: "heard" | "unchecked";
  /** The replay model's logit whenever it judged the turn (a pass has no `replay`): how the check is measured live. */
  readonly replayScore?: number;
  /** `verified` by his session (three turns averaged, or a hold), not this turn's own clips: never opens anything private. */
  readonly session?: true;
  /**
   * A guest's own embedding (base64 float32) for her server's people graph, so she knows them next time
   * (HOUSEHOLD-DESIGN §11). Numbers, never audio; only on a clip long enough to file.
   */
  readonly print?: { readonly model: string; readonly vector: string; readonly ms: number };
}

/** The identity as it leaves this device: the turn's embedding stays here (a guest's `print` is the one that travels). */
export const forWire = (identity: SpeakerIdentity): SpeakerIdentity =>
  identity.own?.vector === undefined
    ? identity
    : { ...identity, own: { score: identity.own.score, ms: identity.own.ms } };

/** A stranger's clip shorter than this is too unsure to file (his own 2.2 s turns scored 0.27 against his profile). */
export const PRINT_MIN_MS = 2_000;

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
  if (listen.kind === "unverified")
    return listen.why === "no-model" || listen.why === "no-profile"
      ? { ...UNVERIFIED(at), voiceIdOff: true }
      : UNVERIFIED(at);
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

/**
 * His voice across one session. Three owner turns averaging the "act" cut-off, or one verified, hold him for `HOLD_MS`.
 * A short or weak turn is lifted when its own score clears `SESSION_FLOOR`, sits near his last two pieces, and averaged
 * with them clears steer. While he is held, any turn not clearly another voice (`CHANGED_VOICE`) carries the session's
 * verdict; a clearly other voice ends it. A lifted turn is verified only by a held session (`session`).
 */
export interface VoiceHold {
  readonly verifiedAt: number | null;
  readonly scores: ReadonlyArray<number>;
  /** His recent pieces that cleared the floor: what can lift a short or weak turn. */
  readonly evidence: ReadonlyArray<{ readonly at: number; readonly score: number }>;
  /** The embeddings of his last two owner turns: what a later turn in a verified session is compared with. */
  readonly anchor: ReadonlyArray<Float32Array>;
}
export const NO_HOLD: VoiceHold = { verifiedAt: null, scores: [], evidence: [], anchor: [] };
export const HOLD_MS = 5 * 60_000;
/**
 * CAM++: under this a turn's score is no evidence for his session. His live short turns on Tumble sit at 0.36-0.38
 * (16 Nov 12:35Z); LibriSpeech 1-2 s p99.5 is 0.35.
 */
export const SESSION_FLOOR = 0.35;
/** A short or weak turn averaged with his last pieces must reach this (held-out: the clone and strangers are unchanged). */
const SESSION_MEAN = 0.37;
/** A turn this far under his recent pieces' mean is a change of voice, however high the mean. */
const SESSION_NEAR = 0.4;
/** Under this much speech a low score is too noisy to call a change: the turn is only not lifted. */
const CHANGE_MIN_MS = 1_000;
/**
 * A turn in his verified session this close (cosine) to his own pieces earlier in it is still him, whatever its score to
 * his profile: same room, same mic. Tumble 14-17 Nov, held out: his path 95% of his clips, other room voices inside his
 * session 0.03-0.07% (0.2-0.3% at 0.4).
 */
export const SAME_VOICE = 0.45;
/** Under this, with a second of speech, the voice clearly changed (his own next turn p1 0.22-0.29). */
export const CHANGED_VOICE = 0.2;

export const meanUnit = (vs: ReadonlyArray<Float32Array>): Float32Array =>
  unitOrNull(Float32Array.from(vs[0]!, (_, i) => vs.reduce((n, v) => n + v[i]!, 0))) ?? vs[0]!;

/**
 * A scored turn on his path while his verified session holds carries the session's verdict, as his own turns in it do:
 * one verdict for the session, never this turn's own clips (`session`), so nothing private opens on it (21 Nov).
 */
const sessionVerdict = (held: boolean) =>
  held ? { verified: true, session: true as const } : { verified: false };

export const holdVoice = (
  hold: VoiceHold,
  identity: SpeakerIdentity,
  now: number,
  policy: Omit<SpeakerPolicy, "model"> = CAMPLUS_POLICY,
): { readonly hold: VoiceHold; readonly identity: SpeakerIdentity } => {
  const held = hold.verifiedAt !== null && now - hold.verifiedAt <= HOLD_MS;
  // The test clone is trusted turn by turn while test mode is on, and never leaves him held once it ends.
  if (identity.kind === "saved" || identity.test === true) return { hold: NO_HOLD, identity };
  const own = identity.own?.score ?? (identity.kind === "owner" ? identity.confidence : null);
  const recent = hold.evidence.filter((e) => now - e.at <= HOLD_MS);
  const evidence =
    own !== null && own >= SESSION_FLOOR ? [...recent, { at: now, score: own }].slice(-3) : recent;
  const vector = identity.replay === undefined ? identity.own?.vector : undefined;
  const same =
    held && vector !== undefined && hold.anchor.length > 0
      ? cosine(vector, meanUnit(hold.anchor))
      : null;
  if (identity.kind === "owner") {
    const scores = [...hold.scores, own ?? 0].slice(-3);
    const averaged =
      scores.length === 3 && scores.reduce((a, b) => a + b, 0) / 3 >= policy.averaged.act;
    const verified = identity.replay === undefined && (identity.verified || averaged || held);
    return {
      hold: {
        verifiedAt: verified ? now : hold.verifiedAt,
        scores,
        evidence,
        anchor: vector === undefined ? hold.anchor : [...hold.anchor, vector].slice(-2),
      },
      identity: {
        ...identity,
        verified,
        ...(verified && !identity.verified ? { session: true as const } : {}),
        ...(same === null ? {} : { same }),
      },
    };
  }
  if (own === null) {
    // Not scored (a guess before the verdict, an embedding that failed): a held session keeps his path, nothing more.
    if (identity.kind === "guest") return { hold: NO_HOLD, identity };
    return held
      ? { hold, identity: { ...identity, kind: "owner", personId: "owner", lifted: true } }
      : { hold, identity };
  }
  const last = recent.slice(-2).map((e) => e.score);
  const mean = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // shortcut: a guest by margin (him against a saved person) can lift too; split them once two saved people are measured.
  if (
    last.length > 0 &&
    own >= SESSION_FLOOR &&
    own >= mean(last) - SESSION_NEAR &&
    mean([own, ...last]) >= SESSION_MEAN
  )
    return {
      hold: { ...hold, verifiedAt: held ? now : hold.verifiedAt, evidence },
      identity: {
        ...identity,
        kind: "owner",
        personId: "owner",
        name: null,
        confidence: own,
        ...sessionVerdict(held && identity.replay === undefined),
        lifted: true,
      },
    };
  // In a verified session his own earlier pieces judge a follow-up better than his profile does (17 Nov: his bedroom
  // replies scored 0.1-0.3 against it). Still his path only, never an owner-only act.
  if (same !== null && same >= SAME_VOICE)
    return {
      hold: { ...hold, verifiedAt: now, evidence },
      identity: {
        ...identity,
        kind: "owner",
        personId: "owner",
        name: null,
        confidence: own,
        ...sessionVerdict(true),
        lifted: true,
        same,
      },
    };
  const long = (identity.own?.ms ?? CHANGE_MIN_MS) >= CHANGE_MIN_MS;
  // Only a clearly other voice ends his held session: his own Tumble turns scored 0.23-0.31 to his profile (26 Nov).
  const changed =
    same !== null ? same < CHANGED_VOICE : own < (held ? CHANGED_VOICE : SESSION_FLOOR);
  if (long && changed) return { hold: NO_HOLD, identity };
  // Not clearly another voice: his held session's one verdict carries it (26 Nov, Director).
  if (held && identity.replay === undefined)
    return {
      hold: { ...hold, evidence },
      identity: {
        ...identity,
        kind: "owner",
        personId: "owner",
        name: null,
        confidence: own,
        ...sessionVerdict(true),
        lifted: true,
        carried: true,
        ...(same === null ? {} : { same }),
      },
    };
  if (same !== null) return { hold: { ...hold, evidence }, identity: { ...identity, same } };
  return identity.kind === "guest"
    ? { hold: { ...NO_HOLD, evidence }, identity }
    : { hold: { ...hold, evidence }, identity };
};

/**
 * Whether this turn may teach this device's room profile for its person, and on what evidence: verified on its own
 * clips, verified by his session, or the same voice as his verified session's own pieces by a wide margin. Never a
 * replay or a turn the replay check could not judge, the test clone, a guest or a turn under 1.5 s.
 */
export const teaches = (
  identity: SpeakerIdentity,
): "verified" | "session" | "continuity" | null => {
  if (
    identity.personId === null ||
    identity.kind === "guest" ||
    identity.kind === "unverified" ||
    identity.test === true ||
    identity.carried === true ||
    identity.replay !== undefined ||
    identity.own?.vector === undefined ||
    identity.own.ms < TEACH_MIN_MS
  )
    return null;
  if (identity.verified) return identity.session === true ? "session" : "verified";
  return identity.lifted === true && (identity.same ?? 0) >= TEACH_SAME ? "continuity" : null;
};
const TEACH_MIN_MS = 1_500;
/** Far above other voices' likeness to his session (p99 0.31-0.42), so a lifted turn that teaches is surely his. */
const TEACH_SAME = 0.5;

/**
 * A session's first turn, also scored as one clip with her name's clip before it (`joined`): his when that clears steer
 * and the turn alone clears the floor. Held-out, 16 Nov: his first turns 78% to 97%; the clone and strangers on their own
 * unchanged (7.5%, 0%); the clone speaking after he called her 7.5% to 15%, as inside his session. Never `verified`.
 */
export const withName = (turn: SpeakerIdentity, joined: SpeakerIdentity): SpeakerIdentity =>
  turn.kind !== "owner" &&
  turn.kind !== "saved" &&
  turn.test !== true &&
  joined.kind === "owner" &&
  (turn.own?.score ?? Number.NEGATIVE_INFINITY) >= SESSION_FLOOR
    ? {
        ...turn,
        kind: "owner",
        personId: "owner",
        name: null,
        confidence: turn.own!.score,
        verified: false,
        lifted: true,
      }
    : turn;

/**
 * The replay check's verdict on a room-mic turn (V-045): a loudspeaker playing a voice, his own recordings or a clone of
 * him, is a guest whatever its voice scores, and ends his session. With no verdict (no model, or it failed) the turn keeps
 * its path but never opens an owner-only act: never fail open.
 */
/**
 * The replay model's logit cut-off (replay.onnx sha 8ab0f145, trained 17 Nov on his room). Over all 696 of his live Tumble clips
 * 0.4% score above it. Held-out playback passes 3 of 190: 0 of 150 cast through the office speaker today, 3 of 40 of the 16 Nov
 * Bluetooth clone.
 */
export const REPLAY_CUT = -3;
export const replayChecked = (
  identity: SpeakerIdentity,
  logit: number | null,
  cut: number,
): SpeakerIdentity => {
  if (logit === null || !Number.isFinite(logit))
    return { ...identity, verified: false, replay: "unchecked" };
  return logit >= cut
    ? {
        ...UNVERIFIED(identity.at),
        kind: "guest",
        confidence: identity.confidence,
        replay: "heard",
        replayScore: logit,
      }
    : { ...identity, replayScore: logit };
};

/** His profile's cosine to one clip, the best of his owner profiles for this model; null with none. */
export const ownerScoreOf = (
  vector: Float32Array,
  profiles: ReadonlyArray<SpeakerProfile>,
  model: string,
): number | null => {
  const scores = profiles
    .filter((p) => p.kind === "owner" && p.model === model)
    .map((p) => profileScore(vector, p))
    .filter(Number.isFinite);
  return scores.length === 0 ? null : Math.max(...scores);
};

/**
 * Test mode (Director, 16 Nov): the test clone's own profile, enrolled apart from him, is him only until `until` and a
 * guest after it. Every turn it lets through is marked `test`. Never a switch that skips Voice ID: any other voice is
 * judged exactly as before.
 */
export const TEST_SPEAKER_ID = "test-speaker";
export const TEST_MODE_MAX_MS = 2 * 60 * 60_000;
export const trustTestSpeaker = (
  identity: SpeakerIdentity,
  now: number,
  until: number,
): SpeakerIdentity => {
  if (identity.personId !== TEST_SPEAKER_ID) return identity;
  if (now >= until)
    return { ...UNVERIFIED(identity.at), kind: "guest", confidence: identity.confidence };
  return {
    ...identity,
    kind: "owner",
    personId: "owner",
    name: null,
    inherited: false,
    test: true,
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

/**
 * In his own session, a voice just under the listen bar is likely him (20 Nov: his words read low and were ignored):
 * answered as unverified, so it grants and writes nothing. Never a replay. `anchored`: a turn here verified him at the
 * anchor bar, so any low score is his soft voice unless Voice ID is sure it changed (`same` under CHANGED_VOICE).
 * shortcut: interim until per-mic calibration and AEC on barge-in audio; 0.25 is a guess below 0.36, not measured.
 */
export const LIKELY_HIS_FLOOR = 0.25;
export const likelyHis = (
  identity: SpeakerIdentity,
  hisSession: boolean,
  anchored = false,
): SpeakerIdentity =>
  (hisSession || anchored) &&
  identity.kind === "guest" &&
  identity.replay !== "heard" &&
  !(identity.same !== undefined && identity.same < CHANGED_VOICE) &&
  (anchored || (identity.confidence ?? Number.NEGATIVE_INFINITY) >= LIKELY_HIS_FLOOR)
    ? { ...UNVERIFIED(identity.at), confidence: identity.confidence }
    : identity;

/** His own path, or the outside one (fresh session, read-only, a proposal for anything that acts). */
export const speakerPath = (identity: SpeakerIdentity | null): "his" | "outside" =>
  identity === null ||
  identity.kind === "owner" ||
  (identity.kind === "unverified" && identity.voiceIdOff === true)
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

/**
 * Is a voice that talked over her one of the household's (any enrolled profile), from its first second or so? Short
 * clips score lower than a turn, so the cut-offs are per length (CAM++, 14 Nov: his 0.6 s clips 0.24 at the 2nd
 * percentile, 1 s p10 0.38; 109 other speakers 0.6 s p95 0.17, 1 s at most 0.33). "unsure" waits for more of it.
 */
export const memberByVoice = (
  best: number,
  seconds: number,
  /** His session holds recent evidence: her voice in the mix lowers his (12:36Z, 16 Nov: 0.33); strangers 1-2 s >= 0.30: 0.6%. */
  held = false,
  /**
   * He opened this session (her name or S2): a voice over hers is his until surely not. Under her own audio his 0.6 s
   * scored 0.03 and 0.01 and she went on over him (20 Nov 17:15); so "other" waits for 2 s and a score under 0.2.
   */
  his = false,
): "member" | "other" | "unsure" => {
  if (!Number.isFinite(best)) return his ? "unsure" : "other";
  if (best >= (seconds < 1.25 ? 0.4 : 0.36) - (held ? 0.06 : 0)) return "member";
  if (his) return seconds >= 2 && best < 0.2 ? "other" : "unsure";
  // Early only when plainly someone else: his own first half second can score low in a loud room (bench, 14 Nov).
  if (seconds >= 2 || (seconds >= 1 && best < 0.2) || best < 0.1) return "other";
  return "unsure";
};
