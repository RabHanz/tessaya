/**
 * One `dictation_timing` line per dictation: where the time went from key press to the pill leaving. The sidecar
 * measures up to its text from the key press; the desktop adds cleanup, paste and the pill on its own clock, anchored
 * at the moment the text arrived. Durations only, never words.
 */
import type { DictationEvent, SidecarTiming } from "./dictationSidecar.ts";

type TextEvent = Extract<DictationEvent, { ev: "text" }>;

export interface DictationTimingLine {
  readonly via: SidecarTiming["via"] | "voice";
  /** Key press → microphone open, → first audio, → release (the hold). */
  readonly micMs: number | null;
  readonly firstAudioMs: number | null;
  readonly heldMs: number | null;
  /** Release → text from the model; only the piece after the last pause is left to decode by then. */
  readonly asrMs: number | null;
  readonly loadMs: number;
  readonly inferMs: number | null;
  readonly pieces: number | null;
  /** The words came from the preview at his last pause, so release decoded nothing. */
  readonly reused: boolean | null;
  /** His server wrote the words, the laptop did, or the laptop after his server failed. */
  readonly recognizer: string | null;
  /** What recognised them here: the CPU, the graphics card, or the CPU after the card failed. */
  readonly backend: string | null;
  readonly audioMs: number | null;
  /** Text → cleaned, → fitted to the caret, → pasted, → pill gone; null for a stage that did not happen. */
  readonly cleanupMs: number | null;
  readonly cleanup: string | null;
  /** Why a clean-up fell back (a timeout, the key's error, a refused rewrite); null when it did not. */
  readonly cleanupWhy: string | null;
  /** The cleaned text was ready from the pause before release. */
  readonly speculated: boolean;
  readonly fitMs: number | null;
  readonly pasteMs: number | null;
  readonly pillGoneMs: number | null;
  /** Release → text in place, and release → pill gone: what he feels. */
  readonly releaseToPasteMs: number | null;
  readonly releaseToPillGoneMs: number | null;
  readonly chars: number;
}

export interface DictationTimer {
  readonly cleaned: (stage: string, speculated?: boolean, at?: number, why?: string) => void;
  readonly fitted: (at?: number) => void;
  readonly pasted: (at?: number) => void;
  readonly pillGone: (at?: number) => void;
  /** The line, once it has been pasted and the pill has gone (or `force` for one that will not get both). */
  readonly line: (force?: boolean) => DictationTimingLine | null;
}

export const startDictationTiming = (
  event: TextEvent,
  via: DictationTimingLine["via"] | null = null,
  now: () => number = Date.now,
): DictationTimer => {
  const textAt = now();
  const timing = event.timing ?? null;
  const releaseAt = event.releaseMs == null ? null : (event.arrivedAt ?? textAt) - event.releaseMs;
  const asrMs = releaseAt === null ? null : textAt - releaseAt;
  let cleanedAt: number | null = null;
  let cleanup: string | null = null;
  let cleanupWhy: string | null = null;
  let speculated = false;
  let fittedAt: number | null = null;
  // The sidecar pasted it itself (cleanup off): it landed as the text came.
  let pastedAt: number | null = event.pasted === true && event.pasteMs != null ? textAt : null;
  let pillAt: number | null = null;
  let given = false;
  const since = (at: number | null, from: number | null) =>
    at === null || from === null ? null : Math.max(0, at - from);
  return {
    cleaned: (stage, guessed = false, at = now(), why) => {
      if (cleanedAt === null) {
        speculated = guessed;
        cleanupWhy = why ?? null;
      }
      cleanedAt ??= at;
      cleanup ??= stage;
    },
    fitted: (at = now()) => {
      fittedAt ??= at;
    },
    pasted: (at = now()) => {
      pastedAt ??= at;
    },
    pillGone: (at = now()) => {
      pillAt ??= at;
    },
    line: (force = false) => {
      if (given || (!force && (pastedAt === null || pillAt === null))) return null;
      given = true;
      return {
        via: via ?? timing?.via ?? "voice",
        micMs: timing?.micMs ?? null,
        firstAudioMs: timing?.firstAudioMs ?? null,
        heldMs: timing === null ? null : timing.releasedMs,
        asrMs,
        loadMs: event.loadMs ?? 0,
        inferMs: event.inferMs ?? null,
        pieces: event.pieces ?? null,
        reused: timing?.reused ?? null,
        recognizer: timing?.recognizer ?? null,
        backend: timing?.backend ?? null,
        audioMs: event.audioMs ?? null,
        cleanupMs: since(cleanedAt, textAt),
        cleanup,
        cleanupWhy,
        speculated,
        fitMs: since(fittedAt, cleanedAt ?? textAt),
        pasteMs: event.pasteMs ?? since(pastedAt, fittedAt ?? cleanedAt ?? textAt),
        pillGoneMs: since(pillAt, pastedAt ?? textAt),
        releaseToPasteMs: since(pastedAt, releaseAt),
        releaseToPillGoneMs: since(pillAt, releaseAt),
        chars: (event.text ?? "").length,
      };
    },
  };
};
