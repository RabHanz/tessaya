/**
 * Biometric proofs, one interface for every modality (face now, voice already, palm later), and what each may prove
 * (ACCOUNTS-IDENTITY-DESIGN §3.1, research WEBCAM-FACE-ID-RESEARCH §6). Biometrics only ever reach A2, and face never
 * gets there alone: an RGB webcam cannot rule out a photo, a screen or an injected video.
 */
import type { Assurance } from "./household.ts";

export type BiometricModality = "face" | "voice" | "palm";

/** One check of one modality, from a vessel sensor that only looked because Tessaya asked. */
export interface BiometricReading {
  readonly modality: BiometricModality;
  /** The member it matched, or null for nobody enrolled. */
  readonly member: string | null;
  /** Passed liveness (face: PAD, head-turn challenge and 3D motion; voice: the turn's own audio at the act cut-off). */
  readonly live: boolean;
  /** People in view besides the one checked (face only; 0 otherwise). */
  readonly others: number;
}

/** The most a modality proves alone. Palm is RGB palm print on a webcam until a NIR palm-vein sensor exists. */
export const MODALITY_CEILING: Readonly<Record<BiometricModality, Assurance>> = {
  face: 1,
  voice: 2,
  palm: 1,
};

/** The fused ceiling: two different modalities agreeing on one member, never a step-up (A3 is a device and a body). */
export const BIOMETRIC_CEILING: Assurance = 2;

/**
 * What these readings prove about `member`. A reading that is not live or is someone else proves nothing for them;
 * a live reading of someone else in front of the camera cuts the rest to A1 (it only narrows). Two different
 * modalities agreeing lift by one level, never above A2.
 */
export const biometricAssurance = (
  readings: ReadonlyArray<BiometricReading>,
  member: string,
): Assurance => {
  const theirs = readings.filter((r) => r.live && r.member === member);
  const contradicted = readings.some((r) => r.live && r.member !== null && r.member !== member);
  if (theirs.length === 0) return 0;
  const best = Math.max(...theirs.map((r) => MODALITY_CEILING[r.modality])) as Assurance;
  const kinds = new Set(theirs.map((r) => r.modality)).size;
  const fused = Math.min(BIOMETRIC_CEILING, kinds >= 2 ? Math.max(best, 2) : best) as Assurance;
  return contradicted ? (Math.min(fused, 1) as Assurance) : fused;
};

/** A second face in view: private content hides and a spoken approval waits for a click or the phone. */
export const shoulderSurf = (reading: BiometricReading | null): boolean =>
  reading !== null && reading.modality === "face" && reading.others > 0;

/** He has walked away when no reading of him has been seen for `goneMs`, counting from the last one that was. */
export const walkedAway = (lastSeenMs: number | null, nowMs: number, goneMs = 10_000): boolean =>
  lastSeenMs !== null && nowMs - lastSeenMs >= goneMs;

/** Failed active checks: 3 in a row rest face for 5 minutes, 10 in a day turn it off until he turns it back on. */
export interface BiometricLimit {
  readonly consecutive: number;
  readonly restUntil: number;
  readonly failures: ReadonlyArray<number>;
  readonly off: boolean;
}

export const BIOMETRIC_LIMIT_START: BiometricLimit = {
  consecutive: 0,
  restUntil: 0,
  failures: [],
  off: false,
};

export const biometricAllowed = (s: BiometricLimit, nowMs: number): boolean =>
  !s.off && nowMs >= s.restUntil;

export const recordBiometricAttempt = (
  s: BiometricLimit,
  ok: boolean,
  nowMs: number,
): BiometricLimit => {
  if (ok) return { ...s, consecutive: 0 };
  const failures = [...s.failures.filter((t) => nowMs - t < 86_400_000), nowMs];
  const consecutive = s.consecutive + 1;
  if (failures.length >= 10) return { consecutive: 0, restUntil: 0, failures, off: true };
  return consecutive >= 3
    ? { consecutive: 0, restUntil: nowMs + 5 * 60_000, failures, off: false }
    : { consecutive, restUntil: s.restUntil, failures, off: false };
};

/** One JSON line from the face engine sidecar (`faceid verify|enroll|devices`). */
export type FaceEngineLine =
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "result";
      readonly ok: boolean;
      readonly reason: string;
      readonly faces: number;
      readonly perTemplate: ReadonlyArray<number>;
      readonly wallMs: number;
    };

export const parseFaceEngineLine = (line: string): FaceEngineLine | null => {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o["type"] === "progress" && typeof o["message"] === "string")
    return { type: "progress", message: o["message"] };
  if (o["type"] !== "result" || typeof o["ok"] !== "boolean") return null;
  const per = Array.isArray(o["per_template"]) ? o["per_template"] : [];
  return {
    type: "result",
    ok: o["ok"],
    reason: typeof o["reason"] === "string" ? o["reason"] : "unknown",
    faces: typeof o["faces"] === "number" ? o["faces"] : 0,
    perTemplate: per.filter((x): x is number => typeof x === "number"),
    wallMs: typeof o["wall_ms"] === "number" ? o["wall_ms"] : 0,
  };
};

/** The engine's match bar (face_engine.h Thresholds::match); a template at or above it is that member. */
export const FACE_MATCH = 0.5;

/**
 * Which member a passive face scan saw, given the members in template order. The best score over the bar wins; a
 * second member over the bar too is ambiguous and names nobody.
 */
export const faceReading = (
  result: Extract<FaceEngineLine, { type: "result" }>,
  members: ReadonlyArray<string>,
  live: boolean,
): BiometricReading => {
  const over = members
    .map((m, i) => ({ m, s: result.perTemplate[i] ?? -1 }))
    .filter((x) => x.s >= FACE_MATCH)
    .toSorted((a, b) => b.s - a.s);
  return {
    modality: "face",
    member: over.length === 1 ? over[0]!.m : null,
    live: live && result.faces === 1,
    others: Math.max(0, result.faces - 1),
  };
};
