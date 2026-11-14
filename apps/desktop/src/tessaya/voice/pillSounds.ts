/**
 * When the pill's cues sound and how loud. The notes and their wave live in `@t3tools/tessaya-voice` (cueSounds.ts), shared
 * with the R1's room loop; scripts/tessaya/voice-lab/sound-score.ts puts the same waves through the wake models and Silero.
 */

import type { TurnPhase } from "@t3tools/tessaya-shared/voiceTurn";

export {
  PILL_PARTIAL,
  PILL_SOUNDS,
  renderSound,
  soundMs,
  type PillNote,
  type PillSound,
} from "@t3tools/tessaya-voice";

/**
 * Whether the end cue sounds as the pill goes from `before` to `now` (null: it lowers). Once, when listening ends:
 * as the window closes ("ended"), or as it lowers from anything that had not ended already. Never seconds later as
 * an ended pill lowers: then it would blank the microphone over a name he may be saying.
 */
export const endCueOn = (before: TurnPhase, now: TurnPhase | null): boolean =>
  now === "ended"
    ? before !== "ended"
    : now === null &&
      before !== "idle" &&
      before !== "ended" &&
      before !== "error" &&
      before !== "done";

/** Cue levels: "Quiet" is half of "Normal"; Off plays nothing. */
export type CueLevel = "off" | "quiet" | "normal";
export const CUE_GAIN: Readonly<Record<CueLevel, number>> = { off: 0, quiet: 0.5, normal: 1 };
export const parseCueLevel = (value: unknown, legacySounds?: unknown): CueLevel =>
  value === "off" || value === "quiet" || value === "normal"
    ? value
    : legacySounds === false
      ? "off"
      : "normal";

/** After a cue the mic path stays silent this much longer, so its echo cannot be heard as speech. */
export const CUE_TAIL_MS = 150;
/** A cue waits at most this long for him to stop speaking, then is dropped. */
export const CUE_WAIT_MS = 300;
/** Thinking cue: after this long, then at most this often. */
export const THINKING_AFTER_MS = 4_000;
export const THINKING_EVERY_MS = 8_000;
