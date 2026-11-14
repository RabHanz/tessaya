/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * The desktop's side of §12.2's pipeline, by the specification's own names.
 *
 * The desktop owns the microphone, the HUD and where a finished utterance goes.
 * Everything between — wake, VAD, STT, the conversation window — is the voice
 * core's (`packages/tessaya-voice`, a parallel lane). `VoiceCore` below is the
 * whole of what the desktop needs from it, so the core can land behind it
 * without this side changing. D65.
 */

/** §12.3's modes, plus the two states a person needs to see on the HUD. */
export type VoiceState =
  | "sleeping"
  | "listening"
  | "command_window"
  | "conversation"
  | "direct_session"
  | "dictation"
  | "muted";

export const VOICE_STATES: ReadonlyArray<VoiceState> = [
  "sleeping",
  "listening",
  "command_window",
  "conversation",
  "direct_session",
  "dictation",
  "muted",
];

/** One OS input device, as Chromium's `enumerateDevices` reports it. */
export interface AudioInputDevice {
  readonly deviceId: string;
  readonly label: string;
  /** The system's default recording device, when the source says so. */
  readonly isDefault?: boolean;
}

/** 16 kHz mono signed 16-bit PCM — what every STT engine worth using takes. */
export const VOICE_SAMPLE_RATE = 16_000;
/** 20 ms frames: the size VAD engines (WebRTC, Silero) are built around. */
export const VOICE_FRAME_SAMPLES = 320;

export interface AudioInputProvider {
  readonly listDevices: () => Promise<ReadonlyArray<AudioInputDevice>>;
  /** Starts capture; `onFrame` receives VOICE_FRAME_SAMPLES-sample frames. */
  readonly start: (input: {
    readonly deviceId: string | null;
    readonly onFrame: (frame: Int16Array) => void;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** What the core hands back once it has words. */
export interface VoiceUtterance {
  readonly text: string;
  /** The mode the words were said in; it decides where they go. */
  readonly mode: Exclude<VoiceState, "sleeping" | "listening" | "muted">;
}

/** Why the core is being woken without a wake word. */
export type VoiceActivation = "wake" | "toggle_direct_session" | "toggle_mute" | "dismiss";

export interface VoiceCore {
  readonly pushAudio: (frame: Int16Array) => void;
  readonly activate: (activation: VoiceActivation) => void;
  readonly onState: (listener: (state: VoiceState) => void) => () => void;
  readonly onUtterance: (listener: (utterance: VoiceUtterance) => void) => () => void;
  readonly dispose: () => void;
}
