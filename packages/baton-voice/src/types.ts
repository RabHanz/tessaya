/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * §12.2's pluggable components, by the specification's own names.
 *
 * Structurally identical to the desktop's `voiceTypes.ts` (D65): the desktop
 * owns the microphone and passes 20 ms frames in; this package owns wake, VAD,
 * STT and the conversation window. Kept as plain interfaces so a provider can
 * be swapped (local ↔ cloud STT, openWakeWord ↔ another engine) without the
 * pipeline knowing.
 *
 * @module baton-voice/types
 */

/** 16 kHz mono signed 16-bit PCM. */
export const VOICE_SAMPLE_RATE = 16_000;
/** 20 ms frames, what the desktop's capture delivers. */
export const VOICE_FRAME_SAMPLES = 320;

/** §12.3's modes, plus what the HUD needs to show. */
export type VoiceState =
  | "sleeping"
  | "listening"
  | "command_window"
  | "conversation"
  | "direct_session"
  | "dictation"
  | "muted";

export interface AudioInputDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface AudioInputProvider {
  readonly listDevices: () => Promise<ReadonlyArray<AudioInputDevice>>;
  readonly start: (input: {
    readonly deviceId: string | null;
    readonly onFrame: (frame: Int16Array) => void;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** Streaming: called with every frame, answers whether the wake phrase just ended. */
export interface WakeProvider {
  readonly name: string;
  /** Returns the score when the phrase fired on this frame, else null. */
  readonly process: (frame: Int16Array) => number | null;
  readonly reset: () => void;
  /** The word behind the last fire, where the provider listens for several. */
  readonly lastWord?: () => string | null;
  /** Samples fed since the audio behind the last fire: a scorer behind the microphone reports a fire late. */
  readonly firedAgo?: () => number;
  /** Resolves once every frame fed so far has been scored. */
  readonly drain?: () => Promise<void>;
}

/** Streaming: is this frame speech? */
export interface VadProvider {
  readonly name: string;
  readonly isSpeech: (frame: Int16Array) => boolean;
  readonly reset: () => void;
  readonly drain?: () => Promise<void>;
  /**
   * What it has actually scored: speech samples so far, and quiet samples since the last speech. `isSpeech` repeats its
   * last answer for frames it has not scored yet (a burst after a stall); these only move when it has.
   */
  readonly scored?: () => { readonly speech: number; readonly quiet: number };
  /** Samples fed that it has not scored yet: how far behind the microphone its answer is. */
  readonly behind?: () => number;
  /** Its latest speech probability (0–1), for the turn log. */
  readonly probability?: () => number;
}

export interface SttProvider {
  readonly name: string;
  /** Whole-utterance transcription of 16 kHz mono PCM. */
  readonly transcribe: (pcm: Int16Array) => Promise<string>;
}

/** A transcript the recogniser's host set aside on purpose (another language): no "Didn't catch that". */
export const SET_ASIDE = "\u0000set aside";

export interface TtsProvider {
  readonly name: string;
  readonly speak: (text: string) => Promise<void>;
  /** Cut off whatever it is saying now. */
  readonly cancel?: () => void;
}

export type VoiceActivation = "wake" | "toggle_direct_session" | "toggle_mute" | "dismiss";

/** What the core hands the desktop once it has words. */
export interface VoiceUtterance {
  readonly text: string;
  readonly mode: Exclude<VoiceState, "sleeping" | "listening" | "muted">;
}

/** The seam the desktop's `makeCore` expects (apps/desktop voiceTypes.ts). */
export interface VoiceCore {
  readonly pushAudio: (frame: Int16Array) => void;
  readonly activate: (activation: VoiceActivation) => void;
  readonly onState: (listener: (state: VoiceState) => void) => () => void;
  readonly onUtterance: (listener: (utterance: VoiceUtterance) => void) => () => void;
  readonly dispose: () => void;
}
