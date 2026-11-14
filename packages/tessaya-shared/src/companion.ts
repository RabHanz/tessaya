/**
 * What her character does on the companion surfaces (the desktop mascot, her face in the pill, a phone): one cue per
 * change of state, never a loop, so a surface draws nothing at rest. The names are the Character Studio's
 * (apps/desktop/resources/tessaya/companion/rig.js).
 */
import type { TessayaSessionState } from "@t3tools/tessaya-contracts";

import type { TurnPhase } from "./voiceTurn.ts";

/** Lively: every reaction and an occasional wander. Calm (default): reactions without the extra acts. Important
 * only: still except for her replies, finished or failed jobs and what needs him (after Taby's "Important only"). */
export type CompanionMotion = "lively" | "calm" | "important";
export const COMPANION_MOTIONS: ReadonlyArray<CompanionMotion> = ["lively", "calm", "important"];
export const parseCompanionMotion = (value: unknown): CompanionMotion =>
  COMPANION_MOTIONS.includes(value as CompanionMotion) ? (value as CompanionMotion) : "calm";

export type CompanionMoment =
  | "rest"
  | "listening"
  | "thinking"
  | "speaking"
  | "done"
  | "failed"
  | "needs"
  | "asleep";

export interface CompanionCue {
  readonly expression: string;
  /** A short act played once. */
  readonly clip?: string;
  /** A short burst (sparkle, sweat). */
  readonly fx?: string;
}

const CUES: Readonly<Record<CompanionMoment, CompanionCue>> = {
  rest: { expression: "neutral" },
  listening: { expression: "attentive", clip: "leanIn" },
  thinking: { expression: "thinking" },
  speaking: { expression: "happy" },
  done: { expression: "proud", clip: "hop", fx: "sparkle" },
  failed: { expression: "concerned", fx: "sweat" },
  needs: { expression: "curious", clip: "raiseHand" },
  asleep: { expression: "asleep" },
};

/** Moments that are worth a reaction even in Important only. */
const IMPORTANT = new Set<CompanionMoment>([
  "rest",
  "speaking",
  "done",
  "failed",
  "needs",
  "asleep",
]);
/** Acts Calm keeps: the ones that tell him something happened. */
const CALM_ACTS = new Set<CompanionMoment>(["done", "needs"]);

/** The pill's phase as her moment; null leaves her as she is (dictation and its confirmations are his, not hers). */
export const momentOf = (phase: TurnPhase): CompanionMoment | null => {
  switch (phase) {
    case "listening":
      return "listening";
    case "thinking":
    case "working":
      return "thinking";
    case "speaking":
      return "speaking";
    case "error":
      return "failed";
    case "idle":
    case "ended":
    case "muted":
      return "rest";
    case "dictating":
    case "done":
      return null;
  }
};

/** The cue for a moment at his motion level; null means she stays exactly as she is. */
export const cueFor = (moment: CompanionMoment, motion: CompanionMotion): CompanionCue | null => {
  const cue = CUES[moment];
  if (motion === "lively") return cue;
  if (motion === "important" && !IMPORTANT.has(moment)) return null;
  if (CALM_ACTS.has(moment)) return cue;
  return {
    expression: cue.expression,
    ...(motion === "calm" && cue.fx !== undefined ? { fx: cue.fx } : {}),
  };
};

/** Only Lively wanders; Calm and Important only stay where he put her. */
export const wanders = (motion: CompanionMotion): boolean => motion === "lively";

/** Her face in the pill shows only while he is talking to her, and not while the desktop mascot is on. */
export const islandFaceShows = (input: {
  readonly phase: TurnPhase;
  readonly faceOn: boolean;
  readonly mascotOn: boolean;
}): boolean =>
  input.faceOn &&
  !input.mascotOn &&
  (input.phase === "listening" ||
    input.phase === "thinking" ||
    input.phase === "working" ||
    input.phase === "speaking");

export interface JobSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: TessayaSessionState;
}

const JOB_MOMENT: Partial<Record<TessayaSessionState, CompanionMoment>> = {
  done_unseen: "done",
  failed: "failed",
  needs_approval: "needs",
  needs_input: "needs",
};

/**
 * What changed between two reads of the jobs, as moments: a job that just finished, failed or started waiting for him.
 * The first read (prev null) is what was already there, so it says nothing.
 */
export const jobMoments = (
  prev: ReadonlyArray<JobSnapshot> | null,
  next: ReadonlyArray<JobSnapshot>,
): ReadonlyArray<{ readonly moment: CompanionMoment; readonly title: string }> => {
  if (prev === null) return [];
  const before = new Map(prev.map((job) => [job.id, job.state]));
  return next.flatMap((job) => {
    const moment = JOB_MOMENT[job.state];
    if (moment === undefined || before.get(job.id) === job.state) return [];
    // Done to done_unseen and back are the same news.
    if (moment === JOB_MOMENT[before.get(job.id) ?? "idle"]) return [];
    return [{ moment, title: job.title }];
  });
};
