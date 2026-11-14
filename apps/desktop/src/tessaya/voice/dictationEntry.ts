/**
 * What each way of moving a dictation does, whichever engine holds it: the voice core ("Tessaya, dictate", the tools)
 * or the native helper (the hold and hands-free keys, the dictation key, mouse buttons). Kept as one decision so the
 * two never run side by side and each can end the other.
 */
export type DictationEntry = "toggle" | "hold_down" | "hold_up" | "stop_tool" | "pill_click";

export interface DictationNow {
  /** The voice core is holding a dictation's words. */
  readonly voice: boolean;
  /** The helper is recording. */
  readonly keyRecording: boolean;
  /** That recording was started by a mouse button held down. */
  readonly heldByButton: boolean;
  /** His dictation is Tessaya's and its speech model is on disk. */
  readonly ready: boolean;
}

export type DictationStep =
  /** End the voice dictation and paste its words (its ✓). */
  | "voice_insert"
  /** The helper's own toggle: it starts, or ends its recording. */
  | "helper_toggle"
  | "helper_start"
  | "helper_finish"
  /** The first press is the opt-in: fetch the model. */
  | "fetch_model"
  | "none";

export const dictationStep = (entry: DictationEntry, now: DictationNow): DictationStep => {
  switch (entry) {
    case "toggle":
      return now.voice
        ? "voice_insert"
        : now.keyRecording || now.ready
          ? "helper_toggle"
          : "fetch_model";
    case "hold_down":
      return now.voice
        ? "voice_insert"
        : now.keyRecording
          ? "none"
          : now.ready
            ? "helper_start"
            : "fetch_model";
    case "hold_up":
      return now.keyRecording && now.heldByButton ? "helper_finish" : "none";
    case "stop_tool":
      return now.keyRecording ? "helper_finish" : now.voice ? "voice_insert" : "none";
    case "pill_click":
      return now.keyRecording ? "helper_finish" : "none";
  }
};

/**
 * A recording held to talk (the hold key, or a mouse button held down): its release is the ✓, so the pill shows no ✓
 * or ✕. The hands-free key, a latched hold and an older helper that does not say how it started keep them.
 */
export const heldToTalk = (via: string | undefined, heldByButton: boolean): boolean =>
  via === "hold" || heldByButton;
